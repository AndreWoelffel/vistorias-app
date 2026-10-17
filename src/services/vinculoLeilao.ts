/**
 * Vínculo vistoria ↔ leilão em public.vistorias_leiloes.
 *
 * Sem esse vínculo a vistoria não aparece em `vistorias_com_leilao`: o Operador não
 * a enxerga e a limpeza do aparelho a trata como apagada. Por isso a falha aqui
 * nunca é ignorada: ou o vínculo existe, ou a sync falha e tenta de novo.
 */
import { supabase } from '@/services/supabaseClient';
import type { VistoriaDuplicateType } from '@/lib/db';

export type VinculoLeilaoResult =
  | { ok: true; duplicado?: undefined }
  | { ok: false; duplicado: VistoriaDuplicateType };

async function vinculoExiste(vistoriaCloudId: string, leilaoFk: number): Promise<boolean> {
  const { data, error } = await supabase
    .from('vistorias_leiloes')
    .select('vistoria_id')
    .eq('vistoria_id', vistoriaCloudId)
    .eq('leilao_id', leilaoFk)
    .limit(1);
  if (error) throw new Error(`Falha ao conferir vínculo com o leilão: ${error.message}`);
  return (data ?? []).length > 0;
}

/** O gatilho do banco recusa placa ou número repetido no mesmo leilão. */
function duplicadoDoGatilho(message: string | undefined): VistoriaDuplicateType | null {
  const m = (message ?? '').toLowerCase();
  const placa = m.includes('duplicate_placa_in_leilao');
  const numero = m.includes('duplicate_num_in_leilao');
  if (placa) return 'placa';
  if (numero) return 'numero';
  return null;
}

export async function garantirVinculoLeilao(
  vistoriaCloudId: string,
  leilaoFk: number,
): Promise<VinculoLeilaoResult> {
  if (await vinculoExiste(vistoriaCloudId, leilaoFk)) return { ok: true };

  const { error } = await supabase
    .from('vistorias_leiloes')
    .insert({ vistoria_id: vistoriaCloudId, leilao_id: leilaoFk });
  if (!error) return { ok: true };

  const duplicado = duplicadoDoGatilho(error.message);
  if (duplicado) return { ok: false, duplicado };

  // Outro envio do mesmo aparelho pode ter criado o vínculo entre a conferência e o insert.
  if (error.code === '23505' && (await vinculoExiste(vistoriaCloudId, leilaoFk))) return { ok: true };

  throw new Error(`Falha ao vincular a vistoria ao leilão: ${error.message}`);
}
