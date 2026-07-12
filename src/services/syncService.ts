/**
 * Fila offline-first: retries com delay linear antes de cada tentativa (retries×1s, máx. 5s).
 */
import { supabase } from '@/services/supabaseClient';
import {
  getQueue,
  removeFromQueue,
  applyQueueFailure,
  getLeilaoById,
  getVistoriaById,
  updateLeilao,
  updateVistoria,
  deleteVistoria,
  deleteVistoriasByLeilao,
  deleteLeilaoFromDb,
  setSyncQueueItemRetryPaused,
  normalizeVistoriaStatusSync,
  addToQueue,
  removeVistoriaQueueItems,
  ensureVistoriaLocalUuidIsUuid,
  type SyncQueueItem,
} from '@/lib/db';
import { syncLeilaoToCloud } from '@/services/leilaoService';
import { syncInspectionFromLocal, syncVistoriaUpdateToCloud } from '@/services/inspectionService';
import { deleteVistoriaFotosBeforeVistoriaDelete } from '@/services/vistoriaFotoService';
import { logSyncConflict, supabaseTimestampToMs } from '@/services/syncConflict';
import { normalizeTipoLaudo } from '@/lib/tipoLaudo';

export const MAX_SYNC_RETRIES = 5;
/** Máximo de espera antes de reprocessar um item com falhas anteriores (ms). */
const RETRY_DELAY_CAP_MS = 5_000;

const MAX_ROUNDS = 12;

export type ProcessQueueResult = {
  processed: number;
  failed: number;
  skipped: boolean;
  rounds: number;
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
    try { cb(); } catch { /* ignore */ }
  });
}

const syncStartListeners = new Set<() => void>();
const syncSuccessListeners = new Set<(detail: SyncLifecycleDetail) => void>();
const syncErrorListeners = new Set<(detail: SyncLifecycleDetail) => void>();

export function onSyncStart(listener: () => void): () => void {
  syncStartListeners.add(listener);
  return () => syncStartListeners.delete(listener);
}

export function onSyncSuccess(listener: (detail: SyncLifecycleDetail) => void): () => void {
  syncSuccessListeners.add(listener);
  return () => syncSuccessListeners.delete(listener);
}

export function onSyncError(listener: (detail: SyncLifecycleDetail) => void): () => void {
  syncErrorListeners.add(listener);
  return () => syncErrorListeners.delete(listener);
}

function emitSyncStart() {
  syncStartListeners.forEach((cb) => { try { cb(); } catch { /* ignore */ } });
}

function emitSyncSuccess(detail: SyncLifecycleDetail) {
  syncSuccessListeners.forEach((cb) => { try { cb(detail); } catch { /* ignore */ } });
}

function emitSyncError(detail: SyncLifecycleDetail) {
  syncErrorListeners.forEach((cb) => { try { cb(detail); } catch { /* ignore */ } });
}

export function isSyncProcessing(): boolean {
  return queueProcessing;
}

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

function retryDelayBeforeAttemptMs(retries: number): number {
  return Math.min(RETRY_DELAY_CAP_MS, Math.max(0, retries) * 1000);
}

async function sleepLinearRetryDelay(retries: number): Promise<void> {
  const ms = retryDelayBeforeAttemptMs(retries);
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function getSyncQueueCounts(): Promise<{ pending: number; failed: number }> {
  const now = Date.now();
  const items = await getQueue();
  return {
    pending: items.filter((i) => isActionableItem(i, now)).length,
    failed: items.filter((i) => isQueueItemPermanentFailure(i)).length,
  };
}

function syncTypePriority(t: SyncQueueItem['type']): number {
  switch (t) {
    case 'delete': return 0;
    case 'update': return 1;
    case 'create': return 2;
    default: return 2;
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

async function recordFailure(itemId: number, err?: unknown): Promise<{ permanentFailure: boolean }> {
  const { permanentFailure, retries } = await applyQueueFailure(itemId, {
    maxRetries: MAX_SYNC_RETRIES,
    errorMessage: formatErr(err),
  });
  if (permanentFailure && import.meta.env.DEV) {
    console.warn('[sync] Fila em falha permanente:', err != null ? err : `id=${itemId}, retries=${retries}`);
  }
  return { permanentFailure };
}

async function markVistoriaErroSyncIfPermanent(
  item: SyncQueueItem,
  permanentFailure: boolean,
  err?: unknown,
): Promise<void> {
  if (!permanentFailure || item.entity !== 'vistoria') return;
  const p = item.payload as { localVistoriaId?: number };
  const vid = p.localVistoriaId;
  if (vid == null || !Number.isFinite(vid)) return;
  try {
    if (item.type === 'delete') {
      await updateVistoria(vid, {
        pendingCloudDelete: false,
        statusSync: 'erro_sync',
        syncMessage: formatErr(err).slice(0, 240),
      });
      return;
    }
    await updateVistoria(vid, {
      statusSync: 'erro_sync',
      syncMessage: formatErr(err).slice(0, 240),
    });
  } catch {
    /* ignore */
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
    if (localId == null || !Number.isFinite(localId)) return 'done';

    if (item.type === 'create') {
      const leilao = await getLeilaoById(localId);
      if (!leilao || leilao.deleted) return 'done';
      if (leilao.supabaseId != null) return 'done';
      const r = await syncLeilaoToCloud(localId);
      return r.ok ? 'cleared' : 'fail';
    }

    if (item.type === 'update') {
      const leilao = await getLeilaoById(localId);
      if (!leilao || leilao.deleted) return 'done';
      
      // MÁGICA DO ARQUITETO 1: Barreira contra o fantasma do NaN no banco local
      if (leilao.supabaseId == null || Number.isNaN(leilao.supabaseId)) return 'skip';

      const { data: serverRow, error: fetchErr } = await supabase
        .from('leiloes')
        .select('updated_at, nome, tipo_laudo')
        .eq('id', leilao.supabaseId)
        .maybeSingle();

      if (fetchErr) return 'fail';

      const serverMs = supabaseTimestampToMs((serverRow as { updated_at?: string | null } | null)?.updated_at);
      const localMs = leilao.updatedAt ?? (leilao.createdAt ? new Date(leilao.createdAt).getTime() : 0);
      const localTipo = normalizeTipoLaudo(leilao.tipoLaudo);
      const serverTipo = normalizeTipoLaudo(
        (serverRow as { tipo_laudo?: unknown } | null)?.tipo_laudo,
      );

      if (serverRow && serverMs !== localMs) {
        logSyncConflict({
          entity: 'leilao', localId, supabaseId: leilao.supabaseId, serverMs, localMs,
          resolucao: serverMs > localMs ? 'servidor' : 'local',
        });
      }

      if (serverMs > localMs) {
        const nomeSrv = String((serverRow as { nome?: string } | null)?.nome ?? '').trim();
        await updateLeilao(localId, {
          nome: nomeSrv || leilao.nome,
          tipoLaudo: serverTipo,
          updatedAt: serverMs,
        });
        return 'done';
      }

      if (serverMs === localMs && serverRow) {
        const nomeSrv = String((serverRow as { nome?: string }).nome ?? '').trim();
        if (nomeSrv === leilao.nome.trim() && serverTipo === localTipo) {
          await updateLeilao(localId, { updatedAt: serverMs, tipoLaudo: serverTipo });
          return 'done';
        }
      }

      const { data: after, error } = await supabase
        .from('leiloes')
        .update({ nome: leilao.nome.trim(), tipo_laudo: localTipo })
        .eq('id', leilao.supabaseId)
        .select('updated_at')
        .maybeSingle();
      if (error) return 'fail';

      const newMs = supabaseTimestampToMs((after as { updated_at?: string | null } | null)?.updated_at);
      await updateLeilao(localId, { updatedAt: newMs > 0 ? newMs : Date.now() });
      return 'done';
    }

    if (item.type === 'delete') {
      const leilao = await getLeilaoById(localId);
      
      // MÁGICA DO ARQUITETO 2: Impede o envio de um ID inválido para deleção na nuvem
      if (!leilao || leilao.supabaseId == null || Number.isNaN(leilao.supabaseId)) return 'done';
      if (leilao.deleteBlocked) return 'skip';
      
      const { error } = await supabase.from('leiloes').delete().eq('id', leilao.supabaseId);
      if (error) {
        if (isForeignKeyViolation(error)) {
          await updateLeilao(localId, { deleted: false, deleteBlocked: true });
          if (item.id != null) await setSyncQueueItemRetryPaused(item.id, true);
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
    const r = await syncInspectionFromLocal(vid);
    if (r === 'duplicate') {
      if (item.id != null) await setSyncQueueItemRetryPaused(item.id, true);
      return 'blocked';
    }
    return r === 'ok' ? 'done' : 'fail';
  }

  if (item.entity === 'vistoria' && item.type === 'update') {
    const payload = item.payload as { localVistoriaId?: number };
    const vid = payload.localVistoriaId;
    if (vid == null || !Number.isFinite(vid)) return 'done';
    const v0 = await getVistoriaById(vid);
    const n0 = normalizeVistoriaStatusSync(v0?.statusSync);
    if (n0 === 'aguardando_ajuste' || n0 === 'conflito_duplicidade') {
      if (item.id != null) await setSyncQueueItemRetryPaused(item.id, true);
      return 'blocked';
    }
    const ok = await syncVistoriaUpdateToCloud(vid);
    if (ok) return 'done';
    const v1 = await getVistoriaById(vid);
    const n1 = normalizeVistoriaStatusSync(v1?.statusSync);
    if (n1 === 'conflito_duplicidade' || n1 === 'aguardando_ajuste') {
      if (item.id != null) await setSyncQueueItemRetryPaused(item.id, true);
      return 'blocked';
    }
    return 'fail';
  }

  if (item.entity === 'vistoria' && item.type === 'delete') {
    const payload = item.payload as { localVistoriaId?: number };
    const vid = payload.localVistoriaId;
    if (vid == null || !Number.isFinite(vid)) return 'done';
    const v = await getVistoriaById(vid);
    if (!v) return 'done';
    if (!v.pendingCloudDelete) return 'done';
    
    const cloudId = v.cloudVistoriaId?.trim();
    const leilaoId = v.leilaoId;
    if (!cloudId) {
      await deleteVistoria(vid);
      if (leilaoId != null && Number.isFinite(leilaoId)) {
        const { recalculateDuplicateVistoriasForLeilao } = await import('@/services/duplicateVistoriaRecalc');
        await recalculateDuplicateVistoriasForLeilao(leilaoId);
      }
      return 'done';
    }
    const fotosOk = await deleteVistoriaFotosBeforeVistoriaDelete(cloudId);
    if (!fotosOk) return 'fail';
    const { error } = await supabase.from('vistorias').delete().eq('id', cloudId);
    if (error) return 'fail';
    await deleteVistoria(vid);
    if (leilaoId != null && Number.isFinite(leilaoId)) {
      const { recalculateDuplicateVistoriasForLeilao } = await import('@/services/duplicateVistoriaRecalc');
      await recalculateDuplicateVistoriasForLeilao(leilaoId);
    }
    return 'done';
  }

  return "done";
}

export async function processQueue(): Promise<ProcessQueueResult> {
  const t0 = Date.now();

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const q = await getQueue();
    const remainingInBackoff = q.filter(
      (i) => !isQueueItemPermanentFailure(i) && (i.retries ?? 0) > 0 && (i.retries ?? 0) < MAX_SYNC_RETRIES,
    ).length;
    return { processed: 0, failed: 0, skipped: true, rounds: 0, remainingInBackoff };
  }

  if (queueProcessing) {
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

        if (typeof navigator !== "undefined" && !navigator.onLine) break;

        await sleepLinearRetryDelay(item.retries ?? 0);

        if (typeof navigator !== "undefined" && !navigator.onLine) break;

        try {
          const result = await processOneItem(item);
          if (result === 'done' || result === 'cleared') {
            if (result === 'done') await removeFromQueue(item.id);
            processed++;
            progressed = true;
          } else if (result === 'blocked') {
            progressed = true;
          } else if (result === 'skip') {
            // No-op
          } else {
            const { permanentFailure } = await recordFailure(item.id);
            await markVistoriaErroSyncIfPermanent(item, permanentFailure);
            failed++;
            progressed = true;
          }
        } catch (e) {
          const { permanentFailure } = await recordFailure(item.id, e);
          await markVistoriaErroSyncIfPermanent(item, permanentFailure, e);
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
    (i) => !isQueueItemPermanentFailure(i) && (i.retries ?? 0) > 0 && (i.retries ?? 0) < MAX_SYNC_RETRIES,
  ).length;

  const lifecycleDetail: SyncLifecycleDetail = {
    processed, failed, skipped: false, rounds, remainingInBackoff, remainingPending: remainingActionable, remainingFailed,
  };

  if (hadSyncWork) {
    if (failed > 0) emitSyncError(lifecycleDetail);
    else emitSyncSuccess(lifecycleDetail);
  }

  return { processed, failed, skipped: false, rounds, remainingInBackoff };
}

export type SyncLeilaoFromCloudResult =
  | { ok: true; rowCount: number; removedLocal: number }
  | { ok: false; offline?: boolean; message?: string };

/** Envia fila, reenvia fotos e puxa vistorias do servidor para o leilão local. */
export async function syncLeilaoFromCloud(localLeilaoId: number): Promise<SyncLeilaoFromCloudResult> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: false, offline: true };
  }
  try {
    await processQueue();
    const { fetchAndMergeVistoriasFromCloudForLeilao, resyncAllFotosForLeilao } = await import(
      '@/services/inspectionService',
    );
    await resyncAllFotosForLeilao(localLeilaoId);
    const merged = await fetchAndMergeVistoriasFromCloudForLeilao(localLeilaoId);
    if (!merged.ok) {
      return { ok: false, message: 'Não foi possível buscar os dados do servidor.' };
    }
    return { ok: true, rowCount: merged.rowCount, removedLocal: merged.removedLocal };
  } catch {
    return { ok: false, message: 'Erro de sincronização.' };
  }
}

export type EnqueueVistoriaResyncResult =
  | { ok: true }
  | { ok: false; blocked: true; message: string }
  | { ok: false; message: string };

export async function enqueueVistoriaResync(localVistoriaId: number): Promise<EnqueueVistoriaResyncResult> {
  let v = await getVistoriaById(localVistoriaId);
  if (!v) return { ok: false, message: 'Vistoria não encontrada.' };
  
  v = await ensureVistoriaLocalUuidIsUuid(v);
  const ns = normalizeVistoriaStatusSync(v.statusSync);
  
  if (ns === 'aguardando_ajuste' || ns === 'conflito_duplicidade') {
    return { ok: false, blocked: true, message: 'Corrija placa ou número antes de sincronizar.' };
  }
  if (v.pendingCloudDelete) {
    return { ok: false, message: 'Esta vistoria está marcada para exclusão.' };
  }
  if (ns !== 'erro_sync' && ns !== 'pendente_sync') {
    return { ok: false, message: 'Não há reenvio pendente para este status.' };
  }

  await removeVistoriaQueueItems(localVistoriaId);
  await updateVistoria(localVistoriaId, { statusSync: 'pendente_sync', syncMessage: undefined });
  
  const hasCloud = Boolean(v.cloudVistoriaId?.trim());
  await addToQueue({ type: hasCloud ? 'update' : 'create', entity: 'vistoria', payload: { localVistoriaId } });

  void processQueue();
  return { ok: true };
}

/** Reenvio manual a partir do hub — fila e/ou fotos, sem bloquear a UI. */
export async function retryVistoriaFromHub(
  localVistoriaId: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const v = await getVistoriaById(localVistoriaId);
  if (!v) return { ok: false, message: 'Vistoria não encontrada.' };

  const ns = normalizeVistoriaStatusSync(v.statusSync);

  if (ns === 'aguardando_ajuste' || ns === 'conflito_duplicidade') {
    return { ok: false, message: 'Corrija placa ou número antes de sincronizar.' };
  }

  if (v.fotoUploadFailed && v.cloudVistoriaId?.trim()) {
    const { retryVistoriaFotoUpload } = await import('@/services/inspectionService');
    const fotosOk = await retryVistoriaFotoUpload(localVistoriaId);
    if (!fotosOk) return { ok: false, message: 'Não foi possível reenviar as fotos.' };
    if (ns === 'sincronizado') return { ok: true };
  }

  if (ns === 'erro_sync' || ns === 'pendente_sync' || v.fotoUploadFailed) {
    const r = await enqueueVistoriaResync(localVistoriaId);
    if (!r.ok) return { ok: false, message: r.message ?? 'Não foi possível reenviar.' };
    return { ok: true };
  }

  return { ok: false, message: 'Não há reenvio pendente para esta vistoria.' };
}