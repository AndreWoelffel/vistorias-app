/**
 * Supabase Realtime → IndexedDB + notificação à UI.
 *
 * No dashboard Supabase: Database → Replication → habilitar `leiloes` e `vistorias`
 * (publication `supabase_realtime`), ou via SQL:
 *   alter publication supabase_realtime add table public.leiloes;
 *   alter publication supabase_realtime add table public.vistorias;
 */
import { supabase } from '@/services/supabaseClient';
import { supabaseTimestampToMs } from '@/services/syncConflict';
import {
  addVistoria,
  deleteLeilaoFromDb,
  deleteVistoria,
  deleteVistoriasByLeilao,
  getAllLeiloes,
  mergeLeilaoFromCloud,
  removeQueueItemsForLeilao,
  resolveLocalLeilaoIdForCloudFk,
  findVistoriaIdByCloudId,
  findVistoriaIdByExternalId,
  updateVistoria,
  removeVistoriaQueueItems,
  type Leilao,
  type Vistoria,
} from '@/lib/db';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';

const realtimeUiListeners = new Set<() => void>();

export function subscribeRealtimeUi(cb: () => void): () => void {
  realtimeUiListeners.add(cb);
  return () => realtimeUiListeners.delete(cb);
}

function emitRealtimeUi() {
  realtimeUiListeners.forEach((cb) => {
    try {
      cb();
    } catch {
      /* ignore */
    }
  });
}

function mapRecordToLeilaoForMerge(rec: Record<string, unknown>): Leilao & { id: number } {
  const id = Number(rec.id);
  const updatedAt =
    rec.updated_at != null ? supabaseTimestampToMs(String(rec.updated_at)) : undefined;
  return {
    id,
    nome: String(rec.nome ?? '').trim() || '(sem nome)',
    supabaseId: id,
    createdAt: rec.created_at ? new Date(String(rec.created_at)) : new Date(),
    updatedAt: updatedAt !== undefined && updatedAt > 0 ? updatedAt : undefined,
    createdBy: rec.created_by != null ? String(rec.created_by) : null,
  };
}

async function applyLeilaoDelete(oldRow: Record<string, unknown>): Promise<void> {
  const sid = Number(oldRow.id);
  if (!Number.isFinite(sid)) return;
  const all = await getAllLeiloes();
  const local = all.find((l) => l.supabaseId === sid || l.id === sid);
  if (local?.id == null) return;
  await removeQueueItemsForLeilao(local.id);
  await deleteVistoriasByLeilao(local.id);
  await deleteLeilaoFromDb(local.id);
}

async function patchVistoriaFromCloudRow(localId: number, row: Record<string, unknown>): Promise<void> {
  const cloudLeilaoFk = Number(row.leilao);
  const localLeilaoId = Number.isFinite(cloudLeilaoFk)
    ? await resolveLocalLeilaoIdForCloudFk(cloudLeilaoFk)
    : undefined;

  const externalId = row.external_id != null ? String(row.external_id).trim() : '';
  const patch: Partial<Omit<Vistoria, 'id'>> = {
    placa: String(row.placa ?? ''),
    numeroVistoria: String(row.num_vistoria ?? ''),
    vistoriador: String(row.vistoriador ?? ''),
    statusSync: 'sincronizado',
    createdBy: row.created_by != null ? String(row.created_by) : null,
    updatedAt:
      row.updated_at != null ? supabaseTimestampToMs(String(row.updated_at)) : undefined,
    cloudVistoriaId: row.id != null ? String(row.id) : undefined,
    localUuid: externalId || undefined,
    syncMessage: undefined,
    duplicateType: undefined,
    duplicateInfo: undefined,
    pendingCloudDelete: false,
  };
  if (localLeilaoId != null) patch.leilaoId = localLeilaoId;

  await updateVistoria(localId, patch);
}

async function applyVistoriaInsert(row: Record<string, unknown>): Promise<void> {
  const cloudLeilaoFk = Number(row.leilao);
  const localLeilaoId = await resolveLocalLeilaoIdForCloudFk(cloudLeilaoFk);
  if (localLeilaoId == null) {
    if (import.meta.env.DEV) {
      console.warn("[realtime] Vistoria INSERT: leilão local não encontrado para FK", cloudLeilaoFk);
    }
    return;
  }

  const externalId = row.external_id != null ? String(row.external_id).trim() : "";
  if (!externalId) {
    if (import.meta.env.DEV) {
      console.warn("[realtime] Vistoria INSERT sem external_id; ignorando.", row);
    }
    return;
  }

  const existingId = await findVistoriaIdByExternalId(externalId);
  if (existingId != null) {
    await patchVistoriaFromCloudRow(existingId, row);
    return;
  }

  await addVistoria({
    leilaoId: localLeilaoId,
    placa: String(row.placa ?? ''),
    numeroVistoria: String(row.num_vistoria ?? ''),
    vistoriador: String(row.vistoriador ?? ''),
    fotos: [],
    statusSync: 'sincronizado',
    createdAt: row.created_at ? new Date(String(row.created_at)) : new Date(),
    localUuid: externalId,
    cloudVistoriaId: row.id != null ? String(row.id) : undefined,
    createdBy: row.created_by != null ? String(row.created_by) : null,
    updatedAt:
      row.updated_at != null ? supabaseTimestampToMs(String(row.updated_at)) : undefined,
  });
}

async function applyVistoriaUpdate(row: Record<string, unknown>): Promise<void> {
  const externalId = row.external_id != null ? String(row.external_id).trim() : '';
  let localId: number | undefined;
  if (externalId) localId = await findVistoriaIdByExternalId(externalId);
  if (localId == null && row.id != null) {
    localId = await findVistoriaIdByCloudId(String(row.id));
  }
  if (localId == null) {
    await applyVistoriaInsert(row);
    return;
  }
  await patchVistoriaFromCloudRow(localId, row);
}

async function applyVistoriaDelete(oldRow: Record<string, unknown>): Promise<void> {
  let localId: number | undefined;
  if (oldRow.external_id != null) {
    localId = await findVistoriaIdByExternalId(String(oldRow.external_id));
  }
  if (localId == null && oldRow.id != null) {
    localId = await findVistoriaIdByCloudId(String(oldRow.id));
  }
  if (localId != null) {
    await deleteVistoria(localId);
    await removeVistoriaQueueItems(localId);
  }
}

async function handleLeiloesChange(payload: RealtimePostgresChangesPayload<Record<string, unknown>>) {
  if (import.meta.env.DEV) console.log("Realtime leilao:", payload);
  try {
    if (payload.eventType === 'DELETE') {
      const old = payload.old as Record<string, unknown> | null;
      if (old?.id != null) await applyLeilaoDelete(old);
    } else if (payload.new) {
      await mergeLeilaoFromCloud(mapRecordToLeilaoForMerge(payload.new as Record<string, unknown>));
    }
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[realtime] Falha ao aplicar evento leiloes:", e);
  } finally {
    emitRealtimeUi();
  }
}

async function handleVistoriasChange(payload: RealtimePostgresChangesPayload<Record<string, unknown>>) {
  if (import.meta.env.DEV) console.log("Realtime vistoria:", payload);
  try {
    if (payload.eventType === 'DELETE') {
      const old = payload.old as Record<string, unknown> | null;
      if (old) await applyVistoriaDelete(old);
    } else if (payload.eventType === 'INSERT' && payload.new) {
      await applyVistoriaInsert(payload.new as Record<string, unknown>);
    } else if (payload.eventType === 'UPDATE' && payload.new) {
      await applyVistoriaUpdate(payload.new as Record<string, unknown>);
    }
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[realtime] Falha ao aplicar evento vistorias:", e);
  } finally {
    emitRealtimeUi();
  }
}

const channels: RealtimeChannel[] = [];
let started = false;

function logSubscribeStatus(table: string, status: string, err?: Error) {
  if (status === "SUBSCRIBED") {
    if (import.meta.env.DEV) console.log(`[realtime] Inscrito: ${table}`);
  } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
    if (import.meta.env.DEV) console.warn(`[realtime] Canal ${table}:`, status, err);
  }
}

export function isRealtimeStarted(): boolean {
  return started;
}

/** Dois canais: `leiloes` e `vistorias` (postgres_changes em public.*). */
export function ensureRealtimeStarted(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  const chLeiloes = supabase
    .channel('leiloes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'leiloes' },
      (payload) => {
        void handleLeiloesChange(payload as RealtimePostgresChangesPayload<Record<string, unknown>>);
      },
    )
    .subscribe((status, err) => logSubscribeStatus('leiloes', status, err));
  channels.push(chLeiloes);

  const chVistorias = supabase
    .channel('vistorias')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'vistorias' },
      (payload) => {
        void handleVistoriasChange(payload as RealtimePostgresChangesPayload<Record<string, unknown>>);
      },
    )
    .subscribe((status, err) => logSubscribeStatus('vistorias', status, err));
  channels.push(chVistorias);
}

export function stopRealtimeSync(): void {
  for (const ch of channels) {
    void supabase.removeChannel(ch);
  }
  channels.length = 0;
  started = false;
}
