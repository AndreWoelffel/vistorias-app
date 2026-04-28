/**
 * Recálculo de duplicidade por leilão: todas as vistorias no mesmo grupo (placa e/ou número) são marcadas.
 */
import {
  getVistoriasByLeilao,
  normalizeVistoriaStatusSync,
  updateVistoria,
  type Vistoria,
  type VistoriaDuplicateConflictPeer,
  type VistoriaDuplicateInfo,
  type VistoriaDuplicateType,
} from '@/lib/db';

function duplicateMessage(type: VistoriaDuplicateType): string {
  switch (type) {
    case 'placa':
      return 'Já existe vistoria com esta placa';
    case 'numero':
      return 'Já existe vistoria com este número';
    case 'ambos':
      return 'Já existe vistoria com esta placa e número';
  }
}

function normPlaca(p: string): string {
  return p.trim().toUpperCase().replace(/\s+/g, '');
}

function normNumVistoria(n: string): string {
  return n.trim();
}

function buildDuplicateInfo(
  type: VistoriaDuplicateType,
  displayPlaca: string,
  displayNum: string,
): VistoriaDuplicateInfo {
  const info: VistoriaDuplicateInfo = {};
  if (type === 'placa' || type === 'ambos') info.placa = displayPlaca;
  if (type === 'numero' || type === 'ambos') info.numeroVistoria = displayNum;
  return info;
}

function toPeer(v: Vistoria & { id: number }): VistoriaDuplicateConflictPeer {
  return {
    localVistoriaId: v.id,
    placa: v.placa,
    numeroVistoria: v.numeroVistoria,
    createdBy: v.createdBy ?? null,
    createdAt: v.createdAt,
  };
}

/**
 * Percorre todas as vistorias do leilão (exceto `pendingCloudDelete`).
 * Grupos com mais de um registro na mesma placa normalizada ou no mesmo número normalizado = conflito.
 * Marca todas as envolvidas; limpa quem saiu do conflito.
 */
export async function recalculateDuplicateVistoriasForLeilao(leilaoId: number): Promise<void> {
  const list = await getVistoriasByLeilao(leilaoId, { includePendingCloudDelete: false });
  const withIds = list.filter((v): v is Vistoria & { id: number } => v.id != null);
  if (withIds.length === 0) return;

  const placaToIds = new Map<string, number[]>();
  const numToIds = new Map<string, number[]>();
  for (const v of withIds) {
    const pk = normPlaca(v.placa);
    const nk = normNumVistoria(v.numeroVistoria);
    if (!placaToIds.has(pk)) placaToIds.set(pk, []);
    placaToIds.get(pk)!.push(v.id);
    if (!numToIds.has(nk)) numToIds.set(nk, []);
    numToIds.get(nk)!.push(v.id);
  }

  const idToRow = new Map<number, Vistoria & { id: number }>();
  for (const v of withIds) idToRow.set(v.id, v);

  const conflictIds = new Set<number>();
  for (const v of withIds) {
    const pk = normPlaca(v.placa);
    const nk = normNumVistoria(v.numeroVistoria);
    const pg = placaToIds.get(pk) ?? [];
    const ng = numToIds.get(nk) ?? [];
    if (pg.length > 1 || ng.length > 1) conflictIds.add(v.id);
  }

  const anyServerConflito = withIds.some(
    (v) => conflictIds.has(v.id) && normalizeVistoriaStatusSync(v.statusSync) === 'conflito_duplicidade',
  );

  for (const v of withIds) {
    const pk = normPlaca(v.placa);
    const nk = normNumVistoria(v.numeroVistoria);
    const placaGroup = placaToIds.get(pk) ?? [];
    const numGroup = numToIds.get(nk) ?? [];
    const hasPlacaDup = placaGroup.length > 1;
    const hasNumDup = numGroup.length > 1;
    const inConflict = hasPlacaDup || hasNumDup;

    if (!inConflict) {
      const n = normalizeVistoriaStatusSync(v.statusSync);
      const wasDup = n === 'aguardando_ajuste' || n === 'conflito_duplicidade';
      if (wasDup) {
        const hasCloud = Boolean(v.cloudVistoriaId?.trim());
        await updateVistoria(v.id, {
          statusSync: hasCloud ? 'sincronizado' : 'pendente_sync',
          syncMessage: undefined,
          duplicateType: undefined,
          duplicateInfo: undefined,
          duplicateConflictWith: undefined,
          duplicateConflictWithList: undefined,
        });
      }
      continue;
    }

    let type: VistoriaDuplicateType;
    if (hasPlacaDup && hasNumDup) type = 'ambos';
    else if (hasPlacaDup) type = 'placa';
    else type = 'numero';

    const peerIdSet = new Set<number>();
    for (const oid of placaGroup) if (oid !== v.id) peerIdSet.add(oid);
    for (const oid of numGroup) if (oid !== v.id) peerIdSet.add(oid);

    const peers = Array.from(peerIdSet)
      .map((pid) => idToRow.get(pid))
      .filter((row): row is Vistoria & { id: number } => row != null)
      .map(toPeer)
      .sort((a, b) => a.localVistoriaId - b.localVistoriaId);

    const statusSync = anyServerConflito ? 'conflito_duplicidade' : 'aguardando_ajuste';

    await updateVistoria(v.id, {
      statusSync,
      syncMessage: duplicateMessage(type),
      duplicateType: type,
      duplicateInfo: buildDuplicateInfo(type, v.placa, v.numeroVistoria),
      duplicateConflictWith: peers[0],
      duplicateConflictWithList: peers.length > 0 ? peers : undefined,
    });
  }
}
