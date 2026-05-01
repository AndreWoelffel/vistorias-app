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
  if (leilao.supabaseId != null) return leilao.supabaseId;

  const snap = await getCreatedBySnapshot();
  const createdBy = leilao.createdBy?.trim() || snap.displayName;

  const { data, error } = await supabase
    .from('leiloes')
    .insert({ nome: leilao.nome, created_by: createdBy })
    .select('id, updated_at')
    .maybeSingle();

  if (error || data?.id == null) return null;

  const sid = Number(data.id);
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
): Promise<{ ok: boolean; rowCount: number }> {
  const leilao = await getLeilaoById(localLeilaoId);
  if (!leilao) return { ok: false, rowCount: 0 };
  const fk = leilao.supabaseId;
  if (fk == null) return { ok: false, rowCount: 0 };

  const { data, error } = await supabase
    .from('vistorias_com_leilao')
    .select('*')
    .eq('leilao_id', fk)
    .order('created_at', { ascending: false });

  if (error) return { ok: false, rowCount: 0 };

  const rows = (data ?? []) as Record<string, unknown>[];
  await mergeVistoriasFromCloudRows(localLeilaoId, rows);
  return { ok: true, rowCount: rows.length };
}

const STORAGE_BUCKET = 'fotos-vistorias';

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

export async function findLocalDuplicateVistoria(
  leilaoId: number,
  placa: string,
  numeroVistoria: string,
  excludeLocalId?: number,
): Promise<Vistoria | undefined> {
  const list = await getVistoriasByLeilao(leilaoId, { includePendingCloudDelete: true });
  const p = normPlaca(placa);
  const n = normNumVistoria(numeroVistoria);
  for (const v of list) {
    if (excludeLocalId != null && v.id === excludeLocalId) continue;
    if (normPlaca(v.placa) === p || normNumVistoria(v.numeroVistoria) === n) return v;
  }
  return undefined;
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

  const { data: rowPlaca } = await supabase.from('vistorias_com_leilao').select('id, external_id').eq('leilao_id', fk).eq('placa', p).maybeSingle();
  const { data: rowNum } = await supabase.from('vistorias_com_leilao').select('id, external_id').eq('leilao_id', fk).eq('num_vistoria', n).maybeSingle();

  const rp = rowPlaca as { id?: string; external_id?: string | null } | null;
  const rn = rowNum as { id?: string; external_id?: string | null } | null;

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

type UploadFotoResult = { url: string | null; uploadFailed: boolean };

async function uploadOptionalFoto(placa: string, file: File | Blob | null | undefined): Promise<UploadFotoResult> {
  if (!file || file.size <= 0) return { url: null, uploadFailed: false };
  const timestamp = new Date().getTime();
  const fileName = `${placa.replace(/\s/g, '')}_${timestamp}.jpg`;

  const { error: storageError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(`placas/${fileName}`, file, { contentType: 'image/jpeg', upsert: false });

  if (storageError) return { url: null, uploadFailed: true };
  const { data: publicUrlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(`placas/${fileName}`);
  return { url: publicUrlData.publicUrl, uploadFailed: false };
}

export interface InspectionData {
  placa: string;
  numero_vistoria: string;
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

function devLogVistoriaSync(tag: string, payload: Record<string, unknown>) {
  if (import.meta.env.DEV) console.debug(`[vistoria-sync] ${tag}`, payload);
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
        if (localVid != null) {
          await updateVistoria(localVid, { statusSync: 'sincronizado', updatedAt: serverMs || Date.now(), cloudVistoriaId: String(ex.id), ...clearedDuplicateFields });
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
      if (data.fotoFile && data.fotoFile.size > 0) {
        const up = await uploadOptionalFoto(data.placa, data.fotoFile);
        if (up.url) urlFoto = up.url;
        if (localVid != null && up.uploadFailed) await updateVistoria(localVid, { fotoUploadFailed: true });
      }

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

    const upRes = await uploadOptionalFoto(data.placa, data.fotoFile ?? null);
    if (localVid != null && upRes.uploadFailed) {
      await updateVistoria(localVid, { fotoUploadFailed: true });
    }

    const snap = await getCreatedBySnapshot();
    const createdBy = data.createdBy?.trim() || snap.displayName;

    const row: Record<string, unknown> = {
      placa: data.placa, num_vistoria: data.numero_vistoria, url_foto: upRes.url, baixado_pc: false, created_by: createdBy, external_id: extUuid,
    };
    if (data.vistoriador != null && data.vistoriador !== '') row.vistoriador = data.vistoriador;

    const { data: ins, error: dbError } = await supabase.from('vistorias').insert([row]).select('id, updated_at').maybeSingle();

    if (dbError) {
      if (isUniqueViolation(dbError)) return saveInspection(data);
      throw new Error(dbError.message);
    }

    const insRow = ins as { id?: string; updated_at?: string | null } | null;
    
    if (insRow?.id && fkToLink != null) {
      const { error: relError } = await supabase.from('vistorias_leiloes').insert({
        vistoria_id: insRow.id,
        leilao_id: fkToLink
      });
      if (relError && import.meta.env.DEV) {
         console.error("[Supabase] Falha ao vincular vistoria ao leilão:", relError.message);
      }
    }

    const insMs = supabaseTimestampToMs(insRow?.updated_at);
    if (localVid != null) {
      await updateVistoria(localVid, {
        statusSync: 'sincronizado', updatedAt: insMs > 0 ? insMs : Date.now(), cloudVistoriaId: String(insRow?.id), fotoUploadFailed: false, ...clearedDuplicateFields,
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
  if (ns0 === 'sincronizado') return 'ok';

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

  const foto = v.fotos?.[0];
  const ok = await saveInspection({
    placa: v.placa, numero_vistoria: v.numeroVistoria, fotoFile: foto && foto.size > 0 ? foto : null, leilaoId: v.leilaoId, vistoriador: v.vistoriador,
    createdBy: v.createdBy ?? undefined, createdByUserId: v.createdByUserId, localUuid, cloudVistoriaId: cloudId && isValidUuid(cloudId) ? cloudId : undefined, localVistoriaId, localUpdatedAtMs: v.updatedAt ?? new Date(v.createdAt).getTime(),
  });
  if (ok) return 'ok';
  
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
      await updateVistoria(localVistoriaId, { updatedAt: serverMs, cloudVistoriaId: String(ex.id) });
      return true;
    }
  }

  const foto = v.fotos?.[0];
  let urlFoto: string | null = ex.url_foto != null ? String(ex.url_foto) : null;
  if (foto && foto.size > 0) {
    const up = await uploadOptionalFoto(v.placa, foto);
    if (up.url) urlFoto = up.url;
    if (up.uploadFailed) await updateVistoria(localVistoriaId, { fotoUploadFailed: true });
  }

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