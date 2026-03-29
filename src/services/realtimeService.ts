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
  deleteLeilaoFromDb,
  deleteVistoriasByLeilao,
  getAllLeiloes,
  mergeLeilaoFromCloud,
  removeQueueItemsForLeilao,
  type Leilao,
} from '@/lib/db';
import {
  applyVistoriaDelete,
  applyVistoriaInsert,
  applyVistoriaUpdate,
} from '@/services/vistoriaCloudMerge';
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
