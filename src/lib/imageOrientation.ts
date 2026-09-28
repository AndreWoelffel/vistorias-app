/**
 * Alinhamento de fotos de veículo (geral, chassi, motor).
 *
 * Por que isso existe: o manifest do PWA trava `orientation: "portrait"`, então
 * quando o vistoriador vira o celular o `<video>` NÃO acompanha — o frame sai
 * enquadrado em retrato com a cena rotacionada. O ângulo físico do aparelho é o
 * único sinal que revela isso, e ele vem da gravidade (acelerômetro), não da
 * orientação de tela (que fica presa em 0 justamente por causa do lock).
 *
 * Fontes de decisão, por origem da foto:
 *   - câmera  → gravidade, via DeviceOrientationEvent (beta/gamma)
 *   - galeria → EXIF do arquivo; o sensor não diz nada sobre foto antiga
 *   - nenhuma → não rotaciona (errar por omissão é o menor dano)
 *
 * `screen.orientation.angle` é apenas diagnóstico, nunca fonte de correção: com
 * a tela destravada o navegador já entrega o vídeo alinhado a ela, e corrigir
 * por cima giraria a imagem duas vezes.
 *
 * Placa e adesivo ficam de fora de propósito: passam pelo PlateFrameEditor e
 * pelo gate do scanner em tempo real, que só dispara quando lê 7 caracteres
 * válidos — o que já implica orientação correta.
 */

export type OrientacaoAngulo = 0 | 90 | 180 | 270;

export type OrientacaoFonte = 'sensor' | 'exif' | 'ml' | 'manual' | 'none';

export type OrientationReading = {
  /** Rotação a aplicar na imagem, em graus, sentido horário. */
  angulo: OrientacaoAngulo;
  fonte: OrientacaoFonte;
  /** Sinais crus — alimentam o painel de debug para validação em campo. */
  sinais: {
    beta: number | null;
    gamma: number | null;
    screenAngle: number | null;
    /** true quando o aparelho está quase na horizontal (apontado p/ chão ou teto). */
    achatado: boolean;
  };
};

/**
 * Abaixo deste ângulo de inclinação a gravidade não define um "horizonte" útil:
 * o aparelho está deitado, apontando para o chão ou para o teto. Acontece muito
 * em foto de chassi tirada de cima. Nesse caso é mais seguro não girar nada.
 */
const INCLINACAO_MINIMA_DEG = 25;

/** Acima deste |gamma| o aparelho está em paisagem. */
const LIMIAR_PAISAGEM_DEG = 45;

const FLAG_AUTO_ALINHAR = 'vistoria.autoAlinharFotos';
const FLAG_SINAL_GAMMA = 'vistoria.orientacaoSinalGamma';

// ════════════════════════════════════════════════════════════════════════════
// Flags — permitem corrigir em campo, sem redeploy
// ════════════════════════════════════════════════════════════════════════════

/** Alinhamento automático ligado? Default: ligado. */
export function isAutoAlinharAtivo(): boolean {
  try {
    return localStorage.getItem(FLAG_AUTO_ALINHAR) !== 'off';
  } catch {
    return true;
  }
}

export function setAutoAlinharAtivo(ativo: boolean): void {
  try {
    localStorage.setItem(FLAG_AUTO_ALINHAR, ativo ? 'on' : 'off');
  } catch {
    /* modo privado */
  }
}

/**
 * Sinal do gamma (+1 ou -1). A convenção de sinal do DeviceOrientationEvent
 * divergiu historicamente entre navegadores e não dá para determinar sem um
 * aparelho na mão. Se em campo as fotos em paisagem saírem giradas para o lado
 * errado, inverta isto pelo painel de debug — os 90° viram 270° e vice-versa.
 */
export function getSinalGamma(): 1 | -1 {
  try {
    return localStorage.getItem(FLAG_SINAL_GAMMA) === '-1' ? -1 : 1;
  } catch {
    return 1;
  }
}

export function setSinalGamma(sinal: 1 | -1): void {
  try {
    localStorage.setItem(FLAG_SINAL_GAMMA, String(sinal));
  } catch {
    /* modo privado */
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Leitura dos sensores
// ════════════════════════════════════════════════════════════════════════════

let ultimoBeta: number | null = null;
let ultimoGamma: number | null = null;
let listeners = 0;

function onDeviceOrientation(ev: DeviceOrientationEvent): void {
  if (ev.beta !== null) ultimoBeta = ev.beta;
  if (ev.gamma !== null) ultimoGamma = ev.gamma;
}

/**
 * Liga o listener de orientação. O sensor leva algumas centenas de ms para
 * emitir o primeiro evento, por isso chame ao ABRIR a câmera, não no momento
 * do disparo. Retorna a função de limpeza.
 */
export function startOrientationTracking(): () => void {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
    return () => {};
  }
  listeners += 1;
  if (listeners === 1) {
    window.addEventListener('deviceorientation', onDeviceOrientation, { passive: true });
  }
  return () => {
    listeners = Math.max(0, listeners - 1);
    if (listeners === 0) {
      window.removeEventListener('deviceorientation', onDeviceOrientation);
      ultimoBeta = null;
      ultimoGamma = null;
    }
  };
}

/**
 * iOS 13+ exige permissão explícita, concedida a partir de um gesto do usuário.
 * Chame no toque que abre a câmera. Em Android é no-op.
 */
export async function requestOrientationPermission(): Promise<boolean> {
  const Ctor = (window as unknown as {
    DeviceOrientationEvent?: { requestPermission?: () => Promise<PermissionState | string> };
  }).DeviceOrientationEvent;

  if (typeof Ctor?.requestPermission !== 'function') return true;

  try {
    const res = await Ctor.requestPermission();
    return res === 'granted';
  } catch {
    return false;
  }
}

function lerScreenAngle(): number | null {
  if (typeof window === 'undefined') return null;
  const angle = window.screen?.orientation?.angle;
  if (typeof angle === 'number') return angle;
  const legado = (window as unknown as { orientation?: number }).orientation;
  return typeof legado === 'number' ? legado : null;
}

/**
 * Converte a inclinação do aparelho na rotação que a imagem precisa receber.
 *
 * Raciocínio do caso de 90°: girando o celular no sentido horário, o eixo
 * "para cima" dele passa a apontar para o leste do mundo. Um carro horizontal
 * aparece na vertical no frame, e devolvê-lo à horizontal exige girar a imagem
 * no mesmo sentido horário — ou seja, a correção é igual à rotação do aparelho.
 */
export function anguloPelaGravidade(
  beta: number,
  gamma: number,
  sinalGamma: 1 | -1 = getSinalGamma(),
): OrientacaoAngulo | null {
  const gammaAjustado = gamma * sinalGamma;

  const achatado =
    Math.abs(beta) < INCLINACAO_MINIMA_DEG && Math.abs(gammaAjustado) < INCLINACAO_MINIMA_DEG;
  if (achatado) return null;

  if (Math.abs(gammaAjustado) >= LIMIAR_PAISAGEM_DEG) {
    return gammaAjustado > 0 ? 90 : 270;
  }
  return beta >= 0 ? 0 : 180;
}

/** Melhor estimativa atual da rotação necessária, com os sinais crus anexados. */
export function readDeviceOrientation(): OrientationReading {
  const beta = ultimoBeta;
  const gamma = ultimoGamma;
  const screenAngle = lerScreenAngle();

  const achatado =
    beta !== null &&
    gamma !== null &&
    Math.abs(beta) < INCLINACAO_MINIMA_DEG &&
    Math.abs(gamma * getSinalGamma()) < INCLINACAO_MINIMA_DEG;

  const sinais = { beta, gamma, screenAngle, achatado };

  if (beta !== null && gamma !== null) {
    const porGravidade = anguloPelaGravidade(beta, gamma);
    if (porGravidade !== null) {
      return { angulo: porGravidade, fonte: 'sensor', sinais };
    }
    // Achatado: a gravidade não define horizonte no plano da tela. Sem sinal
    // confiável, não girar é a escolha segura.
  }

  return { angulo: 0, fonte: 'none', sinais };
}

// ════════════════════════════════════════════════════════════════════════════
// Manipulação da imagem
// ════════════════════════════════════════════════════════════════════════════

type FonteDecodificada = {
  desenhavel: CanvasImageSource;
  width: number;
  height: number;
  liberar: () => void;
};

/**
 * Decodifica respeitando o EXIF. Importante para fotos de galeria: as da câmera
 * do próprio app já perderam o EXIF no `canvas.toBlob`, mas as escolhidas pelo
 * seletor de arquivos trazem a tag de orientação do sistema.
 */
async function decodificar(blob: Blob): Promise<FonteDecodificada> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return {
        desenhavel: bmp,
        width: bmp.width,
        height: bmp.height,
        liberar: () => bmp.close(),
      };
    } catch {
      // Safari antigo não aceita a opção — cai no <img>.
    }
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    // Navegadores atuais aplicam o EXIF ao desenhar um <img> no canvas.
    img.onload = () =>
      resolve({
        desenhavel: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        liberar: () => URL.revokeObjectURL(url),
      });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('imageOrientation: falha ao decodificar a imagem'));
    };
    img.src = url;
  });
}

export type PreparedPhoto = {
  blob: Blob;
  angulo: OrientacaoAngulo;
  fonte: OrientacaoFonte;
};

export type PrepareOptions = {
  /**
   * 'camera'  → usa a cascata de sensores (foto tirada agora, sem EXIF).
   * 'galeria' → confia SÓ no EXIF do arquivo.
   *
   * A distinção é obrigatória: a inclinação atual do aparelho não diz nada
   * sobre uma foto tirada minutos antes, e somar o sensor ao EXIF que o
   * decodificador já aplicou giraria a imagem duas vezes.
   */
  origem?: 'camera' | 'galeria';
  /** Rotação explícita, tem precedência sobre tudo. */
  angulo?: OrientacaoAngulo;
  fonte?: OrientacaoFonte;
  maxWidth?: number;
  quality?: number;
};

/**
 * Rotaciona e comprime numa única passagem de canvas.
 *
 * Fazer os dois juntos é intencional: rotacionar em separado custaria um
 * encode JPEG extra, degradando a imagem. Assim o número de encodes é o mesmo
 * de antes (o do disparo + este), e a rotação sai de graça em qualidade.
 */
export async function prepareVehiclePhoto(
  blob: Blob,
  opts: PrepareOptions = {},
): Promise<PreparedPhoto> {
  const { maxWidth = 1280, quality = 0.7, origem = 'camera' } = opts;

  let angulo: OrientacaoAngulo = 0;
  let fonte: OrientacaoFonte = 'none';

  if (opts.angulo !== undefined) {
    angulo = opts.angulo;
    fonte = opts.fonte ?? 'manual';
  } else if (origem === 'galeria') {
    // `decodificar` já aplicou a tag de orientação do arquivo; nada a somar.
    fonte = 'exif';
  } else if (isAutoAlinharAtivo()) {
    const leitura = readDeviceOrientation();
    angulo = leitura.angulo;
    fonte = leitura.fonte;
  }

  const src = await decodificar(blob);
  try {
    const trocaEixos = angulo === 90 || angulo === 270;
    const rotW = trocaEixos ? src.height : src.width;
    const rotH = trocaEixos ? src.width : src.height;

    const escala = rotW > maxWidth ? maxWidth / rotW : 1;
    const outW = Math.max(1, Math.round(rotW * escala));
    const outH = Math.max(1, Math.round(rotH * escala));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('imageOrientation: canvas sem contexto 2D');
    ctx.imageSmoothingQuality = 'high';

    const desW = src.width * escala;
    const desH = src.height * escala;
    ctx.translate(outW / 2, outH / 2);
    if (angulo !== 0) ctx.rotate((angulo * Math.PI) / 180);
    ctx.drawImage(src.desenhavel, -desW / 2, -desH / 2, desW, desH);

    const out = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('imageOrientation: toBlob falhou'))),
        'image/jpeg',
        quality,
      );
    });

    // `angulo: 0, fonte: 'sensor'` é informação útil: significa que o sensor
    // avaliou e concluiu que a foto já estava reta — diferente de 'none', que
    // significa que ninguém conseguiu avaliar.
    return { blob: out, angulo, fonte };
  } finally {
    src.liberar();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Metadado no nome do arquivo
// ════════════════════════════════════════════════════════════════════════════
//
// O nome do arquivo já é o canal de metadado deste app: `inferTipoFromFileName`
// deriva o tipo do prefixo e o EditInspection reconstrói o estado relendo os
// nomes. Objetos File perdem propriedades customizadas ao entrar no IndexedDB
// (structured clone), e um array paralelo de metadados dessincronizaria ao
// apagar uma foto da galeria. Codificar no nome se mantém coerente de graça.

const SUFIXO_RE = /~r(0|90|180|270)-(sensor|exif|ml|manual|none)(?=\.[A-Za-z0-9]+$|$)/;

/** `FOTO_ABC1D23_171.jpg` → `FOTO_ABC1D23_171~r90-sensor.jpg` */
export function encodeOrientationInFileName(
  fileName: string,
  angulo: OrientacaoAngulo,
  fonte: OrientacaoFonte,
): string {
  const limpo = fileName.replace(SUFIXO_RE, '');
  const ponto = limpo.lastIndexOf('.');
  const sufixo = `~r${angulo}-${fonte}`;
  if (ponto <= 0) return `${limpo}${sufixo}`;
  return `${limpo.slice(0, ponto)}${sufixo}${limpo.slice(ponto)}`;
}

export function parseOrientationFromFileName(fileName: string): {
  angulo: OrientacaoAngulo | null;
  fonte: OrientacaoFonte | null;
} {
  const m = SUFIXO_RE.exec(fileName);
  if (!m) return { angulo: null, fonte: null };
  return {
    angulo: Number(m[1]) as OrientacaoAngulo,
    fonte: m[2] as OrientacaoFonte,
  };
}

/** Remove o sufixo para exibição e para gravar `arquivo_original` limpo. */
export function stripOrientationSuffix(fileName: string): string {
  return fileName.replace(SUFIXO_RE, '');
}

/**
 * Já foi alinhada? Garante idempotência: uma foto rotacionada nunca deve ser
 * rotacionada de novo, senão o SHA-256 muda a cada sync e o upload entra em
 * laço com o dedup do vistoriaFotoService.
 */
export function jaFoiAlinhada(fileName: string): boolean {
  return SUFIXO_RE.test(fileName);
}
