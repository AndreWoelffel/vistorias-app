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

/** Reexport: UUID local + coluna `external_id` na nuvem (mesmo valor do `localUuid` após garantia). */
export { isValidUuid, readStableUuid, ensureVistoriaLocalUuidIsUuid } from '@/lib/db';

type VistoriaCloudRow = {
  id?: string;
  updated_at?: string | null;
  placa?: string | null;
  num_vistoria?: string | null;
  vistoriador?: string | null;
  url_foto?: string | null;
};

/** Resolve o id do leilão na nuvem (FK) a partir do id local; tenta criar na nuvem se ainda não existir. */
async function ensureLeilaoSupabaseId(localLeilaoId: number): Promise<number | null> {
  if (!Number.isFinite(localLeilaoId) || localLeilaoId <= 0) return null;
  const leilao = await getLeilaoById(localLeilaoId);
  if (!leilao) return null;
  if (leilao.supabaseId != null) return leilao.supabaseId;

  const snap = await getCreatedBySnapshot();
  const createdBy = leilao.createdBy?.trim() || snap.displayName;

  const { data, error } = await supabase
    .from('leiloes')
    .insert({
      nome: leilao.nome,
      created_by: createdBy,
    })
    .select('id, updated_at')
    .maybeSingle();

  if (error) {
    console.error('[Supabase] Erro ao criar leilão (ensure FK):', error);
  }
  if (error || data?.id == null) {
    if (import.meta.env.DEV) {
      console.warn("[Supabase] Leilão não sincronizado na nuvem:", error?.message);
    }
    return null;
  }

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
    if (import.meta.env.DEV) {
      console.warn("[IDB] Falha ao gravar supabaseId no leilão local:", e);
    }
  }
  return sid;
}

/**
 * Busca todas as vistorias do leilão na nuvem e mescla no IndexedDB (Histórico / lista oficial).
 * Sem `supabaseId` no leilão local, não há consulta — use só o cache local.
 */
export async function fetchAndMergeVistoriasFromCloudForLeilao(
  localLeilaoId: number,
): Promise<{ ok: boolean; rowCount: number }> {
  const leilao = await getLeilaoById(localLeilaoId);
  if (!leilao) return { ok: false, rowCount: 0 };
  const fk = leilao.supabaseId;
  if (fk == null) return { ok: false, rowCount: 0 };

  const { data, error } = await supabase
    .from('vistorias')
    .select('*')
    .eq('leilao', fk)
    .order('created_at', { ascending: false });

  if (error) {
    if (import.meta.env.DEV) {
      console.warn('[Supabase] fetch vistorias do leilão:', error.message);
    }
    return { ok: false, rowCount: 0 };
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  await mergeVistoriasFromCloudRows(localLeilaoId, rows);
  return { ok: true, rowCount: rows.length };
}

/** Bucket público no Supabase Storage */
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
      /** Outra vistoria local que colide (quando há match). */
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

/** Mensagem curta para o usuário conforme o tipo de duplicidade. */
export function duplicateUserMessage(type: VistoriaDuplicateType): string {
  switch (type) {
    case 'placa':
      return 'Já existe vistoria com esta placa';
    case 'numero':
      return 'Já existe vistoria com este número';
    case 'ambos':
      return 'Já existe vistoria com esta placa e número';
  }
}

/** Texto do badge / chips do painel. */
export function duplicateTypeShortLabel(type: VistoriaDuplicateType): string {
  switch (type) {
    case 'placa':
      return 'Duplicado (placa)';
    case 'numero':
      return 'Duplicado (número)';
    case 'ambos':
      return 'Duplicado (placa + número)';
  }
}

/** Legenda com valores em conflito (dashboard). */
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

/**
 * Analisa duplicidade local: placa, número ou ambos (outro registro no mesmo leilão).
 */
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
  const type: VistoriaDuplicateType =
    conflictP && conflictN ? 'ambos' : conflictP ? 'placa' : 'numero';

  const candidates = list.filter((v) => v.id != null && v.id !== excludeLocalId) as (Vistoria & {
    id: number;
  })[];
  let peer: (Vistoria & { id: number }) | undefined;
  const both = candidates.find(
    (v) => normPlaca(v.placa) === p && normNumVistoria(v.numeroVistoria) === n,
  );
  if (both) peer = both;
  else if (type === 'placa' || type === 'ambos')
    peer = candidates.find((v) => normPlaca(v.placa) === p);
  else peer = candidates.find((v) => normNumVistoria(v.numeroVistoria) === n);

  return {
    duplicate: true,
    type,
    info: buildDuplicateInfo(type, p, n),
    conflictWith: peer ? vistoriaToConflictPeer(peer) : undefined,
  };
}

/**
 * Outra vistoria no mesmo leilão com mesma placa ou mesmo número (exclui o registro atual).
 * @deprecated Preferir `analyzeLocalDuplicateVistoria` para tipo e mensagem.
 */
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
    const samePlaca = normPlaca(v.placa) === p;
    const sameNum = normNumVistoria(v.numeroVistoria) === n;
    if (samePlaca || sameNum) return v;
  }
  return undefined;
}

/**
 * Conflito se houver duplicidade local ou na nuvem (mesmo leilão).
 */
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
  /** external_id (UUID) da própria linha, se aplicável */
  excludeExternalId?: string;
  /** id (uuid PK) da própria linha na nuvem — preferir quando existir */
  excludeCloudVistoriaId?: string;
}): Promise<DuplicateCheckResult> {
  const local = await analyzeLocalDuplicateVistoria(
    opts.leilaoId,
    opts.placa,
    opts.numeroVistoria,
    opts.excludeLocalId,
  );
  if (local.duplicate) {
    return {
      ok: false,
      type: local.type,
      message: duplicateUserMessage(local.type),
      info: local.info,
      conflictWith: local.conflictWith,
    };
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: true };
  }

  const fk = await ensureLeilaoSupabaseId(opts.leilaoId);
  if (fk == null) return { ok: true };

  const p = normPlaca(opts.placa);
  const n = normNumVistoria(opts.numeroVistoria);
  const extEx = opts.excludeExternalId?.trim() || '';
  const cloudEx = opts.excludeCloudVistoriaId?.trim() || '';

  const { data: rowPlaca } = await supabase
    .from('vistorias')
    .select('id, external_id')
    .eq('leilao', fk)
    .eq('placa', p)
    .maybeSingle();

  const { data: rowNum } = await supabase
    .from('vistorias')
    .select('id, external_id')
    .eq('leilao', fk)
    .eq('num_vistoria', n)
    .maybeSingle();

  const rp = rowPlaca as { id?: string; external_id?: string | null } | null;
  const rn = rowNum as { id?: string; external_id?: string | null } | null;

  const conflictPlaca = rp != null && !cloudRowIsSelf(rp, extEx, cloudEx);
  const conflictNum = rn != null && !cloudRowIsSelf(rn, extEx, cloudEx);

  if (!conflictPlaca && !conflictNum) return { ok: true };

  const type: VistoriaDuplicateType =
    conflictPlaca && conflictNum ? 'ambos' : conflictPlaca ? 'placa' : 'numero';
  return {
    ok: false,
    type,
    message: duplicateUserMessage(type),
    info: buildDuplicateInfo(type, p, n),
  };
}

/** Limpa metadados de duplicidade após sync bem-sucedido ou correção. */
const clearedDuplicateFields = {
  syncMessage: undefined as string | undefined,
  duplicateType: undefined as VistoriaDuplicateType | undefined,
  duplicateInfo: undefined as VistoriaDuplicateInfo | undefined,
  duplicateConflictWith: undefined as VistoriaDuplicateConflictPeer | undefined,
  duplicateConflictWithList: undefined as VistoriaDuplicateConflictPeer[] | undefined,
};

function vistoriaToConflictPeer(v: Vistoria): VistoriaDuplicateConflictPeer {
  return {
    localVistoriaId: v.id as number,
    placa: v.placa,
    numeroVistoria: v.numeroVistoria,
    createdBy: v.createdBy ?? null,
    createdAt: v.createdAt,
  };
}

type UploadFotoResult = { url: string | null; uploadFailed: boolean };

async function uploadOptionalFoto(
  placa: string,
  file: File | Blob | null | undefined,
): Promise<UploadFotoResult> {
  if (!file || file.size <= 0) return { url: null, uploadFailed: false };
  const timestamp = new Date().getTime();
  const fileName = `${placa.replace(/\s/g, '')}_${timestamp}.jpg`;

  const { error: storageError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(`placas/${fileName}`, file, {
      contentType: 'image/jpeg',
      upsert: false,
    });

  if (storageError) {
    if (import.meta.env.DEV) {
      console.warn("[Supabase] Upload da foto falhou (continuando sem URL):", storageError.message);
    }
    return { url: null, uploadFailed: true };
  }
  const { data: publicUrlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(`placas/${fileName}`);
  return { url: publicUrlData.publicUrl, uploadFailed: false };
}

export interface InspectionData {
  placa: string;
  numero_vistoria: string;
  /** Primeira foto extra; se ausente, grava linha sem URL de imagem */
  fotoFile?: File | Blob | null;
  leilaoId?: number;
  vistoriador?: string;
  /** Se omitido, usa getCreatedBySnapshot() no envio ao Supabase. */
  createdBy?: string;
  createdByUserId?: string | null;
  /** Mesmo valor enviado como `external_id` no Supabase — deve ser UUID válido. */
  localUuid?: string;
  /** PK em `public.vistorias` quando já existe linha na nuvem — priorizado em SELECT/UPDATE. */
  cloudVistoriaId?: string;
  /** Conflito LWW: id local no IndexedDB */
  localVistoriaId?: number;
  /** Conflito LWW: `updatedAt` local (ms) antes do envio */
  localUpdatedAtMs?: number;
}

function devLogVistoriaSync(tag: string, payload: Record<string, unknown>) {
  if (import.meta.env.DEV) {
    console.debug(`[vistoria-sync] ${tag}`, payload);
  }
}

/**
 * Envia a vistoria ao Supabase (Storage opcional + insert ou update com resolução de conflito).
 * Linhas já na nuvem são resolvidas por `cloudVistoriaId` (PK) ou por `external_id` só se for UUID válido.
 */
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
    if (!extUuid) {
      devLogVistoriaSync('saveInspection abort', {
        reason: 'sem UUID válido para external_id',
        localId: localVid,
        cloudVistoriaId: cloudHint,
      });
      return false;
    }

    const localMs = data.localUpdatedAtMs ?? 0;
    const selectCols = 'id, updated_at, placa, num_vistoria, vistoriador, url_foto, leilao';

    let existing: VistoriaCloudRow | null = null;

    if (cloudHint && isValidUuid(cloudHint)) {
      const r = await supabase.from('vistorias').select(selectCols).eq('id', cloudHint).maybeSingle();
      devLogVistoriaSync('saveInspection select', {
        operacao: 'resolve',
        filtroSupabase: 'id',
        valorFiltro: cloudHint,
        erro: r.error?.message,
        encontrou: Boolean((r.data as VistoriaCloudRow | null)?.id),
      });
      if (r.error) {
        console.error('[Supabase] Falha ao ler vistoria (id):', r.error);
        return false;
      }
      existing = r.data as VistoriaCloudRow | null;
    }

    if (!existing?.id) {
      const r = await supabase
        .from('vistorias')
        .select(selectCols)
        .eq('external_id', extUuid)
        .maybeSingle();
      devLogVistoriaSync('saveInspection select', {
        operacao: 'resolve',
        filtroSupabase: 'external_id',
        valorFiltro: extUuid,
        erro: r.error?.message,
        encontrou: Boolean((r.data as VistoriaCloudRow | null)?.id),
      });
      if (r.error) {
        console.error('[Supabase] Falha ao ler vistoria (external_id):', r.error);
        return false;
      }
      existing = r.data as VistoriaCloudRow | null;
    }

    const ex = existing as VistoriaCloudRow | null;
    const cloudRowId = ex?.id != null ? String(ex.id) : '';
    const operation: 'create' | 'update' = cloudRowId ? 'update' : 'create';
    devLogVistoriaSync('saveInspection', {
      localId: localVid,
      cloudVistoriaId: cloudHint,
      external_id: extUuid,
      operation,
      cloudRowId: cloudRowId || undefined,
    });

    const dupExcludeCloud =
      cloudRowId ||
      (cloudHint && isValidUuid(cloudHint) ? cloudHint : undefined);

    if (ex?.id != null) {
      const serverMs = supabaseTimestampToMs(ex.updated_at);

      if (serverMs === localMs) {
        if (localVid != null) {
          await updateVistoria(localVid, {
            statusSync: 'sincronizado',
            updatedAt: serverMs || Date.now(),
            cloudVistoriaId: ex.id != null ? String(ex.id) : undefined,
            ...clearedDuplicateFields,
          });
        }
        devLogVistoriaSync('saveInspection skip-update', { motivo: 'timestamp igual', cloudRowId });
        return true;
      }

      logSyncConflict({
        entity: 'vistoria',
        fluxo: 'create/sync',
        external_id: extUuid,
        localVistoriaId: localVid,
        serverMs,
        localMs,
        resolucao: serverMs > localMs ? 'servidor (sobrescreve local)' : 'local (envia update)',
      });

      if (serverMs > localMs) {
        if (localVid != null) {
          await updateVistoria(localVid, {
            placa: String(ex.placa ?? ''),
            numeroVistoria: String(ex.num_vistoria ?? ''),
            vistoriador: String(ex.vistoriador ?? ''),
            statusSync: 'sincronizado',
            updatedAt: serverMs,
            cloudVistoriaId: ex.id != null ? String(ex.id) : undefined,
            ...clearedDuplicateFields,
          });
        }
        return true;
      }

      let urlFoto: string | null = ex.url_foto != null ? String(ex.url_foto) : null;
      if (data.fotoFile && data.fotoFile.size > 0) {
        const up = await uploadOptionalFoto(data.placa, data.fotoFile);
        if (up.url) urlFoto = up.url;
        if (localVid != null && up.uploadFailed) {
          await updateVistoria(localVid, { fotoUploadFailed: true });
        }
      }

      const snap = await getCreatedBySnapshot();
      const createdBy = data.createdBy?.trim() || snap.displayName;
      const patch: Record<string, unknown> = {
        placa: data.placa,
        num_vistoria: data.numero_vistoria,
        url_foto: urlFoto,
        created_by: createdBy,
      };
      if (data.vistoriador != null && data.vistoriador !== '') patch.vistoriador = data.vistoriador;
      if (data.leilaoId != null) {
        const fk = await ensureLeilaoSupabaseId(data.leilaoId);
        if (fk == null) {
          if (import.meta.env.DEV) {
            console.warn(
              "[Supabase] Vistoria não atualizada: leilão sem correspondência na nuvem (evita erro de FK).",
            );
          }
          return false;
        }
        patch.leilao = fk;
      }

      if (data.leilaoId != null && localVid != null) {
        const dup = await assertNoDuplicateVistoriaForSync({
          leilaoId: data.leilaoId,
          placa: data.placa,
          numeroVistoria: data.numero_vistoria,
          excludeLocalId: localVid,
          excludeExternalId: extUuid,
          excludeCloudVistoriaId: dupExcludeCloud,
        });
        if (!dup.ok) {
          await updateVistoria(localVid, {
            statusSync: 'conflito_duplicidade',
            syncMessage: dup.message,
            duplicateType: dup.type,
            duplicateInfo: dup.info,
            duplicateConflictWith: dup.conflictWith,
          });
          if (data.leilaoId != null) await recalculateDuplicateVistoriasForLeilao(data.leilaoId);
          return false;
        }
      }

      devLogVistoriaSync('saveInspection update', {
        filtroSupabase: 'id',
        valorFiltro: cloudRowId,
        payload: patch,
      });

      const { data: after, error: upErr } = await supabase
        .from('vistorias')
        .update(patch)
        .eq('id', cloudRowId)
        .select('id, updated_at')
        .maybeSingle();

      devLogVistoriaSync('saveInspection update resposta', {
        erro: upErr?.message,
        data: after,
      });

      if (upErr) throw new Error(upErr.message);
      const afterRow = after as { id?: string; updated_at?: string | null } | null;
      const newMs = supabaseTimestampToMs(afterRow?.updated_at);
      if (localVid != null) {
        await updateVistoria(localVid, {
          statusSync: 'sincronizado',
          updatedAt: newMs > 0 ? newMs : Date.now(),
          cloudVistoriaId: afterRow?.id != null ? String(afterRow.id) : ex.id != null ? String(ex.id) : undefined,
          fotoUploadFailed: false,
          ...clearedDuplicateFields,
        });
      }
      return true;
    }

    if (data.leilaoId != null && localVid != null) {
      const dupIns = await assertNoDuplicateVistoriaForSync({
        leilaoId: data.leilaoId,
        placa: data.placa,
        numeroVistoria: data.numero_vistoria,
        excludeLocalId: localVid,
        excludeExternalId: extUuid,
        excludeCloudVistoriaId: dupExcludeCloud,
      });
      if (!dupIns.ok) {
        await updateVistoria(localVid, {
          statusSync: 'conflito_duplicidade',
          syncMessage: dupIns.message,
          duplicateType: dupIns.type,
          duplicateInfo: dupIns.info,
          duplicateConflictWith: dupIns.conflictWith,
        });
        if (data.leilaoId != null) await recalculateDuplicateVistoriasForLeilao(data.leilaoId);
        return false;
      }
    }

    const upRes = await uploadOptionalFoto(data.placa, data.fotoFile ?? null);
    const urlFoto = upRes.url;
    if (localVid != null && upRes.uploadFailed) {
      await updateVistoria(localVid, { fotoUploadFailed: true });
    }

    const snap = await getCreatedBySnapshot();
    const createdBy = data.createdBy?.trim() || snap.displayName;

    const row: Record<string, unknown> = {
      placa: data.placa,
      num_vistoria: data.numero_vistoria,
      url_foto: urlFoto,
      baixado_pc: false,
      created_by: createdBy,
      external_id: extUuid,
    };

    if (data.leilaoId != null) {
      const fk = await ensureLeilaoSupabaseId(data.leilaoId);
      if (fk == null) {
        if (import.meta.env.DEV) {
          console.warn(
            "[Supabase] Vistoria não enviada: leilão sem correspondência na nuvem (evita erro de FK). Sincronize o leilão ou verifique a conexão.",
          );
        }
        return false;
      }
      row.leilao = fk;
    }
    if (data.vistoriador != null && data.vistoriador !== '') row.vistoriador = data.vistoriador;

    devLogVistoriaSync('saveInspection insert', { payload: row });

    const { data: ins, error: dbError } = await supabase
      .from('vistorias')
      .insert([row])
      .select('id, updated_at')
      .maybeSingle();

    devLogVistoriaSync('saveInspection insert resposta', { erro: dbError?.message, data: ins });

    if (dbError) {
      if (isUniqueViolation(dbError)) {
        if (import.meta.env.DEV) {
          console.warn(
            "[Supabase] Conflito único external_id (corrida); reaplicando resolução LWW:",
            extUuid,
            dbError.message,
          );
        }
        return saveInspection(data);
      }
      throw new Error(dbError.message);
    }

    const insRow = ins as { id?: string; updated_at?: string | null } | null;
    const insMs = supabaseTimestampToMs(insRow?.updated_at);
    if (localVid != null) {
      await updateVistoria(localVid, {
        statusSync: 'sincronizado',
        updatedAt: insMs > 0 ? insMs : Date.now(),
        cloudVistoriaId: insRow?.id != null ? String(insRow.id) : undefined,
        fotoUploadFailed: false,
        ...clearedDuplicateFields,
      });
    }

    if (import.meta.env.DEV) {
      console.log("[Supabase] Vistoria gravada na nuvem.");
    }
    return true;
  } catch (error) {
    console.error("[Supabase] Erro ao salvar vistoria:", error);
    devLogVistoriaSync('saveInspection catch', { erro: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export type SyncInspectionFromLocalResult = 'ok' | 'fail' | 'duplicate';

/**
 * Envia ao Supabase uma vistoria já persistida no IndexedDB (fila offline).
 */
export async function syncInspectionFromLocal(
  localVistoriaId: number,
): Promise<SyncInspectionFromLocalResult> {
  const v = await getVistoriaById(localVistoriaId);
  if (!v) {
    if (import.meta.env.DEV) {
      console.warn("[sync] Vistoria não encontrada:", localVistoriaId);
    }
    return 'fail';
  }
  const ns0 = normalizeVistoriaStatusSync(v.statusSync);
  if (ns0 === 'aguardando_ajuste' || ns0 === 'conflito_duplicidade') {
    return 'duplicate';
  }
  if (ns0 === 'sincronizado') {
    return 'ok';
  }

  const localUuid = readStableUuid(v);
  if (!localUuid || !isValidUuid(localUuid)) {
    if (import.meta.env.DEV) {
      console.warn('[sync] syncInspectionFromLocal: localUuid inválido após correção', localVistoriaId);
    }
    return 'fail';
  }

  const cloudId = v.cloudVistoriaId?.trim();
  devLogVistoriaSync('syncInspectionFromLocal', {
    localId: localVistoriaId,
    cloudVistoriaId: cloudId,
    external_id: localUuid,
  });

  const dupSync = await assertNoDuplicateVistoriaForSync({
    leilaoId: v.leilaoId,
    placa: v.placa,
    numeroVistoria: v.numeroVistoria,
    excludeLocalId: localVistoriaId,
    excludeExternalId: localUuid,
    excludeCloudVistoriaId: cloudId && isValidUuid(cloudId) ? cloudId : undefined,
  });
  if (!dupSync.ok) {
    await updateVistoria(localVistoriaId, {
      statusSync: 'conflito_duplicidade',
      syncMessage: dupSync.message,
      duplicateType: dupSync.type,
      duplicateInfo: dupSync.info,
      duplicateConflictWith: dupSync.conflictWith,
    });
    await recalculateDuplicateVistoriasForLeilao(v.leilaoId);
    return 'duplicate';
  }

  const foto = v.fotos?.[0];
  const localUpdatedAtMs = v.updatedAt ?? new Date(v.createdAt).getTime();

  const ok = await saveInspection({
    placa: v.placa,
    numero_vistoria: v.numeroVistoria,
    fotoFile: foto && foto.size > 0 ? foto : null,
    leilaoId: v.leilaoId,
    vistoriador: v.vistoriador,
    createdBy: v.createdBy ?? undefined,
    createdByUserId: v.createdByUserId,
    localUuid,
    cloudVistoriaId: cloudId && isValidUuid(cloudId) ? cloudId : undefined,
    localVistoriaId: localVistoriaId,
    localUpdatedAtMs,
  });
  if (ok) return 'ok';
  const v2 = await getVistoriaById(localVistoriaId);
  const ns2 = normalizeVistoriaStatusSync(v2?.statusSync);
  if (ns2 === 'conflito_duplicidade' || ns2 === 'aguardando_ajuste') return 'duplicate';
  return 'fail';
}

/**
 * Propaga edição local de vistoria já sincronizada (fila `vistoria/update`).
 */
export async function syncVistoriaUpdateToCloud(localVistoriaId: number): Promise<boolean> {
  const v = await getVistoriaById(localVistoriaId);
  if (!v) {
    if (import.meta.env.DEV) {
      console.warn("[sync] Vistoria não encontrada:", localVistoriaId);
    }
    return false;
  }

  const cloudId = v.cloudVistoriaId?.trim();
  const ns = normalizeVistoriaStatusSync(v.statusSync);
  if (
    ns === 'aguardando_ajuste' ||
    ns === 'conflito_duplicidade' ||
    ns === 'rascunho' ||
    v.pendingCloudDelete
  ) {
    return false;
  }
  if (!cloudId || !isValidUuid(cloudId)) {
    if (import.meta.env.DEV) {
      console.warn('[sync] vistoria/update: sem cloudVistoriaId UUID — use fluxo create.', localVistoriaId);
    }
    return false;
  }

  const extResolved = readStableUuid(v);
  if (!extResolved || !isValidUuid(extResolved)) {
    if (import.meta.env.DEV) {
      console.warn("[sync] Vistoria sem localUuid UUID; não é possível checar duplicidade.");
    }
    return false;
  }

  devLogVistoriaSync('syncVistoriaUpdateToCloud início', {
    localId: localVistoriaId,
    cloudVistoriaId: cloudId,
    external_id: extResolved,
    operacao: 'update',
  });

  const { data: serverRow, error } = await supabase
    .from('vistorias')
    .select('id, updated_at, placa, num_vistoria, vistoriador, url_foto')
    .eq('id', cloudId)
    .maybeSingle();

  if (error) {
    console.error('[sync] Erro detalhado:', error);
    if (import.meta.env.DEV) {
      console.debug('[sync] vistoria/update fetch', { localVistoriaId, cloudId, error });
    }
    return false;
  }

  const ex = serverRow as VistoriaCloudRow | null;
  if (ex?.id == null) {
    if (import.meta.env.DEV) {
      console.warn("[sync] Linha não encontrada no Supabase (id):", cloudId);
    }
    return false;
  }

  const serverMs = supabaseTimestampToMs(ex.updated_at);
  const localMs = v.updatedAt ?? new Date(v.createdAt).getTime();

  if (serverMs !== localMs) {
    logSyncConflict({
      entity: 'vistoria',
      fluxo: 'update',
      localVistoriaId,
      external_id: extResolved,
      serverMs,
      localMs,
      resolucao: serverMs > localMs ? 'servidor (sobrescreve local)' : 'local (envia update)',
    });
  }

  if (serverMs > localMs) {
    await updateVistoria(localVistoriaId, {
      placa: String(ex.placa ?? ''),
      numeroVistoria: String(ex.num_vistoria ?? ''),
      vistoriador: String(ex.vistoriador ?? ''),
      updatedAt: serverMs,
      cloudVistoriaId: ex.id != null ? String(ex.id) : undefined,
    });
    return true;
  }

  if (serverMs === localMs) {
    const sameText =
      String(ex.placa ?? '').trim() === String(v.placa ?? '').trim() &&
      String(ex.num_vistoria ?? '').trim() === String(v.numeroVistoria ?? '').trim() &&
      String(ex.vistoriador ?? '').trim() === String(v.vistoriador ?? '').trim();
    if (sameText) {
      await updateVistoria(localVistoriaId, {
        updatedAt: serverMs,
        cloudVistoriaId: ex.id != null ? String(ex.id) : undefined,
      });
      return true;
    }
    logSyncConflict({
      entity: 'vistoria',
      fluxo: 'update',
      localVistoriaId,
      external_id: extResolved,
      serverMs,
      localMs,
      resolucao: 'empate de timestamp; conteúdo difere — prioriza local (update)',
    });
  }

  const foto = v.fotos?.[0];
  let urlFoto: string | null = ex.url_foto != null ? String(ex.url_foto) : null;
  if (foto && foto.size > 0) {
    const up = await uploadOptionalFoto(v.placa, foto);
    if (up.url) urlFoto = up.url;
    if (up.uploadFailed) {
      await updateVistoria(localVistoriaId, { fotoUploadFailed: true });
    }
  }

  const dupUpd = await assertNoDuplicateVistoriaForSync({
    leilaoId: v.leilaoId,
    placa: v.placa,
    numeroVistoria: v.numeroVistoria,
    excludeLocalId: localVistoriaId,
    excludeExternalId: extResolved,
    excludeCloudVistoriaId: cloudId,
  });
  if (!dupUpd.ok) {
    await updateVistoria(localVistoriaId, {
      statusSync: 'conflito_duplicidade',
      syncMessage: dupUpd.message,
      duplicateType: dupUpd.type,
      duplicateInfo: dupUpd.info,
      duplicateConflictWith: dupUpd.conflictWith,
    });
    await recalculateDuplicateVistoriasForLeilao(v.leilaoId);
    return false;
  }

  const patch: Record<string, unknown> = {
    placa: v.placa,
    num_vistoria: v.numeroVistoria,
    vistoriador: v.vistoriador,
    url_foto: urlFoto,
  };

  devLogVistoriaSync('syncVistoriaUpdateToCloud update', {
    filtroSupabase: 'id',
    valorFiltro: cloudId,
    payload: patch,
  });

  const { data: after, error: upErr } = await supabase
    .from('vistorias')
    .update(patch)
    .eq('id', cloudId)
    .select('id, updated_at')
    .maybeSingle();

  if (upErr) {
    console.error('[sync] Erro detalhado:', upErr);
    devLogVistoriaSync('syncVistoriaUpdateToCloud resposta', {
      localId: localVistoriaId,
      cloudVistoriaId: cloudId,
      erro: upErr.message,
    });
    return false;
  }

  devLogVistoriaSync('syncVistoriaUpdateToCloud resposta', {
    localId: localVistoriaId,
    cloudVistoriaId: cloudId,
    data: after,
  });

  const afterRow = after as { id?: string; updated_at?: string | null } | null;
  const newMs = supabaseTimestampToMs(afterRow?.updated_at);
  await updateVistoria(localVistoriaId, {
    statusSync: 'sincronizado',
    updatedAt: newMs > 0 ? newMs : Date.now(),
    cloudVistoriaId:
      afterRow?.id != null ? String(afterRow.id) : ex.id != null ? String(ex.id) : undefined,
    fotoUploadFailed: false,
    ...clearedDuplicateFields,
  });
  return true;
}
