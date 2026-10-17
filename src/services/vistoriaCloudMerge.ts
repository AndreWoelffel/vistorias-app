/**
 * Mescla linhas de public.vistorias no IndexedDB (Realtime + pull do Histórico).
 */
import { supabaseTimestampToMs } from '@/services/syncConflict';
import { supabase } from '@/services/supabaseClient';
import {
  addToQueue,
  addVistoria,
  deleteVistoria,
  findVistoriaIdByCloudId,
  findVistoriaIdByExternalId,
  getVistoriaById,
  getVistoriasByLeilao,
  normalizeVistoriaStatusSync,
  readStableUuid,
  removeVistoriaQueueItems,
  resolveLocalLeilaoIdForCloudFk,
  updateVistoria,
  type Vistoria,
} from '@/lib/db';

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

function cloudRowUpdatedAtMs(row: Record<string, unknown>): number {
  return row.updated_at != null ? supabaseTimestampToMs(String(row.updated_at)) : 0;
}

/** Só preenche ids da nuvem sem sobrescrever placa/número/status locais. */
async function patchIdentityOnlyFromCloud(
  localId: number,
  v: Vistoria,
  row: Record<string, unknown>,
): Promise<void> {
  const externalId = row.external_id != null ? String(row.external_id).trim() : '';
  const patch: Partial<Omit<Vistoria, 'id'>> = {};
  if (!v.cloudVistoriaId?.trim() && row.id != null) patch.cloudVistoriaId = String(row.id);
  if (!readStableUuid(v) && externalId) patch.localUuid = externalId;
  if (Object.keys(patch).length) await updateVistoria(localId, patch);
}

async function maybeRecalculateDuplicatesForLeilao(leilaoId: number | undefined): Promise<void> {
  if (leilaoId == null || !Number.isFinite(leilaoId)) return;
  const { recalculateDuplicateVistoriasForLeilao } = await import('@/services/duplicateVistoriaRecalc');
  await recalculateDuplicateVistoriasForLeilao(leilaoId);
}

/** Realtime/pull: aplica linha da nuvem respeitando edições e correções locais pendentes. */
async function mergeCloudRowIntoLocalVistoria(
  localId: number,
  row: Record<string, unknown>,
): Promise<void> {
  const v = await getVistoriaById(localId);
  if (!v) return;

  if (shouldPreserveLocalVistoriaFromCloudMerge(v)) {
    await patchIdentityOnlyFromCloud(localId, v, row);
    return;
  }

  const cloudMs = cloudRowUpdatedAtMs(row);
  const localMs = v.updatedAt ?? (v.createdAt ? new Date(v.createdAt).getTime() : 0);
  if (normalizeVistoriaStatusSync(v.statusSync) === 'sincronizado' && localMs > cloudMs) {
    await patchIdentityOnlyFromCloud(localId, v, row);
    return;
  }

  await patchVistoriaFromCloudRow(localId, row);
  await maybeRecalculateDuplicatesForLeilao(v.leilaoId);
}

export async function patchVistoriaFromCloudRow(localId: number, row: Record<string, unknown>): Promise<void> {
  // MÁGICA DO ARQUITETO 1: Extração segura sem gerar NaN
  const rawFk = row.leilao_id ?? row.leilao;
  const cloudLeilaoFk = rawFk != null ? Number(rawFk) : NaN;
  
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
    duplicateConflictWith: undefined,
    duplicateConflictWithList: undefined,
    pendingCloudDelete: false,
  };
  if (localLeilaoId != null) patch.leilaoId = localLeilaoId;

  await updateVistoria(localId, patch);
}

export async function applyVistoriaInsert(row: Record<string, unknown>): Promise<void> {
  // MÁGICA DO ARQUITETO 2: Aborta silenciosamente se for evento do Realtime sem FK
  const rawFk = row.leilao_id ?? row.leilao;
  const cloudLeilaoFk = rawFk != null ? Number(rawFk) : NaN;
  
  if (Number.isNaN(cloudLeilaoFk)) return; // <-- A linha que mata o erro!

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
    await mergeCloudRowIntoLocalVistoria(existingId, row);
    return;
  }

  await addVistoria({
    leilaoId: localLeilaoId,
    placa: String(row.placa ?? ''),
    numeroVistoria: String(row.num_vistoria ?? ''),
    vistoriador: String(row.vistoriador ?? ''),
    fotos: [],
    fotosSoNaNuvem: true,
    statusSync: 'sincronizado',
    createdAt: row.created_at ? new Date(String(row.created_at)) : new Date(),
    localUuid: externalId,
    cloudVistoriaId: row.id != null ? String(row.id) : undefined,
    createdBy: row.created_by != null ? String(row.created_by) : null,
    updatedAt:
      row.updated_at != null ? supabaseTimestampToMs(String(row.updated_at)) : undefined,
  });
  await maybeRecalculateDuplicatesForLeilao(localLeilaoId);
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
  await mergeCloudRowIntoLocalVistoria(localId, row);
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
    const v = await getVistoriaById(localId);
    const leilaoId = v?.leilaoId;
    await deleteVistoria(localId);
    await removeVistoriaQueueItems(localId);
    if (leilaoId != null && Number.isFinite(leilaoId)) {
      const { recalculateDuplicateVistoriasForLeilao } = await import('@/services/duplicateVistoriaRecalc');
      await recalculateDuplicateVistoriasForLeilao(leilaoId);
    }
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

  // MÁGICA DO ARQUITETO 3: Proteção na mesclagem de histórico
  const rawFk = row.leilao_id ?? row.leilao;
  const cloudFk = rawFk != null ? Number(rawFk) : NaN;
  
  const resolved = Number.isFinite(cloudFk) ? await resolveLocalLeilaoIdForCloudFk(cloudFk) : undefined;
  if (resolved != null && resolved !== localLeilaoId) return;

  if (localId == null) {
    await applyVistoriaInsert(row);
    return;
  }

  const v = await getVistoriaById(localId);
  if (!v || v.leilaoId !== localLeilaoId) return;

  await mergeCloudRowIntoLocalVistoria(localId, row);
}

function normPlaca(p: string): string {
  return p.trim().toUpperCase().replace(/\s+/g, '');
}

function normNumVistoria(n: string): string {
  return n.trim();
}

function placaNumKey(placa: string, num: string): string {
  return `${normPlaca(placa)}|${normNumVistoria(num)}`;
}

function isDuplicateStatus(v: Vistoria): boolean {
  const n = normalizeVistoriaStatusSync(v.statusSync);
  return n === 'aguardando_ajuste' || n === 'conflito_duplicidade';
}

/** Preserva edições locais reais — duplicidade órfã não conta como proteção. */
function shouldPreserveLocalFromCloudReconcile(v: Vistoria): boolean {
  if (v.pendingCloudDelete) return true;
  if (isDuplicateStatus(v)) return false;
  const n = normalizeVistoriaStatusSync(v.statusSync);
  return n === 'rascunho' || n === 'pendente_sync' || n === 'erro_sync';
}

/**
 * Ids que ainda existem em public.vistorias. A lista do leilão só mostra vistorias
 * vinculadas; uma que perdeu o vínculo some dela sem ter sido apagada.
 * Devolve null se não deu para conferir — aí nada é apagado do aparelho.
 */
async function idsQueAindaExistemNaNuvem(
  coluna: 'id' | 'external_id',
  valores: string[],
): Promise<Set<string> | null> {
  const existem = new Set<string>();
  for (let i = 0; i < valores.length; i += 100) {
    const lote = valores.slice(i, i + 100);
    const { data, error } = await supabase.from('vistorias').select(coluna).in(coluna, lote);
    if (error) return null;
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      if (row[coluna] != null) existem.add(String(row[coluna]));
    }
  }
  return existem;
}

/** Vistoria ainda na nuvem mas fora do leilão: volta para a fila, que refaz o vínculo. */
async function reenviarVistoriaSemVinculo(localId: number): Promise<void> {
  await removeVistoriaQueueItems(localId);
  await updateVistoria(localId, { statusSync: 'pendente_sync', syncMessage: undefined });
  await addToQueue({ type: 'create', entity: 'vistoria', payload: { localVistoriaId: localId } });
}

async function removeLocalVistoriaIfExists(localId: number): Promise<boolean> {
  const v = await getVistoriaById(localId);
  if (!v?.id) return false;
  await deleteVistoria(v.id);
  await removeVistoriaQueueItems(v.id);
  return true;
}

/**
 * Remove do aparelho vistorias já enviadas que não existem mais na nuvem.
 * Preserva rascunhos, pendências de envio e edições locais em andamento.
 */
export async function reconcileLocalVistoriasWithCloudRows(
  localLeilaoId: number,
  rows: Record<string, unknown>[],
): Promise<number> {
  const cloudIds = new Set<string>();
  const externalIds = new Set<string>();
  const cloudRowsByKey = new Map<string, { cloudId: string; externalId: string }>();

  for (const row of rows) {
    const cloudId = row.id != null ? String(row.id) : '';
    const ext = row.external_id != null ? String(row.external_id).trim() : '';
    if (cloudId) cloudIds.add(cloudId);
    if (ext) externalIds.add(ext);
    const key = placaNumKey(String(row.placa ?? ''), String(row.num_vistoria ?? ''));
    if (cloudId) cloudRowsByKey.set(key, { cloudId, externalId: ext });
  }

  const locals = await getVistoriasByLeilao(localLeilaoId, { includePendingCloudDelete: true });
  let removed = 0;

  // 1) Fantasmas: tinham cloudVistoriaId mas sumiram do servidor (mesmo com status duplicidade).
  const fantasmas = locals.filter((v) => {
    const cloudId = v.cloudVistoriaId?.trim();
    return v.id != null && Boolean(cloudId) && !cloudIds.has(cloudId as string);
  });
  const fantasmasNaNuvem =
    fantasmas.length > 0
      ? await idsQueAindaExistemNaNuvem('id', fantasmas.map((v) => String(v.cloudVistoriaId).trim()))
      : new Set<string>();
  if (fantasmasNaNuvem) {
    for (const v of fantasmas) {
      if (v.id == null) continue;
      if (fantasmasNaNuvem.has(String(v.cloudVistoriaId).trim())) {
        if (!v.pendingCloudDelete) await reenviarVistoriaSemVinculo(v.id);
        continue;
      }
      if (v.pendingCloudDelete || (await removeLocalVistoriaIfExists(v.id))) {
        removed += 1;
      }
    }
  }

  const localsAfterGhost = await getVistoriasByLeilao(localLeilaoId, { includePendingCloudDelete: true });

  // 2) external_id sincronizado que não existe mais na nuvem.
  const semId = localsAfterGhost.filter((v) => {
    if (v.id == null || v.pendingCloudDelete) return false;
    if (shouldPreserveLocalFromCloudReconcile(v)) return false;
    if (v.cloudVistoriaId?.trim()) return false;
    const ext = readStableUuid(v);
    return normalizeVistoriaStatusSync(v.statusSync) === 'sincronizado' && Boolean(ext) && !externalIds.has(ext as string);
  });
  const semIdNaNuvem =
    semId.length > 0
      ? await idsQueAindaExistemNaNuvem('external_id', semId.map((v) => readStableUuid(v) as string))
      : new Set<string>();
  if (semIdNaNuvem) {
    for (const v of semId) {
      if (v.id == null) continue;
      if (semIdNaNuvem.has(readStableUuid(v) as string)) {
        await reenviarVistoriaSemVinculo(v.id);
        continue;
      }
      if (await removeLocalVistoriaIfExists(v.id)) removed += 1;
    }
  }

  const localsForDedup = await getVistoriasByLeilao(localLeilaoId, { includePendingCloudDelete: true });
  const localsByKey = new Map<string, (Vistoria & { id: number })[]>();

  for (const v of localsForDedup) {
    if (v.id == null || v.pendingCloudDelete) continue;
    const key = placaNumKey(v.placa, v.numeroVistoria);
    const list = localsByKey.get(key) ?? [];
    list.push(v as Vistoria & { id: number });
    localsByKey.set(key, list);
  }

  // 3) Mesma placa+número: servidor tem 1, aparelho tem 2+ → remove intrusas locais.
  for (const [key, group] of localsByKey) {
    if (group.length <= 1) continue;
    const cloudRef = cloudRowsByKey.get(key);
    if (!cloudRef) continue;

    let keeper: (Vistoria & { id: number }) | undefined;
    for (const v of group) {
      if (v.cloudVistoriaId?.trim() === cloudRef.cloudId) {
        keeper = v;
        break;
      }
    }
    if (!keeper && cloudRef.externalId) {
      keeper = group.find((v) => readStableUuid(v) === cloudRef.externalId);
    }
    if (!keeper) {
      keeper = group.find((v) => normalizeVistoriaStatusSync(v.statusSync) === 'sincronizado');
    }
    if (!keeper) continue;

    for (const v of group) {
      if (v.id === keeper.id) continue;
      if (shouldPreserveLocalFromCloudReconcile(v)) continue;
      if (await removeLocalVistoriaIfExists(v.id)) removed += 1;
    }
  }

  return removed;
}

/** Mescla várias linhas retornadas pelo Supabase (mesmo leilão local). */
export async function mergeVistoriasFromCloudRows(
  localLeilaoId: number,
  rows: Record<string, unknown>[],
): Promise<{ removedLocal: number }> {
  for (const row of rows) {
    await mergeCloudRowWithLocalPreservation(localLeilaoId, row);
  }
  const removedLocal = await reconcileLocalVistoriasWithCloudRows(localLeilaoId, rows);
  const { recalculateDuplicateVistoriasForLeilao } = await import('@/services/duplicateVistoriaRecalc');
  await recalculateDuplicateVistoriasForLeilao(localLeilaoId);
  return { removedLocal };
}