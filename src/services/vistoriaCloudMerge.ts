/**
 * Mescla linhas de public.vistorias no IndexedDB (Realtime + pull do Histórico).
 */
import { supabaseTimestampToMs } from '@/services/syncConflict';
import {
  addVistoria,
  deleteVistoria,
  findVistoriaIdByCloudId,
  findVistoriaIdByExternalId,
  getVistoriaById,
  normalizeVistoriaStatusSync,
  removeVistoriaQueueItems,
  resolveLocalLeilaoIdForCloudFk,
  updateVistoria,
  type Vistoria,
} from '@/lib/db';

function readStableUuid(v: Vistoria): string | undefined {
  const fromNew = v.localUuid?.trim();
  if (fromNew) return fromNew;
  const legacy = (v as { externalId?: string }).externalId?.trim();
  return legacy || undefined;
}

/** Não sobrescrever dados locais com pull da nuvem quando há trabalho pendente ou exclusão. */
export function shouldPreserveLocalVistoriaFromCloudMerge(v: Vistoria): boolean {
  if (v.pendingCloudDelete) return true;
  const n = normalizeVistoriaStatusSync(v.statusSync);
  return (
    n === 'rascunho' ||
    n === 'pendente_sync' ||
    n === 'erro_sync' ||
    n === 'aguardando_ajuste' ||
    n === 'conflito_duplicidade'
  );
}

export async function patchVistoriaFromCloudRow(localId: number, row: Record<string, unknown>): Promise<void> {
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

export async function applyVistoriaInsert(row: Record<string, unknown>): Promise<void> {
  const cloudLeilaoFk = Number(row.leilao);
  const localLeilaoId = await resolveLocalLeilaoIdForCloudFk(cloudLeilaoFk);
  if (localLeilaoId == null) {
    if (import.meta.env.DEV) {
      console.warn('[vistoriaMerge] INSERT: leilão local não encontrado para FK', cloudLeilaoFk);
    }
    return;
  }

  const externalId = row.external_id != null ? String(row.external_id).trim() : '';
  if (!externalId) {
    if (import.meta.env.DEV) {
      console.warn('[vistoriaMerge] INSERT sem external_id; ignorando.', row);
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

export async function applyVistoriaUpdate(row: Record<string, unknown>): Promise<void> {
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

export async function applyVistoriaDelete(oldRow: Record<string, unknown>): Promise<void> {
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

/**
 * Pull do Histórico: mescla uma linha da nuvem sem apagar edições pendentes locais.
 */
export async function mergeCloudRowWithLocalPreservation(
  localLeilaoId: number,
  row: Record<string, unknown>,
): Promise<void> {
  const externalId = row.external_id != null ? String(row.external_id).trim() : '';
  let localId = externalId ? await findVistoriaIdByExternalId(externalId) : undefined;
  if (localId == null && row.id != null) {
    localId = await findVistoriaIdByCloudId(String(row.id));
  }

  const cloudFk = Number(row.leilao);
  const resolved = Number.isFinite(cloudFk) ? await resolveLocalLeilaoIdForCloudFk(cloudFk) : undefined;
  if (resolved != null && resolved !== localLeilaoId) return;

  if (localId == null) {
    await applyVistoriaInsert(row);
    return;
  }

  const v = await getVistoriaById(localId);
  if (!v || v.leilaoId !== localLeilaoId) return;

  if (shouldPreserveLocalVistoriaFromCloudMerge(v)) {
    const patch: Partial<Omit<Vistoria, 'id'>> = {};
    if (!v.cloudVistoriaId?.trim() && row.id != null) patch.cloudVistoriaId = String(row.id);
    if (!readStableUuid(v) && externalId) patch.localUuid = externalId;
    if (Object.keys(patch).length) await updateVistoria(localId, patch);
    return;
  }

  await patchVistoriaFromCloudRow(localId, row);
}

/** Mescla várias linhas retornadas pelo Supabase (mesmo leilão local). */
export async function mergeVistoriasFromCloudRows(
  localLeilaoId: number,
  rows: Record<string, unknown>[],
): Promise<void> {
  for (const row of rows) {
    await mergeCloudRowWithLocalPreservation(localLeilaoId, row);
  }
}
