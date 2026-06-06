import { createWorker } from 'tesseract.js';

// Os três modos PSM testados em cada leitura.
// PSM 7 = linha única (mais confiável para 5 dígitos)
// PSM 8 = palavra única (útil quando o Tesseract agrupa os dígitos em "palavra")
// PSM 10 = caractere único (captura dígitos soltos; votos com <5 chars são descartados)
const PSM_MODES = ['7', '8', '10'] as const;

/**
 * Extrai somente dígitos do texto bruto e tenta retornar exatamente 5.
 * 1. Remove tudo que não é dígito.
 * 2. Se o resultado for exatamente 5 → retorna.
 * 3. Senão, procura uma sequência de 5 dígitos consecutivos na string original.
 * 4. Fallback: os primeiros N dígitos encontrados (até 5).
 */
function pickBestFive(raw: string): string {
  const allDigits = raw.replace(/\D/g, '');
  if (/^\d{5}$/.test(allDigits)) return allDigits;

  const exactRun = raw.match(/\d{5}/);
  if (exactRun) return exactRun[0];

  return allDigits.slice(0, 5);
}

export async function readStickerNumber(
  imageSource: string | HTMLCanvasElement | HTMLImageElement
): Promise<string | null> {
  if (import.meta.env.DEV) {
    console.log('[OCR] Iniciando votação tripla (PSM 7 / 8 / 10)...');
  }

  const worker = await createWorker('eng', 1, {
    logger: (m) => {
      if (import.meta.env.DEV) {
        console.log(`[Tesseract] ${m.status}: ${(m.progress * 100).toFixed(0)}%`);
      }
    },
  });

  try {
    // Whitelist global: apenas dígitos — impede alucinações de letras.
    // O pageseg_mode é sobrescrito individualmente dentro do loop de votação.
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
    } as Record<string, string>);

    const candidates: string[] = [];

    for (const psm of PSM_MODES) {
      await worker.setParameters({
        tessedit_pageseg_mode: psm,
      } as Record<string, string>);

      const { data } = await worker.recognize(imageSource);
      const candidate = pickBestFive(data.text);

      if (import.meta.env.DEV) {
        console.log(`[OCR] PSM ${psm}: bruto="${data.text.trim()}" → candidato="${candidate}"`);
      }
      candidates.push(candidate);
    }

    // ── Votação ────────────────────────────────────────────────────────────
    // Só participam resultados com exatamente 5 dígitos.
    const votes = new Map<string, number>();
    for (const c of candidates) {
      if (/^\d{5}$/.test(c)) {
        votes.set(c, (votes.get(c) ?? 0) + 1);
      }
    }

    if (votes.size > 0) {
      // Ordena por contagem decrescente; em empate, o primeiro PSM vence
      // (PSM 7 é o mais confiável para linha única de texto).
      const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]);
      const [winner, count] = sorted[0];

      if (import.meta.env.DEV) {
        console.log(`✅ [OCR] Vencedor: "${winner}" (${count}/${PSM_MODES.length} votos)`);
      }
      return winner;
    }

    // Nenhum PSM produziu um resultado com exatamente 5 dígitos.
    // Retorna '' para que o app exiba o campo vazio e o usuário possa corrigir.
    if (import.meta.env.DEV) {
      console.warn(`⚠️ [OCR] Votação sem vencedor. Candidatos: [${candidates.join(', ')}]`);
    }
    return '';

  } catch (error) {
    console.error('❌ [OCR] Erro crítico no Tesseract:', error);
    return null;
  } finally {
    await worker.terminate();
    if (import.meta.env.DEV) {
      console.log('[OCR] Worker destruído e RAM liberada.');
    }
  }
}
