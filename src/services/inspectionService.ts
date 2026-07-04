// src/services/inspectionService.ts
/**
 * Ao adicionar `supabase.from(...).select(...)`, trate sempre `data` como possivelmente null:
 * `const { data, error } = await supabase.from('t').select(); const rows = data ?? [];`
 */
import { supabase } from './supabaseClient';
import {
  getLeilaoById,
  getVistoriaById,
  getVistoriasByLeilao,
  normalizeVistoriaStatusSync,
  updateLeilao,
  updateVistoria,
  isValidUuid,
  readStableUuid,
  type Vistoria,
  type VistoriaDuplicateConflictPeer,
  type VistoriaDuplicateInfo,
  type VistoriaDuplicateType,
} from '@/lib/db';
import { getCreatedBySnapshot } from '@/services/currentUserService';
import { logSyncConflict, supabaseTimestampToMs } from '@/services/syncConflict';
import { mergeVistoriasFromCloudRows } from '@/services/vistoriaCloudMerge';
import { recalculateDuplicateVistoriasForLeilao } from '@/services/duplicateVistoriaRecalc';
import { syncVistoriaFotosToCloud } from '@/services/vistoriaFotoService';

export { recalculateDuplicateVistoriasForLeilao } from '@/services/duplicateVistoriaRecalc';

function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === '23505';
}

export { isValidUuid, readStableUuid, ensureVistoriaLocalUuidIsUuid } from '@/lib/db';

type VistoriaCloudRow = {
  id?: string;
  updated_at?: string | null;
  placa?: string | null;
  num_vistoria?: string | null;
  vistoriador?: string | null;
  url_foto?: string | null;
};

async function ensureLeilaoSupabaseId(localLeilaoId: number): Promise<number | null> {
  if (!Number.isFinite(localLeilaoId) || localLeilaoId <= 0) return null;
  const leilao = await getLeilaoById(localLeilaoId);
  if (!leilao) return null;
  
  // MÁGICA DO ARQUITETO 1: Bloqueio explícito contra o NaN
  if (leilao.supabaseId != null && !Number.isNaN(leilao.supabaseId)) return leilao.supabaseId;

  const snap = await getCreatedBySnapshot();
  const createdBy = leilao.createdBy?.trim() || snap.displayName;

  const { data, error } = await supabase
    .from('leiloes')
    .insert({ nome: leilao.nome, created_by: createdBy })
    .select('id, updated_at')
    .maybeSingle();

  if (error || data?.id == null) return null;

  const sid = Number(data.id);
  // MÁGICA DO ARQUITETO 2: Se o banco devolver lixo, não deixamos virar NaN
  if (Number.isNaN(sid)) return null; 

  const uAt = supabaseTimestampToMs((data as { updated_at?: string | null }).updated_at);
  try {
    await updateLeilao(localLeilaoId, {
      supabaseId: sid,
      createdBy,
      createdByUserId: leilao.createdByUserId ?? (snap.userId != null ? String(snap.userId) : null),
      updatedAt: uAt > 0 ? uAt : Date.now(),
    });
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[IDB] Falha ao gravar supabaseId no leilão local:", e);
  }
  return sid;
}

export async function fetchAndMergeVistoriasFromCloudForLeilao(
  localLeilaoId: number,
): Promise<{ ok: boolean; rowCount: number; removedLocal: number }> {
  const leilao = await getLeilaoById(localLeilaoId);
  if (!leilao) return { ok: false, rowCount: 0, removedLocal: 0 };
  
  const fk = leilao.supabaseId;
  // MÁGICA DO ARQUITETO 3: Impede a busca fantasma se for NaN
  if (fk == null || Number.isNaN(fk)) return { ok: false, rowCount: 0, removedLocal: 0 };

  const { data, error } = await supabase
    .from('vistorias_com_leilao')
    .select('*')
    .eq('leilao_id', fk)
    .order('created_at', { ascending: false });

  if (error) return { ok: false, rowCount: 0, removedLocal: 0 };

  const rows = (data ?? []) as Record<string, unknown>[];
  const { removedLocal } = await mergeVistoriasFromCloudRows(localLeilaoId, rows);
  return { ok: true, rowCount: rows.length, removedLocal };
}

const DATASET_BUCKET = 'dataset-minerado';

/**
 * Faz upload secundário da foto da placa para o bucket de Hard Examples.
 * Silencia erros: nunca deve bloquear o fluxo principal de sync.
 */
async function uploadHardExample(v: Vistoria): Promise<void> {
  if (!v.isHardExample || !v.placaSugeridaIA) return;
  const foto = v.fotos?.[0];
  if (!foto || foto.size <= 0) return;

  const errorType: 'yolo' | 'cnn' = v.isYoloError ? 'yolo' : 'cnn';
  const timestamp = Date.now();
  const placaCorreta = v.placa.trim().toUpperCase().replace(/\s+/g, '');
  const placaIA = v.placaSugeridaIA.trim().toUpperCase().replace(/\s+/g, '');
  const fileName = `${placaCorreta}_sugerido_${placaIA}_${errorType}_${timestamp}.jpg`;

  try {
    await supabase.storage
      .from(DATASET_BUCKET)
      .upload(`placas/${fileName}`, foto, { contentType: 'image/jpeg', upsert: false });
  } catch (e) {
    if (import.meta.env.DEV) {
      console.warn('[HEM] Falha no upload do hard example:', e);
    }
  }
}

function normPlaca(p: string): string {
  return p.trim().toUpperCase().replace(/\s+/g, '');
}

function normNumVistoria(n: string): string {
  return n.trim();
}

export type LocalDuplicateAnalysis =
  | { duplicate: false }
  | {
      duplicate: true;
      type: VistoriaDuplicateType;
      info: VistoriaDuplicateInfo;
      conflictWith?: VistoriaDuplicateConflictPeer;
    };

export type DuplicateCheckResult =
  | { ok: true }
  | {
      ok: false;
      type: VistoriaDuplicateType;
      message: string;
      info: VistoriaDuplicateInfo;
      conflictWith?: VistoriaDuplicateConflictPeer;
    };

export function duplicateUserMessage(type: VistoriaDuplicateType): string {
  switch (type) {
    case 'placa': return 'Já existe vistoria com esta placa';
    case 'numero': return 'Já existe vistoria com este número';
    case 'ambos': return 'Já existe vistoria com esta placa e número';
  }
}

export function duplicateTypeShortLabel(type: VistoriaDuplicateType): string {
  switch (type) {
    case 'placa': return 'Duplicado (placa)';
    case 'numero': return 'Duplicado (número)';
    case 'ambos': return 'Duplicado (placa + número)';
  }
}

export function duplicateValuesCaption(
  type: VistoriaDuplicateType | undefined,
  info: VistoriaDuplicateInfo | undefined,
): string | null {
  if (!type || !info) return null;
  const parts: string[] = [];
  if (type === 'placa' || type === 'ambos') {
    const p = info.placa?.trim();
    if (p) parts.push(`Placa ${p}`);
  }
  if (type === 'numero' || type === 'ambos') {
    const n = info.numeroVistoria?.trim();
    if (n) parts.push(`Nº ${n}`);
  }
  return parts.length ? parts.join(' · ') : null;
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

export async function analyzeLocalDuplicateVistoria(
  leilaoId: number,
  placa: string,
  numeroVistoria: string,
  excludeLocalId?: number,
): Promise<LocalDuplicateAnalysis> {
  const list = await getVistoriasByLeilao(leilaoId, { includePendingCloudDelete: true });
  const p = normPlaca(placa);
  const n = normNumVistoria(numeroVistoria);
  let conflictP = false;
  let conflictN = false;
  for (const v of list) {
    if (excludeLocalId != null && v.id === excludeLocalId) continue;
    if (normPlaca(v.placa) === p) conflictP = true;
    if (normNumVistoria(v.numeroVistoria) === n) conflictN = true;
  }
  if (!conflictP && !conflictN) return { duplicate: false };
  const type: VistoriaDuplicateType = conflictP && conflictN ? 'ambos' : conflictP ? 'placa' : 'numero';

  const candidates = list.filter((v) => v.id != null && v.id !== excludeLocalId) as (Vistoria & { id: number })[];
  let peer: (Vistoria & { id: number }) | undefined;
  const both = candidates.find((v) => normPlaca(v.placa) === p && normNumVistoria(v.numeroVistoria) === n);
  if (both) peer = both;
  else if (type === 'placa' || type === 'ambos') peer = candidates.find((v) => normPlaca(v.placa) === p);
  else peer = candidates.find((v) => normNumVistoria(v.numeroVistoria) === n);

  return { duplicate: true, type, info: buildDuplicateInfo(type, p, n), conflictWith: peer ? vistoriaToConflictPeer(peer) : undefined };
}

function cloudRowIsSelf(
  row: { id?: string; external_id?: string | null } | null | undefined,
  extEx: string,
  cloudEx: string,
): boolean {
  if (!row) return false;
  if (cloudEx && String(row.id ?? '') === cloudEx) return true;
  if (extEx && isValidUuid(extEx)) {
    const ex = String(row.external_id ?? '').trim();
    if (ex === extEx) return true;
  }
  return false;
}

/** Busca conflito na nuvem sem falhar se houver 2+ linhas (maybeSingle quebraria). */
async function findCloudDuplicateRow(
  leilaoFk: number,
  field: 'placa' | 'num_vistoria',
  value: string,
  excludeExternalId: string,
  excludeCloudId: string,
): Promise<{ id?: string; external_id?: string | null } | null> {
  const { data, error } = await supabase
    .from('vistorias_com_leilao')
    .select('id, external_id')
    .eq('leilao_id', leilaoFk)
    .eq(field, value)
    .limit(5);

  if (error) return null;
  const rows = (data ?? []) as { id?: string; external_id?: string | null }[];
  for (const row of rows) {
    if (!cloudRowIsSelf(row, excludeExternalId, excludeCloudId)) return row;
  }
  return null;
}

export async function assertNoDuplicateVistoriaForSync(opts: {
  leilaoId: number;
  placa: string;
  numeroVistoria: string;
  excludeLocalId?: number;
  excludeExternalId?: string;
  excludeCloudVistoriaId?: string;
}): Promise<DuplicateCheckResult> {
  const local = await analyzeLocalDuplicateVistoria(
    opts.leilaoId, opts.placa, opts.numeroVistoria, opts.excludeLocalId,
  );
  if (local.duplicate) {
    return {
      ok: false, type: local.type, message: duplicateUserMessage(local.type), info: local.info, conflictWith: local.conflictWith,
    };
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: true };

  const fk = await ensureLeilaoSupabaseId(opts.leilaoId);
  if (fk == null) return { ok: true };

  const p = normPlaca(opts.placa);
  const n = normNumVistoria(opts.numeroVistoria);
  const extEx = opts.excludeExternalId?.trim() || '';
  const cloudEx = opts.excludeCloudVistoriaId?.trim() || '';

  const rp = await findCloudDuplicateRow(fk, 'placa', p, extEx, cloudEx);
  const rn = await findCloudDuplicateRow(fk, 'num_vistoria', n, extEx, cloudEx);

  const conflictPlaca = rp != null && !cloudRowIsSelf(rp, extEx, cloudEx);
  const conflictNum = rn != null && !cloudRowIsSelf(rn, extEx, cloudEx);

  if (!conflictPlaca && !conflictNum) return { ok: true };

  const type: VistoriaDuplicateType = conflictPlaca && conflictNum ? 'ambos' : conflictPlaca ? 'placa' : 'numero';
  return {
    ok: false, type, message: duplicateUserMessage(type), info: buildDuplicateInfo(type, p, n),
  };
}

const clearedDuplicateFields = {
  syncMessage: undefined as string | undefined,
  duplicateType: undefined as VistoriaDuplicateType | undefined,
  duplicateInfo: undefined as VistoriaDuplicateInfo | undefined,
  duplicateConflictWith: undefined as VistoriaDuplicateConflictPeer | undefined,
  duplicateConflictWithList: undefined as VistoriaDuplicateConflictPeer[] | undefined,
};

function vistoriaToConflictPeer(v: Vistoria): VistoriaDuplicateConflictPeer {
  return { localVistoriaId: v.id as number, placa: v.placa, numeroVistoria: v.numeroVistoria, createdBy: v.createdBy ?? null, createdAt: v.createdAt };
}

function resolveInspectionFotos(data: InspectionData): Blob[] {
  if (data.fotos?.length) return data.fotos;
  if (data.fotoFile && data.fotoFile.size > 0) return [data.fotoFile];
  return [];
}

async function syncFotosForCloudVistoria(
  leilaoLocalId: number | undefined,
  vistoriaCloudId: string,
  fotos: Blob[],
): Promise<{ placaPublicUrl: string | null; uploadFailed: boolean }> {
  if (leilaoLocalId == null) return { placaPublicUrl: null, uploadFailed: false };
  const leilaoFk = await ensureLeilaoSupabaseId(leilaoLocalId);
  if (leilaoFk == null) return { placaPublicUrl: null, uploadFailed: fotos.length > 0 };
  return syncVistoriaFotosToCloud({ leilaoFk, vistoriaCloudId, fotos });
}

/** Sobe fotos locais e atualiza url_foto (placa). Idempotente — seguro reexecutar. */
async function pushLocalFotosToCloud(opts: {
  leilaoId?: number;
  cloudVistoriaId: string;
  fotos: Blob[];
  localVistoriaId?: number;
}): Promise<{ uploadFailed: boolean }> {
  if (!opts.fotos.length) return { uploadFailed: false };
  const fotoSync = await syncFotosForCloudVistoria(opts.leilaoId, opts.cloudVistoriaId, opts.fotos);
  if (fotoSync.placaPublicUrl) {
    await supabase.from('vistorias').update({ url_foto: fotoSync.placaPublicUrl }).eq('id', opts.cloudVistoriaId);
  }
  if (opts.localVistoriaId != null) {
    await updateVistoria(opts.localVistoriaId, { fotoUploadFailed: fotoSync.uploadFailed });
  }
  return { uploadFailed: fotoSync.uploadFailed };
}

/** Reenvia todas as fotos locais das vistorias já na nuvem (idempotente). */
export async function resyncAllFotosForLeilao(localLeilaoId: number): Promise<void> {
  const list = await getVistoriasByLeilao(localLeilaoId, { includePendingCloudDelete: false });
  for (const v of list) {
    const cloudId = v.cloudVistoriaId?.trim();
    if (v.id == null || !cloudId || !isValidUuid(cloudId)) continue;
    if (!v.fotos?.length) continue;
    if (normalizeVistoriaStatusSync(v.statusSync) === 'rascunho') continue;
    await pushLocalFotosToCloud({
      leilaoId: localLeilaoId,
      cloudVistoriaId: cloudId,
      fotos: v.fotos,
      localVistoriaId: v.id,
    });
  }
}

export interface InspectionData {
  placa: string;
  numero_vistoria: string;
  /** Todas as fotos locais (prefixos PLACA_, ADESIVO_, etc.). Preferir sobre fotoFile. */
  fotos?: Blob[];
  /** Legado: uma foto; usado só se fotos não for informado. */
  fotoFile?: File | Blob | null;
  leilaoId?: number;
  vistoriador?: string;
  createdBy?: string;
  createdByUserId?: string | null;
  localUuid?: string;
  cloudVistoriaId?: string;
  localVistoriaId?: number;
  localUpdatedAtMs?: number;
}

export async function saveInspection(data: InspectionData): Promise<boolean> {
  try {
    const localVid = data.localVistoriaId;
    const cloudHint = data.cloudVistoriaId?.trim();

    let extUuid: string | null = null;
    if (localVid != null) {
      const vLocal = await getVistoriaById(localVid);
      if (!vLocal) return false;
      const u = vLocal.localUuid?.trim();
      extUuid = u && isValidUuid(u) ? u : null;
    }
    if (!extUuid) {
      const t = data.localUuid?.trim();
      extUuid = t && isValidUuid(t) ? t : null;
    }
    if (!extUuid) return false;

    const localMs = data.localUpdatedAtMs ?? 0;
    const selectCols = 'id, updated_at, placa, num_vistoria, vistoriador, url_foto';

    let existing: VistoriaCloudRow | null = null;

    if (cloudHint && isValidUuid(cloudHint)) {
      const r = await supabase.from('vistorias').select(selectCols).eq('id', cloudHint).maybeSingle();
      if (r.error) return false;
      existing = r.data as VistoriaCloudRow | null;
    }

    if (!existing?.id) {
      const r = await supabase.from('vistorias').select(selectCols).eq('external_id', extUuid).maybeSingle();
      if (r.error) return false;
      existing = r.data as VistoriaCloudRow | null;
    }

    const ex = existing as VistoriaCloudRow | null;
    const cloudRowId = ex?.id != null ? String(ex.id) : '';
    const dupExcludeCloud = cloudRowId || (cloudHint && isValidUuid(cloudHint) ? cloudHint : undefined);

    // FLUXO UPDATE
    if (ex?.id != null) {
      const serverMs = supabaseTimestampToMs(ex.updated_at);
      if (serverMs === localMs) {
        const localFotos = resolveInspectionFotos(data);
        if (localFotos.length > 0) {
          await pushLocalFotosToCloud({
            leilaoId: data.leilaoId,
            cloudVistoriaId: cloudRowId,
            fotos: localFotos,
            localVistoriaId: localVid ?? undefined,
          });
        }
        if (localVid != null) {
          await updateVistoria(localVid, {
            statusSync: 'sincronizado', updatedAt: serverMs || Date.now(), cloudVistoriaId: String(ex.id), ...clearedDuplicateFields,
          });
        }
        return true;
      }

      logSyncConflict({ entity: 'vistoria', fluxo: 'create/sync', external_id: extUuid, localVistoriaId: localVid, serverMs, localMs, resolucao: serverMs > localMs ? 'servidor' : 'local' });

      if (serverMs > localMs) {
        if (localVid != null) {
          await updateVistoria(localVid, {
            placa: String(ex.placa ?? ''), numeroVistoria: String(ex.num_vistoria ?? ''), vistoriador: String(ex.vistoriador ?? ''),
            statusSync: 'sincronizado', updatedAt: serverMs, cloudVistoriaId: String(ex.id), ...clearedDuplicateFields,
          });
        }
        return true;
      }

      let urlFoto: string | null = ex.url_foto != null ? String(ex.url_foto) : null;
      const localFotos = resolveInspectionFotos(data);
      const fotoSync = await syncFotosForCloudVistoria(data.leilaoId, cloudRowId, localFotos);
      if (fotoSync.placaPublicUrl) urlFoto = fotoSync.placaPublicUrl;
      if (localVid != null && fotoSync.uploadFailed) await updateVistoria(localVid, { fotoUploadFailed: true });

      const snap = await getCreatedBySnapshot();
      const createdBy = data.createdBy?.trim() || snap.displayName;
      const patch: Record<string, unknown> = {
        placa: data.placa, num_vistoria: data.numero_vistoria, url_foto: urlFoto, created_by: createdBy,
      };
      if (data.vistoriador != null && data.vistoriador !== '') patch.vistoriador = data.vistoriador;

      if (data.leilaoId != null && localVid != null) {
        const dup = await assertNoDuplicateVistoriaForSync({
          leilaoId: data.leilaoId, placa: data.placa, numeroVistoria: data.numero_vistoria,
          excludeLocalId: localVid, excludeExternalId: extUuid, excludeCloudVistoriaId: dupExcludeCloud,
        });
        if (!dup.ok) {
          // Correção do TypeScript usando Extract
          const errDup = dup as Extract<DuplicateCheckResult, { ok: false }>;
          await updateVistoria(localVid, {
            statusSync: 'conflito_duplicidade', syncMessage: errDup.message, duplicateType: errDup.type, duplicateInfo: errDup.info, duplicateConflictWith: errDup.conflictWith,
          });
          await recalculateDuplicateVistoriasForLeilao(data.leilaoId);
          return false;
        }
      }

      const { data: after, error: upErr } = await supabase.from('vistorias').update(patch).eq('id', cloudRowId).select('id, updated_at').maybeSingle();
      if (upErr) throw new Error(upErr.message);

      const afterRow = after as { id?: string; updated_at?: string | null } | null;
      const newMs = supabaseTimestampToMs(afterRow?.updated_at);
      if (localVid != null) {
        await updateVistoria(localVid, {
          statusSync: 'sincronizado', updatedAt: newMs > 0 ? newMs : Date.now(), cloudVistoriaId: String(afterRow?.id || ex.id), fotoUploadFailed: false, ...clearedDuplicateFields,
        });
      }
      return true;
    }

    // FLUXO INSERT
    let fkToLink: number | null = null;
    if (data.leilaoId != null) {
      fkToLink = await ensureLeilaoSupabaseId(data.leilaoId);
      if (fkToLink == null) return false;
      
      if (localVid != null) {
        const dupIns = await assertNoDuplicateVistoriaForSync({
          leilaoId: data.leilaoId, placa: data.placa, numeroVistoria: data.numero_vistoria,
          excludeLocalId: localVid, excludeExternalId: extUuid, excludeCloudVistoriaId: dupExcludeCloud,
        });
        if (!dupIns.ok) {
          // Correção do TypeScript usando Extract
          const errDupIns = dupIns as Extract<DuplicateCheckResult, { ok: false }>;
          await updateVistoria(localVid, {
            statusSync: 'conflito_duplicidade', syncMessage: errDupIns.message, duplicateType: errDupIns.type, duplicateInfo: errDupIns.info, duplicateConflictWith: errDupIns.conflictWith,
          });
          await recalculateDuplicateVistoriasForLeilao(data.leilaoId);
          return false;
        }
      }
    }

    const snap = await getCreatedBySnapshot();
    const createdBy = data.createdBy?.trim() || snap.displayName;
    const localFotosInsert = resolveInspectionFotos(data);

    const row: Record<string, unknown> = {
      placa: data.placa, num_vistoria: data.numero_vistoria, url_foto: null, baixado_pc: false, created_by: createdBy, external_id: extUuid,
    };
    if (data.vistoriador != null && data.vistoriador !== '') row.vistoriador = data.vistoriador;

    const { data: ins, error: dbError } = await supabase.from('vistorias').insert([row]).select('id, updated_at').maybeSingle();

    if (dbError) {
      if (isUniqueViolation(dbError)) return saveInspection(data);
      throw new Error(dbError.message);
    }

    const insRow = ins as { id?: string; updated_at?: string | null } | null;
    
    // MÁGICA DO ARQUITETO 4: A barreira final antes de mandar pro Supabase
    if (insRow?.id && fkToLink != null && !Number.isNaN(fkToLink)) {
      const { error: relError } = await supabase.from('vistorias_leiloes').insert({
        vistoria_id: insRow.id,
        leilao_id: fkToLink
      });
      if (relError && import.meta.env.DEV) {
         console.error("[Supabase] Falha ao vincular vistoria ao leilão:", relError.message);
      }
    }

    let fotoUploadFailed = false;
    if (insRow?.id && fkToLink != null && !Number.isNaN(fkToLink) && localFotosInsert.length > 0) {
      const fotoSync = await syncVistoriaFotosToCloud({
        leilaoFk: fkToLink,
        vistoriaCloudId: String(insRow.id),
        fotos: localFotosInsert,
      });
      fotoUploadFailed = fotoSync.uploadFailed;
      if (fotoSync.placaPublicUrl) {
        await supabase.from('vistorias').update({ url_foto: fotoSync.placaPublicUrl }).eq('id', insRow.id);
      }
    }

    const insMs = supabaseTimestampToMs(insRow?.updated_at);
    if (localVid != null) {
      await updateVistoria(localVid, {
        statusSync: 'sincronizado', updatedAt: insMs > 0 ? insMs : Date.now(), cloudVistoriaId: String(insRow?.id), fotoUploadFailed, ...clearedDuplicateFields,
      });
    }
    return true;
  } catch (error) {
    console.error("[Supabase] Erro ao salvar vistoria:", error);
    return false;
  }
}

export type SyncInspectionFromLocalResult = 'ok' | 'fail' | 'duplicate';

export async function syncInspectionFromLocal(localVistoriaId: number): Promise<SyncInspectionFromLocalResult> {
  const v = await getVistoriaById(localVistoriaId);
  if (!v) return 'fail';
  const ns0 = normalizeVistoriaStatusSync(v.statusSync);
  if (ns0 === 'aguardando_ajuste' || ns0 === 'conflito_duplicidade') return 'duplicate';
  if (ns0 === 'sincronizado') {
    const cloudId = v.cloudVistoriaId?.trim();
    if (cloudId && isValidUuid(cloudId) && (v.fotos?.length ?? 0) > 0) {
      await pushLocalFotosToCloud({
        leilaoId: v.leilaoId,
        cloudVistoriaId: cloudId,
        fotos: v.fotos ?? [],
        localVistoriaId,
      });
    }
    return 'ok';
  }

  const localUuid = readStableUuid(v);
  if (!localUuid || !isValidUuid(localUuid)) return 'fail';

  const cloudId = v.cloudVistoriaId?.trim();
  const dupSync = await assertNoDuplicateVistoriaForSync({
    leilaoId: v.leilaoId, placa: v.placa, numeroVistoria: v.numeroVistoria,
    excludeLocalId: localVistoriaId, excludeExternalId: localUuid, excludeCloudVistoriaId: cloudId && isValidUuid(cloudId) ? cloudId : undefined,
  });
  
  if (!dupSync.ok) {
    // Correção do TypeScript usando Extract
    const errDupSync = dupSync as Extract<DuplicateCheckResult, { ok: false }>;
    await updateVistoria(localVistoriaId, {
      statusSync: 'conflito_duplicidade', syncMessage: errDupSync.message, duplicateType: errDupSync.type, duplicateInfo: errDupSync.info, duplicateConflictWith: errDupSync.conflictWith,
    });
    await recalculateDuplicateVistoriasForLeilao(v.leilaoId);
    return 'duplicate';
  }

  const ok = await saveInspection({
    placa: v.placa, numero_vistoria: v.numeroVistoria, fotos: v.fotos, leilaoId: v.leilaoId, vistoriador: v.vistoriador,
    createdBy: v.createdBy ?? undefined, createdByUserId: v.createdByUserId, localUuid, cloudVistoriaId: cloudId && isValidUuid(cloudId) ? cloudId : undefined, localVistoriaId, localUpdatedAtMs: v.updatedAt ?? new Date(v.createdAt).getTime(),
  });
  if (ok) {
    // Hard Example Mining: upload secundário assíncrono, não bloqueia sync
    void uploadHardExample(v);
    return 'ok';
  }
  
  const v2 = await getVistoriaById(localVistoriaId);
  const ns2 = normalizeVistoriaStatusSync(v2?.statusSync);
  if (ns2 === 'conflito_duplicidade' || ns2 === 'aguardando_ajuste') return 'duplicate';
  return 'fail';
}

export async function syncVistoriaUpdateToCloud(localVistoriaId: number): Promise<boolean> {
  const v = await getVistoriaById(localVistoriaId);
  if (!v) return false;

  const cloudId = v.cloudVistoriaId?.trim();
  const ns = normalizeVistoriaStatusSync(v.statusSync);
  if (ns === 'aguardando_ajuste' || ns === 'conflito_duplicidade' || ns === 'rascunho' || v.pendingCloudDelete) return false;
  if (!cloudId || !isValidUuid(cloudId)) return false;

  const extResolved = readStableUuid(v);
  if (!extResolved || !isValidUuid(extResolved)) return false;

  const { data: serverRow, error } = await supabase.from('vistorias').select('id, updated_at, placa, num_vistoria, vistoriador, url_foto').eq('id', cloudId).maybeSingle();
  if (error || !serverRow) return false;

  const ex = serverRow as VistoriaCloudRow;
  const serverMs = supabaseTimestampToMs(ex.updated_at);
  const localMs = v.updatedAt ?? new Date(v.createdAt).getTime();

  if (serverMs > localMs) {
    await updateVistoria(localVistoriaId, {
      placa: String(ex.placa ?? ''), numeroVistoria: String(ex.num_vistoria ?? ''), vistoriador: String(ex.vistoriador ?? ''),
      updatedAt: serverMs, cloudVistoriaId: String(ex.id),
    });
    return true;
  }

  if (serverMs === localMs) {
    const sameText = String(ex.placa ?? '').trim() === String(v.placa ?? '').trim() &&
      String(ex.num_vistoria ?? '').trim() === String(v.numeroVistoria ?? '').trim() &&
      String(ex.vistoriador ?? '').trim() === String(v.vistoriador ?? '').trim();
    if (sameText) {
      if ((v.fotos?.length ?? 0) > 0) {
        await pushLocalFotosToCloud({
          leilaoId: v.leilaoId,
          cloudVistoriaId: cloudId,
          fotos: v.fotos ?? [],
          localVistoriaId,
        });
      }
      await updateVistoria(localVistoriaId, { updatedAt: serverMs, cloudVistoriaId: String(ex.id) });
      return true;
    }
  }

  const fotoSync = await syncFotosForCloudVistoria(v.leilaoId, cloudId, v.fotos ?? []);
  let urlFoto: string | null = ex.url_foto != null ? String(ex.url_foto) : null;
  if (fotoSync.placaPublicUrl) urlFoto = fotoSync.placaPublicUrl;
  if (fotoSync.uploadFailed) await updateVistoria(localVistoriaId, { fotoUploadFailed: true });

  const dupUpd = await assertNoDuplicateVistoriaForSync({
    leilaoId: v.leilaoId, placa: v.placa, numeroVistoria: v.numeroVistoria,
    excludeLocalId: localVistoriaId, excludeExternalId: extResolved, excludeCloudVistoriaId: cloudId,
  });
  
  if (!dupUpd.ok) {
    // Correção do TypeScript usando Extract
    const errDupUpd = dupUpd as Extract<DuplicateCheckResult, { ok: false }>;
    await updateVistoria(localVistoriaId, {
      statusSync: 'conflito_duplicidade', syncMessage: errDupUpd.message, duplicateType: errDupUpd.type, duplicateInfo: errDupUpd.info, duplicateConflictWith: errDupUpd.conflictWith,
    });
    await recalculateDuplicateVistoriasForLeilao(v.leilaoId);
    return false;
  }

  const patch: Record<string, unknown> = {
    placa: v.placa, num_vistoria: v.numeroVistoria, vistoriador: v.vistoriador, url_foto: urlFoto,
  };

  const { data: after, error: upErr } = await supabase.from('vistorias').update(patch).eq('id', cloudId).select('id, updated_at').maybeSingle();
  if (upErr) return false;

  const afterRow = after as { id?: string; updated_at?: string | null } | null;
  const newMs = supabaseTimestampToMs(afterRow?.updated_at);
  await updateVistoria(localVistoriaId, {
    statusSync: 'sincronizado', updatedAt: newMs > 0 ? newMs : Date.now(), cloudVistoriaId: String(afterRow?.id || ex.id), fotoUploadFailed: false, ...clearedDuplicateFields,
  });
  return true;
}