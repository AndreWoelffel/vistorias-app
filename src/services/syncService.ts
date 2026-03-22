/**
 * Fila offline-first: retries com delay linear antes de cada tentativa (retries×1s, máx. 5s).
 */
import { supabase } from '@/services/supabaseClient';
import {
  getQueue,
  removeFromQueue,
  applyQueueFailure,
  getLeilaoById,
  updateLeilao,
  deleteVistoriasByLeilao,
  deleteLeilaoFromDb,
  setSyncQueueItemRetryPaused,
  type SyncQueueItem,
} from '@/lib/db';
import { syncLeilaoToCloud } from '@/services/leilaoService';
import { syncInspectionFromLocal, syncVistoriaUpdateToCloud } from '@/services/inspectionService';
import { logSyncConflict, supabaseTimestampToMs } from '@/services/syncConflict';

export const MAX_SYNC_RETRIES = 5;
/** Máximo de espera antes de reprocessar um item com falhas anteriores (ms). */
const RETRY_DELAY_CAP_MS = 5_000;

const MAX_ROUNDS = 12;

export type ProcessQueueResult = {
  processed: number;
  failed: number;
  skipped: boolean;
  rounds: number;
  /** Itens na fila com retries > 0 (próxima execução aplicará delay linear). */
  remainingInBackoff: number;
};

export type SyncLifecycleDetail = ProcessQueueResult & {
  remainingPending: number;
  remainingFailed: number;
};

type ItemResult = 'done' | 'fail' | 'skip' | 'cleared' | 'blocked';

const syncUiListeners = new Set<() => void>();
let queueProcessing = false;

export function subscribeSyncUi(cb: () => void): () => void {
  syncUiListeners.add(cb);
  return () => syncUiListeners.delete(cb);
}

function emitSyncUi() {
  syncUiListeners.forEach((cb) => {
    try {
      cb();
    } catch {
      /* ignore */
    }
  });
}

// --- Eventos de ciclo de vida (UX: toasts / analytics) ---

const syncStartListeners = new Set<() => void>();
const syncSuccessListeners = new Set<(detail: SyncLifecycleDetail) => void>();
const syncErrorListeners = new Set<(detail: SyncLifecycleDetail) => void>();

/** Disparado na primeira rodada em que há itens acionáveis na fila. */
export function onSyncStart(listener: () => void): () => void {
  syncStartListeners.add(listener);
  return () => syncStartListeners.delete(listener);
}

/** Disparado ao terminar o lote com `failed === 0` (houve trabalho na fila). */
export function onSyncSuccess(listener: (detail: SyncLifecycleDetail) => void): () => void {
  syncSuccessListeners.add(listener);
  return () => syncSuccessListeners.delete(listener);
}

/** Disparado ao terminar o lote com `failed > 0`. */
export function onSyncError(listener: (detail: SyncLifecycleDetail) => void): () => void {
  syncErrorListeners.add(listener);
  return () => syncErrorListeners.delete(listener);
}

function emitSyncStart() {
  syncStartListeners.forEach((cb) => {
    try {
      cb();
    } catch {
      /* ignore */
    }
  });
}

function emitSyncSuccess(detail: SyncLifecycleDetail) {
  syncSuccessListeners.forEach((cb) => {
    try {
      cb(detail);
    } catch {
      /* ignore */
    }
  });
}

function emitSyncError(detail: SyncLifecycleDetail) {
  syncErrorListeners.forEach((cb) => {
    try {
      cb(detail);
    } catch {
      /* ignore */
    }
  });
}

export function isSyncProcessing(): boolean {
  return queueProcessing;
}

/** Erro persistente na fila (`status: 'failed'` após esgotar retries, ou legado). */
export function isQueueItemPermanentFailure(item: SyncQueueItem): boolean {
  if (item.status === 'failed') return true;
  if (item.failed === true) return true;
  if ((item.retries ?? 0) >= MAX_SYNC_RETRIES) return true;
  return false;
}

function isActionableItem(item: SyncQueueItem, _now: number): boolean {
  if (isQueueItemPermanentFailure(item)) return false;
  if (item.retryPaused) return false;
  return true;
}

/** retries 1 → 1s, 2 → 2s, … até o teto (evita rajadas de requisições). */
function retryDelayBeforeAttemptMs(retries: number): number {
  return Math.min(RETRY_DELAY_CAP_MS, Math.max(0, retries) * 1000);
}

async function sleepLinearRetryDelay(retries: number): Promise<void> {
  const ms = retryDelayBeforeAttemptMs(retries);
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function getPendingSyncCount(): Promise<number> {
  const now = Date.now();
  const items = await getQueue();
  return items.filter((i) => isActionableItem(i, now)).length;
}

export async function getFailedSyncCount(): Promise<number> {
  const items = await getQueue();
  return items.filter((i) => isQueueItemPermanentFailure(i)).length;
}

/** Contagens separadas: ainda tentáveis vs falha permanente. */
export async function getSyncQueueCounts(): Promise<{ pending: number; failed: number }> {
  const now = Date.now();
  const items = await getQueue();
  return {
    pending: items.filter((i) => isActionableItem(i, now)).length,
    failed: items.filter((i) => isQueueItemPermanentFailure(i)).length,
  };
}

/** Menor = processar primeiro: delete (consistência/UX) → update → create. */
function syncTypePriority(t: SyncQueueItem['type']): number {
  switch (t) {
    case 'delete':
      return 0;
    case 'update':
      return 1;
    case 'create':
      return 2;
    default:
      return 2;
  }
}

function sortQueueItems(items: SyncQueueItem[]): SyncQueueItem[] {
  const entityOrder = (e: SyncQueueItem['entity']) => (e === 'leilao' ? 0 : 1);
  return [...items].sort((a, b) => {
    const pt = syncTypePriority(a.type) - syncTypePriority(b.type);
    if (pt !== 0) return pt;
    const pe = entityOrder(a.entity) - entityOrder(b.entity);
    if (pe !== 0) return pe;
    return a.createdAt - b.createdAt;
  });
}

function isForeignKeyViolation(error: { code?: string; message?: string }): boolean {
  if (error.code === '23503') return true;
  const m = (error.message ?? '').toLowerCase();
  return (
    m.includes('foreign key') ||
    m.includes('violates foreign key') ||
    m.includes('23503') ||
    m.includes('still referenced')
  );
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e ?? 'erro desconhecido');
}

async function recordFailure(itemId: number, err?: unknown): Promise<void> {
  const { permanentFailure, retries } = await applyQueueFailure(itemId, {
    maxRetries: MAX_SYNC_RETRIES,
    errorMessage: formatErr(err),
  });
  if (permanentFailure) {
    console.error('[sync] Erro detalhado:', err != null ? err : `Fila: status "failed" (id=${itemId}, retries=${retries})`);
  }
}

async function processOneItem(item: SyncQueueItem): Promise<ItemResult> {
  if (item.id == null) return 'done';

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return 'skip';
  }

  if (item.entity === 'leilao') {
    const payload = item.payload as { localId?: number };
    const localId = payload.localId;
    if (localId == null || !Number.isFinite(localId)) {
      return 'done';
    }

    if (item.type === 'create') {
      const leilao = await getLeilaoById(localId);
      if (!leilao || leilao.deleted) return 'done';
      if (leilao.supabaseId != null) return 'done';
      const r = await syncLeilaoToCloud(localId);
      /** `syncLeilaoToCloud` já remove entradas `create` da fila para este localId */
      return r.ok ? 'cleared' : 'fail';
    }

    if (item.type === 'update') {
      const leilao = await getLeilaoById(localId);
      if (!leilao || leilao.deleted) return 'done';
      if (leilao.supabaseId == null) return 'skip';

      const { data: serverRow, error: fetchErr } = await supabase
        .from('leiloes')
        .select('updated_at, nome')
        .eq('id', leilao.supabaseId)
        .maybeSingle();

      if (fetchErr) {
        console.error('[sync] Erro detalhado:', fetchErr);
        return 'fail';
      }

      const serverMs = supabaseTimestampToMs(
        (serverRow as { updated_at?: string | null } | null)?.updated_at,
      );
      const localMs =
        leilao.updatedAt ?? (leilao.createdAt ? new Date(leilao.createdAt).getTime() : 0);

      if (serverRow && serverMs !== localMs) {
        logSyncConflict({
          entity: 'leilao',
          localId,
          supabaseId: leilao.supabaseId,
          serverMs,
          localMs,
          resolucao: serverMs > localMs ? 'servidor (sobrescreve local)' : 'local (envia update)',
        });
      }

      if (serverMs > localMs) {
        const nomeSrv = String((serverRow as { nome?: string } | null)?.nome ?? '').trim();
        await updateLeilao(localId, {
          nome: nomeSrv || leilao.nome,
          updatedAt: serverMs,
        });
        return 'done';
      }

      if (serverMs === localMs && serverRow) {
        const nomeSrv = String((serverRow as { nome?: string }).nome ?? '').trim();
        if (nomeSrv === leilao.nome.trim()) {
          await updateLeilao(localId, { updatedAt: serverMs });
          return 'done';
        }
        logSyncConflict({
          entity: 'leilao',
          localId,
          supabaseId: leilao.supabaseId,
          serverMs,
          localMs,
          resolucao: 'empate de timestamp; conteúdo difere — prioriza local (update)',
        });
      }

      const { data: after, error } = await supabase
        .from('leiloes')
        .update({ nome: leilao.nome.trim() })
        .eq('id', leilao.supabaseId)
        .select('updated_at')
        .maybeSingle();

      if (error) {
        console.error('[sync] Erro detalhado:', error);
        return 'fail';
      }

      const newMs = supabaseTimestampToMs((after as { updated_at?: string | null } | null)?.updated_at);
      await updateLeilao(localId, {
        updatedAt: newMs > 0 ? newMs : Date.now(),
      });
      return 'done';
    }

    if (item.type === 'delete') {
      const leilao = await getLeilaoById(localId);
      if (!leilao) return 'done';
      if (leilao.supabaseId == null) return 'done';
      if (leilao.deleteBlocked) {
        return 'skip';
      }
      const { error } = await supabase.from('leiloes').delete().eq('id', leilao.supabaseId);
      if (error) {
        console.error('[sync] Erro detalhado:', error);
        if (isForeignKeyViolation(error)) {
          await updateLeilao(localId, {
            deleted: false,
            deleteBlocked: true,
          });
          if (item.id != null) {
            await setSyncQueueItemRetryPaused(item.id, true);
          }
          if (import.meta.env.DEV) {
            console.warn(
              "[sync] Exclusão na nuvem bloqueada (FK): vistorias ainda referenciam o leilão. Fila pausada; deleteBlocked=true.",
            );
          }
          return 'blocked';
        }
        return 'fail';
      }
      await deleteVistoriasByLeilao(localId);
      await deleteLeilaoFromDb(localId);
      return 'done';
    }
  }

  if (item.entity === 'vistoria' && item.type === 'create') {
    const payload = item.payload as { localVistoriaId?: number };
    const vid = payload.localVistoriaId;
    if (vid == null || !Number.isFinite(vid)) return 'done';
    const ok = await syncInspectionFromLocal(vid);
    return ok ? 'done' : 'fail';
  }

  if (item.entity === 'vistoria' && item.type === 'update') {
    const payload = item.payload as { localVistoriaId?: number };
    const vid = payload.localVistoriaId;
    if (vid == null || !Number.isFinite(vid)) return 'done';
    const ok = await syncVistoriaUpdateToCloud(vid);
    return ok ? 'done' : 'fail';
  }

  if (import.meta.env.DEV) console.warn("[sync] Item de fila não reconhecido:", item);
  return "done";
}

/**
 * Processa a fila em várias rodadas (ex.: criar leilão antes da vistoria).
 */
export async function processQueue(): Promise<ProcessQueueResult> {
  const t0 = Date.now();

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const q = await getQueue();
    const now = Date.now();
    const remainingInBackoff = q.filter(
      (i) =>
        !isQueueItemPermanentFailure(i) &&
        (i.retries ?? 0) > 0 &&
        (i.retries ?? 0) < MAX_SYNC_RETRIES,
    ).length;
    if (import.meta.env.DEV) {
      console.log("[sync] processQueue resumo", {
        durationMs: Date.now() - t0,
        offline: true,
        processed: 0,
        failed: 0,
        rounds: 0,
        remainingInBackoff,
        remainingActionable: q.filter((i) => isActionableItem(i, now)).length,
        remainingFailed: q.filter((i) => isQueueItemPermanentFailure(i)).length,
        totalInQueue: q.length,
      });
      console.log("[sync] Processados:", 0);
      console.log("[sync] Falhas:", 0);
    }
    return { processed: 0, failed: 0, skipped: true, rounds: 0, remainingInBackoff };
  }

  if (queueProcessing) {
    if (import.meta.env.DEV) {
      console.log("[sync] processQueue resumo", {
        durationMs: Date.now() - t0,
        skippedAlreadyRunning: true,
      });
      console.log("[sync] Processados:", 0);
      console.log("[sync] Falhas:", 0);
    }
    return { processed: 0, failed: 0, skipped: true, rounds: 0, remainingInBackoff: 0 };
  }

  queueProcessing = true;
  emitSyncUi();

  let processed = 0;
  let failed = 0;
  let rounds = 0;
  let hadSyncWork = false;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const raw = await getQueue();
      const now = Date.now();
      const pending = sortQueueItems(raw.filter((i) => isActionableItem(i, now)));
      if (pending.length === 0) break;

      if (!hadSyncWork) {
        hadSyncWork = true;
        emitSyncStart();
      }

      rounds++;
      let progressed = false;

      for (const item of pending) {
        if (item.id == null) continue;

        if (typeof navigator !== "undefined" && !navigator.onLine) {
          if (import.meta.env.DEV) {
            console.warn("[sync] offline durante processQueue; encerrando lote (retoma ao voltar online).");
          }
          break;
        }

        await sleepLinearRetryDelay(item.retries ?? 0);

        if (typeof navigator !== "undefined" && !navigator.onLine) {
          if (import.meta.env.DEV) {
            console.warn("[sync] offline após delay de retry; encerrando lote.");
          }
          break;
        }

        if (import.meta.env.DEV) console.log("[sync] Processando:", item);

        try {
          const result = await processOneItem(item);
          if (result === 'done') {
            await removeFromQueue(item.id);
            processed++;
            progressed = true;
          } else if (result === 'cleared') {
            processed++;
            progressed = true;
          } else if (result === 'blocked') {
            progressed = true;
          } else if (result === 'skip') {
            /* aguarda outra rodada */
          } else {
            await recordFailure(item.id);
            failed++;
            progressed = true;
          }
        } catch (e) {
          console.error("[sync] Erro detalhado:", e);
          if (import.meta.env.DEV) console.log("[sync] Item com exceção:", item);
          await recordFailure(item.id, e);
          failed++;
          progressed = true;
        }
      }

      if (!progressed) break;
    }
  } finally {
    queueProcessing = false;
    emitSyncUi();
  }

  const queueSnapshot = await getQueue();
  const nowEnd = Date.now();
  const remainingActionable = queueSnapshot.filter((i) => isActionableItem(i, nowEnd)).length;
  const remainingFailed = queueSnapshot.filter((i) => isQueueItemPermanentFailure(i)).length;
  const remainingInBackoff = queueSnapshot.filter(
    (i) =>
      !isQueueItemPermanentFailure(i) &&
      (i.retries ?? 0) > 0 &&
      (i.retries ?? 0) < MAX_SYNC_RETRIES,
  ).length;

  if (import.meta.env.DEV) {
    console.log("[sync] processQueue resumo", {
      durationMs: Date.now() - t0,
      successRemovals: processed,
      failureEvents: failed,
      rounds,
      remainingInBackoff,
      remainingActionable,
      remainingFailed,
      totalInQueue: queueSnapshot.length,
    });
    console.log("[sync] Processados:", processed);
    console.log("[sync] Falhas:", failed);
  }

  const lifecycleDetail: SyncLifecycleDetail = {
    processed,
    failed,
    skipped: false,
    rounds,
    remainingInBackoff,
    remainingPending: remainingActionable,
    remainingFailed,
  };

  if (hadSyncWork) {
    if (failed > 0) emitSyncError(lifecycleDetail);
    else emitSyncSuccess(lifecycleDetail);
  }

  return { processed, failed, skipped: false, rounds, remainingInBackoff };
}
