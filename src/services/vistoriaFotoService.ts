/**
 * Sync de fotos tipadas para public.vistorias_fotos + Storage.
 * Tipos inferidos dos prefixos locais: PLACA_, ADESIVO_, CHASSI_, MOTOR_, FOTO_.
 */
import { sha256HexFromBlob } from '@/lib/sha256';
import { supabase } from '@/services/supabaseClient';

export const VISTORIA_FOTOS_BUCKET = 'fotos-vistorias';

export type VistoriaFotoTipo = 'placa' | 'adesivo' | 'chassi' | 'motor' | 'geral';

export type ParsedLocalFoto = {
  tipo: VistoriaFotoTipo;
  ordem: number;
  blob: Blob;
  arquivoOriginal: string;
  mimeType: string;
};

type CloudFotoRow = {
  id?: string;
  tipo?: VistoriaFotoTipo;
  ordem?: number;
  storage_path?: string;
  sha256?: string;
};

export type SyncVistoriaFotosResult = {
  placaPublicUrl: string | null;
  uploadFailed: boolean;
  uploadedCount: number;
  failedPaths: string[];
};

const REQUIRED_TIPOS: VistoriaFotoTipo[] = ['placa', 'adesivo'];

function logFotoSyncError(message: string, detail?: unknown): void {
  console.error(`[Fotos] ${message}`, detail ?? '');
}

function fotoKey(tipo: VistoriaFotoTipo, ordem: number): string {
  return `${tipo}:${ordem}`;
}

function inferTipoFromFileName(fileName: string): VistoriaFotoTipo {
  if (fileName.startsWith('PLACA_')) return 'placa';
  if (fileName.startsWith('ADESIVO_')) return 'adesivo';
  if (fileName.startsWith('CHASSI_')) return 'chassi';
  if (fileName.startsWith('MOTOR_')) return 'motor';
  return 'geral';
}

/** Converte o array local (Blob[] com nomes prefixados) em fotos tipadas para sync. */
export function parseLocalFotos(fotos: Blob[] | undefined | null): ParsedLocalFoto[] {
  if (!fotos?.length) return [];
  const out: ParsedLocalFoto[] = [];
  let geralOrdem = 0;

  for (const blob of fotos) {
    if (!blob || blob.size <= 0) continue;
    const file = blob as File;
    const arquivoOriginal = (file.name && String(file.name).trim()) || `foto_${Date.now()}.jpg`;
    const mimeType = blob.type?.trim() || 'image/jpeg';
    const tipo = inferTipoFromFileName(arquivoOriginal);
    const ordem = tipo === 'geral' ? geralOrdem++ : 0;
    out.push({ tipo, ordem, blob, arquivoOriginal, mimeType });
  }

  return out;
}

export function buildVistoriaFotoStoragePath(
  leilaoFk: number,
  vistoriaCloudId: string,
  tipo: VistoriaFotoTipo,
  ordem: number,
): string {
  return `${leilaoFk}/${vistoriaCloudId}/${tipo}_${ordem}.jpg`;
}

export function getVistoriaFotoPublicUrl(storagePath: string): string {
  const { data } = supabase.storage.from(VISTORIA_FOTOS_BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

export async function sha256HexBlob(blob: Blob): Promise<string> {
  return sha256HexFromBlob(blob);
}

async function fetchCloudFotoRows(vistoriaCloudId: string): Promise<CloudFotoRow[]> {
  const { data, error } = await supabase
    .from('vistorias_fotos')
    .select('id, tipo, ordem, storage_path, sha256')
    .eq('vistoria_id', vistoriaCloudId);

  if (error) {
    logFotoSyncError('Falha ao listar vistorias_fotos', error.message);
    return [];
  }
  return (data ?? []) as CloudFotoRow[];
}

async function removeStoragePaths(paths: string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  const { error } = await supabase.storage.from(VISTORIA_FOTOS_BUCKET).remove(paths);
  if (error) {
    logFotoSyncError('Falha ao remover Storage', error.message);
    return false;
  }
  return true;
}

async function deleteCloudFotoRows(ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const { error } = await supabase.from('vistorias_fotos').delete().in('id', ids);
  if (error) {
    logFotoSyncError('Falha ao remover vistorias_fotos', error.message);
    return false;
  }
  return true;
}

/**
 * Sincroniza fotos locais com Storage + vistorias_fotos.
 * Remove da nuvem fotos que não existem mais localmente (Storage primeiro, depois DB).
 */
export async function syncVistoriaFotosToCloud(opts: {
  leilaoFk: number;
  vistoriaCloudId: string;
  fotos: Blob[] | undefined | null;
}): Promise<SyncVistoriaFotosResult> {
  const { leilaoFk, vistoriaCloudId, fotos } = opts;
  const parsed = parseLocalFotos(fotos);
  const localKeys = new Set(parsed.map((p) => fotoKey(p.tipo, p.ordem)));

  let uploadFailed = false;
  let uploadedCount = 0;
  let placaPublicUrl: string | null = null;
  const failedPaths: string[] = [];
  const okKeys = new Set<string>();

  const existing = await fetchCloudFotoRows(vistoriaCloudId);
  const existingByKey = new Map<string, CloudFotoRow>();
  for (const row of existing) {
    if (row.tipo == null || row.ordem == null) continue;
    existingByKey.set(fotoKey(row.tipo, row.ordem), row);
  }

  const toRemove = existing.filter((row) => {
    if (row.tipo == null || row.ordem == null) return false;
    return !localKeys.has(fotoKey(row.tipo, row.ordem));
  });

  if (toRemove.length > 0) {
    const paths = toRemove.map((r) => String(r.storage_path ?? '')).filter(Boolean);
    const storageOk = await removeStoragePaths(paths);
    if (!storageOk) uploadFailed = true;
    else {
      const ids = toRemove.map((r) => String(r.id ?? '')).filter(Boolean);
      const dbOk = await deleteCloudFotoRows(ids);
      if (!dbOk) uploadFailed = true;
    }
  }

  const nowIso = new Date().toISOString();

  for (const p of parsed) {
    const key = fotoKey(p.tipo, p.ordem);
    const storagePath = buildVistoriaFotoStoragePath(leilaoFk, vistoriaCloudId, p.tipo, p.ordem);
    let sha256: string;
    try {
      sha256 = await sha256HexBlob(p.blob);
    } catch (err) {
      uploadFailed = true;
      failedPaths.push(storagePath);
      logFotoSyncError(`SHA-256 falhou (${storagePath})`, err);
      continue;
    }

    const prev = existingByKey.get(key);
    if (prev?.sha256 === sha256 && prev.storage_path === storagePath) {
      okKeys.add(key);
      if (p.tipo === 'placa' && prev.storage_path) {
        placaPublicUrl = getVistoriaFotoPublicUrl(String(prev.storage_path));
      }
      continue;
    }

    const contentType = p.mimeType || 'image/jpeg';
    const { error: storageError } = await supabase.storage
      .from(VISTORIA_FOTOS_BUCKET)
      .upload(storagePath, p.blob, { contentType, upsert: true });

    if (storageError) {
      uploadFailed = true;
      failedPaths.push(storagePath);
      logFotoSyncError(`Upload falhou (${storagePath})`, storageError.message);
      continue;
    }

    uploadedCount += 1;

    const row = {
      vistoria_id: vistoriaCloudId,
      tipo: p.tipo,
      ordem: p.ordem,
      storage_path: storagePath,
      arquivo_original: p.arquivoOriginal,
      mime_type: contentType,
      tamanho: p.blob.size,
      uploaded_at: nowIso,
      sha256,
    };

    const { error: dbError } = await supabase
      .from('vistorias_fotos')
      .upsert(row, { onConflict: 'vistoria_id,tipo,ordem' });

    if (dbError) {
      uploadFailed = true;
      failedPaths.push(storagePath);
      logFotoSyncError(`Upsert vistorias_fotos falhou (${storagePath})`, dbError.message);
      continue;
    }

    okKeys.add(key);
    if (p.tipo === 'placa') {
      placaPublicUrl = getVistoriaFotoPublicUrl(storagePath);
    }
  }

  const localRequired = parsed.filter((p) => REQUIRED_TIPOS.includes(p.tipo));
  const missingRequired = localRequired.some((p) => !okKeys.has(fotoKey(p.tipo, p.ordem)));
  if (missingRequired) uploadFailed = true;

  if (uploadFailed && failedPaths.length > 0) {
    logFotoSyncError('Sync incompleto', { failedPaths, uploadedCount, total: parsed.length });
  }

  return { placaPublicUrl, uploadFailed, uploadedCount, failedPaths };
}

/**
 * Antes de DELETE em vistorias: remove arquivos do Storage, depois registros em vistorias_fotos.
 */
export async function deleteVistoriaFotosBeforeVistoriaDelete(vistoriaCloudId: string): Promise<boolean> {
  const rows = await fetchCloudFotoRows(vistoriaCloudId);
  const paths = rows.map((r) => String(r.storage_path ?? '')).filter(Boolean);

  if (paths.length > 0) {
    const storageOk = await removeStoragePaths(paths);
    if (!storageOk) return false;
  }

  if (rows.length > 0) {
    const ids = rows.map((r) => String(r.id ?? '')).filter(Boolean);
    const dbOk = await deleteCloudFotoRows(ids);
    if (!dbOk) return false;
  }

  return true;
}
