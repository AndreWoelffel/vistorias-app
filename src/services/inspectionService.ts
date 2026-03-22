// src/services/inspectionService.ts
/**
 * Ao adicionar `supabase.from(...).select(...)`, trate sempre `data` como possivelmente null:
 * `const { data, error } = await supabase.from('t').select(); const rows = data ?? [];`
 */
import { supabase } from './supabaseClient';
import { getLeilaoById, getVistoriaById, updateLeilao, updateVistoria, type Vistoria } from '@/lib/db';
import { getCreatedBySnapshot } from '@/services/currentUserService';
import { logSyncConflict, supabaseTimestampToMs } from '@/services/syncConflict';

function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === '23505';
}

/** Registros antigos no IndexedDB podem ter `externalId` em vez de `localUuid`. */
export function readStableUuid(v: Vistoria): string | undefined {
  const fromNew = v.localUuid?.trim();
  if (fromNew) return fromNew;
  const legacy = (v as { externalId?: string }).externalId?.trim();
  return legacy || undefined;
}

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

/** Bucket público no Supabase Storage */
const STORAGE_BUCKET = 'fotos-vistorias';

async function uploadOptionalFoto(placa: string, file: File | Blob | null | undefined): Promise<string | null> {
  if (!file || file.size <= 0) return null;
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
    return null;
  }
  const { data: publicUrlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(`placas/${fileName}`);
  return publicUrlData.publicUrl;
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
  /** Mesmo valor enviado como `external_id` (text) no Supabase — idempotência. */
  localUuid?: string;
  /** Conflito LWW: id local no IndexedDB */
  localVistoriaId?: number;
  /** Conflito LWW: `updatedAt` local (ms) antes do envio */
  localUpdatedAtMs?: number;
}

/**
 * Envia a vistoria ao Supabase (Storage opcional + insert ou update com resolução de conflito).
 */
export async function saveInspection(data: InspectionData): Promise<boolean> {
  try {
    if (import.meta.env.DEV) {
      console.log(`[Supabase] Salvando vistoria na nuvem: ${data.placa}`);
    }

    const ext = data.localUuid?.trim();
    if (!ext) {
      if (import.meta.env.DEV) {
        console.warn("[Supabase] localUuid ausente — idempotência não garantida; abortando envio.");
      }
      return false;
    }

    const localMs = data.localUpdatedAtMs ?? 0;
    const localVid = data.localVistoriaId;

    const { data: existing, error: selErr } = await supabase
      .from('vistorias')
      .select('id, updated_at, placa, num_vistoria, vistoriador, url_foto, leilao')
      .eq('external_id', ext)
      .maybeSingle();

    if (selErr) {
      console.error('[Supabase] Falha ao ler vistoria (external_id):', selErr);
      return false;
    }

    const ex = existing as VistoriaCloudRow | null;
    if (ex?.id != null) {
      const serverMs = supabaseTimestampToMs(ex.updated_at);

      if (serverMs === localMs) {
        if (localVid != null) {
          await updateVistoria(localVid, {
            statusSync: 'sincronizado',
            updatedAt: serverMs || Date.now(),
            cloudVistoriaId: ex.id != null ? String(ex.id) : undefined,
          });
        }
        return true;
      }

      logSyncConflict({
        entity: 'vistoria',
        fluxo: 'create/sync',
        external_id: ext,
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
          });
        }
        return true;
      }

      let urlFoto: string | null = ex.url_foto != null ? String(ex.url_foto) : null;
      if (data.fotoFile && data.fotoFile.size > 0) {
        const up = await uploadOptionalFoto(data.placa, data.fotoFile);
        if (up) urlFoto = up;
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

      const { data: after, error: upErr } = await supabase
        .from('vistorias')
        .update(patch)
        .eq('external_id', ext)
        .select('id, updated_at')
        .maybeSingle();

      if (upErr) throw new Error(upErr.message);
      const afterRow = after as { id?: string; updated_at?: string | null } | null;
      const newMs = supabaseTimestampToMs(afterRow?.updated_at);
      if (localVid != null) {
        await updateVistoria(localVid, {
          statusSync: 'sincronizado',
          updatedAt: newMs > 0 ? newMs : Date.now(),
          cloudVistoriaId: afterRow?.id != null ? String(afterRow.id) : ex.id != null ? String(ex.id) : undefined,
        });
      }
      return true;
    }

    const urlFoto = await uploadOptionalFoto(data.placa, data.fotoFile ?? null);

    const snap = await getCreatedBySnapshot();
    const createdBy = data.createdBy?.trim() || snap.displayName;

    const row: Record<string, unknown> = {
      placa: data.placa,
      num_vistoria: data.numero_vistoria,
      url_foto: urlFoto,
      baixado_pc: false,
      created_by: createdBy,
      external_id: ext,
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

    const { data: ins, error: dbError } = await supabase
      .from('vistorias')
      .insert([row])
      .select('id, updated_at')
      .maybeSingle();

    if (dbError) {
      if (isUniqueViolation(dbError)) {
        if (import.meta.env.DEV) {
          console.warn(
            "[Supabase] Conflito único external_id (corrida); reaplicando resolução LWW:",
            ext,
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
      });
    }

    if (import.meta.env.DEV) {
      console.log("[Supabase] Vistoria gravada na nuvem.");
    }
    return true;
  } catch (error) {
    console.error("[Supabase] Erro ao salvar vistoria:", error);
    return false;
  }
}

/**
 * Envia ao Supabase uma vistoria já persistida no IndexedDB (fila offline).
 */
export async function syncInspectionFromLocal(localVistoriaId: number): Promise<boolean> {
  const v = await getVistoriaById(localVistoriaId);
  if (!v) {
    if (import.meta.env.DEV) {
      console.warn("[sync] Vistoria não encontrada:", localVistoriaId);
    }
    return false;
  }
  if (v.statusSync === 'sincronizado') {
    return true;
  }

  let localUuid = readStableUuid(v);
  if (!localUuid) {
    localUuid =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `vis-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    await updateVistoria(localVistoriaId, { localUuid });
  }

  const foto = v.fotos?.[0];
  const localUpdatedAtMs = v.updatedAt ?? new Date(v.createdAt).getTime();

  return saveInspection({
    placa: v.placa,
    numero_vistoria: v.numeroVistoria,
    fotoFile: foto && foto.size > 0 ? foto : null,
    leilaoId: v.leilaoId,
    vistoriador: v.vistoriador,
    createdBy: v.createdBy ?? undefined,
    createdByUserId: v.createdByUserId,
    localUuid,
    localVistoriaId,
    localUpdatedAtMs,
  });
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
  if (v.statusSync !== 'sincronizado') {
    return false;
  }

  const ext = readStableUuid(v);
  if (!ext) {
    if (import.meta.env.DEV) {
      console.warn("[sync] Vistoria sem external_id/localUuid; não é possível atualizar na nuvem.");
    }
    return false;
  }

  const { data: serverRow, error } = await supabase
    .from('vistorias')
    .select('id, updated_at, placa, num_vistoria, vistoriador, url_foto')
    .eq('external_id', ext)
    .maybeSingle();

  if (error) {
    console.error('[sync] Erro detalhado:', error);
    return false;
  }

  const ex = serverRow as VistoriaCloudRow | null;
  if (ex?.id == null) {
    if (import.meta.env.DEV) {
      console.warn("[sync] Linha não encontrada no Supabase (external_id):", ext);
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
      external_id: ext,
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
      external_id: ext,
      serverMs,
      localMs,
      resolucao: 'empate de timestamp; conteúdo difere — prioriza local (update)',
    });
  }

  const foto = v.fotos?.[0];
  let urlFoto: string | null = ex.url_foto != null ? String(ex.url_foto) : null;
  if (foto && foto.size > 0) {
    const up = await uploadOptionalFoto(v.placa, foto);
    if (up) urlFoto = up;
  }

  const patch: Record<string, unknown> = {
    placa: v.placa,
    num_vistoria: v.numeroVistoria,
    vistoriador: v.vistoriador,
    url_foto: urlFoto,
  };

  const { data: after, error: upErr } = await supabase
    .from('vistorias')
    .update(patch)
    .eq('external_id', ext)
    .select('id, updated_at')
    .maybeSingle();

  if (upErr) {
    console.error('[sync] Erro detalhado:', upErr);
    return false;
  }

  const afterRow = after as { id?: string; updated_at?: string | null } | null;
  const newMs = supabaseTimestampToMs(afterRow?.updated_at);
  await updateVistoria(localVistoriaId, {
    updatedAt: newMs > 0 ? newMs : Date.now(),
    cloudVistoriaId:
      afterRow?.id != null ? String(afterRow.id) : ex.id != null ? String(ex.id) : undefined,
  });
  return true;
}
