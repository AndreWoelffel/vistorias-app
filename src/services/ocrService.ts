import { createWorker } from 'tesseract.js';

export async function readStickerNumber(imageSource: string | HTMLCanvasElement | HTMLImageElement): Promise<string | null> {
  if (import.meta.env.DEV) {
    console.log("[Arquiteto] Acordando o Tesseract.js para leitura do adesivo...");
  }

  // 1. Instanciamos o Worker explicitamente para ter controle total sobre a memória RAM
  const worker = await createWorker('eng', 1, {
    logger: (m) => {
      if (import.meta.env.DEV) {
        console.log(`[Tesseract] ${m.status}: ${(m.progress * 100).toFixed(0)}%`);
      }
    },
  });

  try {
    // 2. A MÁGICA: Lista Branca. 
    // Amordaçamos a IA para ignorar o alfabeto inteiro. Letra "O" vira "0", "S" vira "5".
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
    });

    // 3. Executamos a leitura focada
    const result = await worker.recognize(imageSource);
    
    // O Tesseract agora só devolve números ou espaços, facilitando a limpeza
    const rawText = result.data.text;
    const apenasNumeros = rawText.replace(/\D/g, "");

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
      // Se não achar 5, retorna o que achou (limitado a 5 caracteres) para o usuário apenas corrigir
      return apenasNumeros.length > 0 ? apenasNumeros.slice(0, 5) : null; 
    }

  } catch (error) {
    console.error("❌ [Arquiteto] Erro crítico no Tesseract:", error);
    return null;
  } finally {
    // 4. OBRIGATÓRIO: Destruímos o processo zumbi para não estourar a memória do celular
    await worker.terminate();
    if (import.meta.env.DEV) {
      console.log("[Arquiteto] Worker do Tesseract destruído e memória RAM liberada.");
    }
  }
}