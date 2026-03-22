// src/services/ocrService.ts
import Tesseract from 'tesseract.js';

export async function readStickerNumber(imageSource: string | HTMLCanvasElement | HTMLImageElement): Promise<string | null> {
  if (import.meta.env.DEV) {
    console.log("[Arquiteto] Acordando o Tesseract.js para leitura do adesivo...");
  }

  try {
    // Iniciamos o OCR. Usamos 'eng' (inglês) porque é mais leve que português e,
    // como só queremos ler números, o idioma do dicionário não importa.
    const result = await Tesseract.recognize(imageSource, "eng", {
      logger: (m) => {
        if (import.meta.env.DEV) {
          console.log(`[Tesseract] ${m.status}: ${(m.progress * 100).toFixed(0)}%`);
        }
      },
    });

    // O Tesseract tentará ler tudo, então vamos forçar a limpeza
    // Removemos qualquer espaço, quebra de linha ou letra que ele possa ter alucinado
    const rawText = result.data.text;
    const apenasNumeros = rawText.replace(/\D/g, ""); // Regex mortal: arranca tudo que NÃO for número

    if (import.meta.env.DEV) {
      console.log(`[Arquiteto] Leitura bruta: "${rawText.trim()}" | Limpa: "${apenasNumeros}"`);
    }

    // --- TRAVA DE SEGURANÇA (A Regra de Negócio) ---
    // O adesivo DEVE ter exatamente 5 dígitos
    if (/^\d{5}$/.test(apenasNumeros)) {
      if (import.meta.env.DEV) {
        console.log(`✅ [Arquiteto] Sucesso! Adesivo validado: ${apenasNumeros}`);
      }
      return apenasNumeros;
    } else {
      if (import.meta.env.DEV) {
        console.warn(`⚠️ [Arquiteto] Falha na validação. O texto "${apenasNumeros}" não tem 5 dígitos.`);
      }
      // Retornamos o que ele achou para o vistoriador corrigir na tela (melhor que retornar nulo)
      return apenasNumeros.length > 0 ? apenasNumeros : null; 
    }

  } catch (error) {
    console.error("❌ [Arquiteto] Erro crítico no Tesseract:", error);
    return null;
  }
}