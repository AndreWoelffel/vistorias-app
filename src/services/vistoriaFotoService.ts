/**
 * Sync de fotos tipadas para public.vistorias_fotos + Storage.
 * Tipos inferidos dos prefixos locais: PLACA_, ADESIVO_, CHASSI_, MOTOR_, FOTO_.
 */
import {
  parseOrientationFromFileName,
  stripOrientationSuffix,
  type OrientacaoAngulo,
  type OrientacaoFonte,
} from '@/lib/imageOrientation';
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
  /** Rotação já gravada nos pixels pelo alinhador; null em foto legada. */
  rotacaoAplicada: OrientacaoAngulo | null;
  orientacaoFonte: OrientacaoFonte | null;
};

type CloudFotoRow = {
  id?: string;
  tipo?: VistoriaFotoTipo;
  ordem?: number;
  storage_path?: string;
  sha256?: string;
};

/** Chave `tipo:ordem` → sha256 da foto que este aparelho enviou. */
export type FotosEnviadas = Record<string, string>;

export type SyncVistoriaFotosResult = {
  placaPublicUrl: string | null;
  uploadFailed: boolean;
  uploadedCount: number;
  failedPaths: string[];
  enviadas: FotosEnviadas;
};

const REQUIRED_TIPOS: VistoriaFotoTipo[] = ['placa', 'adesivo'];

function logFotoSyncError(message: string, detail?: unknown): void {
  console.error(`[Fotos] ${message}`, detail ?? '');
}

/**
 * O deploy do app e a migration do banco não são atômicos: o vistoriador pode
 * receber esta versão antes de `0001_ia_leituras.sql` ter sido aplicada. Sem o
 * fallback abaixo, o upsert falharia com PGRST204 e derrubaria o sync de fotos
 * inteiro — regressão bem pior do que ficar sem o metadado de orientação.
 */
let colunasOrientacaoDisponiveis = true;

function ehErroDeColunaAusente(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('rotacao_aplicada') ||
    m.includes('orientacao_fonte') ||
    m.includes('pgrst204')
  );
}

async function upsertFotoRow(row: Record<string, unknown>): Promise<string | null> {
  const enviar = async (payload: Record<string, unknown>) => {
    const { error } = await supabase
      .from('vistorias_fotos')
      .upsert(payload, { onConflict: 'vistoria_id,tipo,ordem' });
    return error?.message ?? null;
  };

  if (colunasOrientacaoDisponiveis) {
    const erro = await enviar(row);
    if (!erro) return null;
    if (!ehErroDeColunaAusente(erro)) return erro;

    colunasOrientacaoDisponiveis = false;
    logFotoSyncError(
      'Colunas de orientação ausentes — aplique supabase/migrations/0001_ia_leituras.sql. ' +
        'Seguindo sem o metadado.',
      erro,
    );
  }

  const { rotacao_aplicada: _r, orientacao_fonte: _f, ...semOrientacao } = row;
  return enviar(semOrientacao);
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
    const nomeLocal = (file.name && String(file.name).trim()) || `foto_${Date.now()}.jpg`;
    const mimeType = blob.type?.trim() || 'image/jpeg';
    const tipo = inferTipoFromFileName(nomeLocal);
    const ordem = tipo === 'geral' ? geralOrdem++ : 0;
    const { angulo, fonte } = parseOrientationFromFileName(nomeLocal);
    out.push({
      tipo,
      ordem,
      blob,
      // `arquivo_original` guarda o nome sem o sufixo técnico de orientação.
      arquivoOriginal: stripOrientationSuffix(nomeLocal),
      mimeType,
      rotacaoAplicada: angulo,
      orientacaoFonte: fonte,
    });
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
 *
 * O Operador gira e troca fotos na nuvem, e uma vistoria baixada de outro aparelho
 * chega aqui sem as fotos. Por isso só se mexe no que este aparelho enviou
 * (`enviadasAntes`): foto que já subiu e não mudou aqui não é reenviada, e só sai
 * da nuvem a foto que este aparelho enviou e o vistoriador tirou depois.
 */
export async function syncVistoriaFotosToCloud(opts: {
  leilaoFk: number;
  vistoriaCloudId: string;
  fotos: Blob[] | undefined | null;
  enviadasAntes?: FotosEnviadas;
}): Promise<SyncVistoriaFotosResult> {
  const { leilaoFk, vistoriaCloudId, fotos } = opts;
  const enviadasAntes = opts.enviadasAntes ?? {};
  const parsed = parseLocalFotos(fotos);
  const localKeys = new Set(parsed.map((p) => fotoKey(p.tipo, p.ordem)));
  const enviadas: FotosEnviadas = {};

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
    const key = fotoKey(row.tipo, row.ordem);
    return key in enviadasAntes && !localKeys.has(key);
  });

  if (toRemove.length > 0) {
    const paths = toRemove.map((r) => String(r.storage_path ?? '')).filter(Boolean);
    const storageOk = await removeStoragePaths(paths);
    const ids = toRemove.map((r) => String(r.id ?? '')).filter(Boolean);
    const dbOk = storageOk && (await deleteCloudFotoRows(ids));
    if (!dbOk) {
      uploadFailed = true;
      for (const row of toRemove) {
        const key = fotoKey(row.tipo as VistoriaFotoTipo, row.ordem as number);
        enviadas[key] = enviadasAntes[key];
      }
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
      if (enviadasAntes[key]) enviadas[key] = enviadasAntes[key];
      logFotoSyncError(`SHA-256 falhou (${storagePath})`, err);
      continue;
    }

    const prev = existingByKey.get(key);
    const jaEnviada = prev?.sha256 === sha256 || enviadasAntes[key] === sha256;
    // Sem registro do que este aparelho enviou (vistoria de versão antiga), a nuvem vence.
    const legadoNaNuvem = prev != null && opts.enviadasAntes == null;
    if (prev && (jaEnviada || legadoNaNuvem)) {
      okKeys.add(key);
      enviadas[key] = sha256;
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
      if (enviadasAntes[key]) enviadas[key] = enviadasAntes[key];
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
      rotacao_aplicada: p.rotacaoAplicada,
      orientacao_fonte: p.orientacaoFonte,
    };

    const dbError = await upsertFotoRow(row);

    if (dbError) {
      uploadFailed = true;
      failedPaths.push(storagePath);
      if (enviadasAntes[key]) enviadas[key] = enviadasAntes[key];
      logFotoSyncError(`Upsert vistorias_fotos falhou (${storagePath})`, dbError);
      continue;
    }

    okKeys.add(key);
    enviadas[key] = sha256;
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

  return { placaPublicUrl, uploadFailed, uploadedCount, failedPaths, enviadas };
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
