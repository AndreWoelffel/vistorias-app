// src/lib/plateValidator.ts

const numToLetra: Record<string, string> = { 
    '0':'O', '1':'I', '2':'Z', '4':'A', '5':'S', '8':'B' 
  };
  
  const letraToNum: Record<string, string> = { 
    'O':'0', 'I':'1', 'Z':'2', 'A':'4', 'S':'5', 'B':'8', 'G':'6', 'T':'1' 
  };
  
  function corrigirCaractere(char: string, tipoEsperado: 'LETRA' | 'NUMERO'): string {
    const isDigit = /\d/.test(char);
    const isAlpha = /[a-zA-Z]/.test(char);
  
    if (tipoEsperado === 'LETRA' && isDigit) {
      return numToLetra[char] || char;
    } else if (tipoEsperado === 'NUMERO' && isAlpha) {
      return letraToNum[char.toUpperCase()] || char;
    }
    return char;
  }
  
  /**
   * Pós-processa uma string suja vinda da CNN/OCR corrigindo confusões comuns
   * baseadas no padrão de placas brasileiras (Antiga e Mercosul).
   */
  export function processarPlaca(caracteresDetectados: string | string[]): string {
    // Limpa tudo que não for letra ou número e transforma em array
    const chars = typeof caracteresDetectados === 'string'
      ? caracteresDetectados.toUpperCase().replace(/[^A-Z0-9]/g, '').split('')
      : caracteresDetectados.map(c => c.toUpperCase());
  
    // Se a rede neural não encontrou 7 caracteres, retorna o que achou para o usuário arrumar
    if (chars.length !== 7) {
      return chars.join(''); 
    }
  
    const placaCorrigida: string[] = [];
  
    // 1º, 2º e 3º são sempre Letras
    for (let i = 0; i < 3; i++) {
      placaCorrigida.push(corrigirCaractere(chars[i], 'LETRA'));
    }
  
    // 4º é sempre Número
    placaCorrigida.push(corrigirCaractere(chars[3], 'NUMERO'));
  
    // 5º: O Ponto de Decisão (Letra = Mercosul, Número = Antiga)
    // Mantemos o caractere original, pois ele dita a regra
    placaCorrigida.push(chars[4]);
  
    // 6º e 7º são sempre Números
    for (let i = 5; i < 7; i++) {
      placaCorrigida.push(corrigirCaractere(chars[i], 'NUMERO'));
    }
  
    return placaCorrigida.join('');
  }