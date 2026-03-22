/**
 * ALPR — Pipeline de 2 estágios: YOLOv8 (detecção) + CNN (classificação)
 * Placa: YOLO detecta caracteres → recorte 64×64 → CNN classifica → Máscara Mercosul
 * Número da vistoria: pré-processamento + Tesseract (fallback)
 */

import * as tf from '@tensorflow/tfjs';

const CHAR_CLASSES = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J',
  'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T',
  'U', 'V', 'W', 'X', 'Y', 'Z',
] as const;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const NUMBERS = '0123456789';

const YOLO_INPUT_SIZE = 640;
const YOLO_CHAR_CLASS_INDEX = 0;   // 0: Caractere, 1: Placa
const YOLO_MIN_CONF = 0.40;

// Ensure WebGL backend for GPU acceleration
let tfReady: Promise<void> | null = null;
function ensureTF(): Promise<void> {
  if (!tfReady) {
    tfReady = tf.setBackend('webgl').then(() => tf.ready()).catch(() => {
      console.warn('WebGL not available, falling back to CPU');
      return tf.setBackend('cpu').then(() => tf.ready());
    });
  }
  return tfReady;
}

let yoloModelPromise: Promise<tf.GraphModel | tf.LayersModel | null> | null = null;
let yoloVistoriasModelPromise: Promise<tf.GraphModel | tf.LayersModel | null> | null = null;
let cnnModelPromise: Promise<tf.GraphModel | null> | null = null;

/** Carrega o detector YOLO (Caractere + Placa). Chamar no mount ou antes do primeiro OCR de placa. */
export async function loadYOLOModel(): Promise<tf.GraphModel | tf.LayersModel | null> {
  await ensureTF();
  if (!yoloModelPromise) {
    yoloModelPromise = (async () => {
      try {
        console.log('[ALPR YOLO] Tentando carregar YOLO como GraphModel...');
        const g = await tf.loadGraphModel('/model_yolo_placas/model.json');
        console.log('[ALPR YOLO] Sucesso ao carregar YOLO placas como GraphModel');
        return g;
      } catch (e1) {
        console.warn('[ALPR YOLO] Falha ao carregar GraphModel, tentando LayersModel...', e1);
        try {
          const l = await tf.loadLayersModel('/model_yolo_placas/model.json');
          console.log('[ALPR YOLO] Sucesso ao carregar YOLO como LayersModel');
          return l;
        } catch (e2) {
          console.error('[ALPR YOLO] Falha total ao carregar o modelo YOLOv8', e2);
          return null;
        }
      }
    })();
  }
  return yoloModelPromise;
}

/** Carrega o detector YOLO de adesivos de vistoria (public/model_yolo_vistorias/). */
export async function loadYOLOVistoriasModel(): Promise<tf.GraphModel | tf.LayersModel | null> {
  await ensureTF();
  if (!yoloVistoriasModelPromise) {
    yoloVistoriasModelPromise = (async () => {
      try {
        const g = await tf.loadGraphModel('/model_yolo_vistorias/model.json');
        console.log('[YOLO Vistorias] Modelo carregado');
        return g;
      } catch (e1) {
        try {
          const l = await tf.loadLayersModel('/model_yolo_vistorias/model.json');
          console.log('[YOLO Vistorias] Modelo carregado (LayersModel)');
          return l;
        } catch (e2) {
          console.error('[YOLO Vistorias] Falha ao carregar', e2);
          return null;
        }
      }
    })();
  }
  return yoloVistoriasModelPromise;
}

/** Carrega o classificador CNN como GraphModel (export nativo TF). */
export async function loadCNNModel(): Promise<tf.GraphModel | null> {
  await ensureTF();
  if (!cnnModelPromise) {
    cnnModelPromise = (async () => {
      try {
        console.log('[ALPR CNN] Tentando carregar CNN como GraphModel...');
        const model = await tf.loadGraphModel('/model_cnn/model.json');
        console.log('[ALPR CNN] Sucesso absoluto ao carregar CNN como GraphModel!');
        return model;
      } catch (e) {
        console.error('[ALPR CNN] Falha total ao carregar a CNN', e);
        return null;
      }
    })();
  }
  return cnnModelPromise;
}
/** Pré-carrega ambos os modelos (chamar no mount do componente de câmera/placa). */
export function preloadAlprModels(): void {
  loadYOLOModel();
  loadCNNModel();
}

interface YOLOBox {
  x: number;
  y: number;
  w: number;
  h: number;
  classIndex: number;
  confidence: number;
  /** Coordenadas no espaço 640×640 (para debug visual) */
  yoloCoords?: { cx: number; cy: number; w: number; h: number };
}

/** Retorna a mediana dos valores (cópia ordenada; não altera o array original). */
function getMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** IoU (Intersection over Union) entre duas caixas; usado no NMS. */
function calculateIoU(box1: YOLOBox, box2: YOLOBox): number {
  const xA = Math.max(box1.x, box2.x);
  const yA = Math.max(box1.y, box2.y);
  const xB = Math.min(box1.x + box1.w, box2.x + box2.w);
  const yB = Math.min(box1.y + box1.h, box2.y + box2.h);
  const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
  const box1Area = box1.w * box1.h;
  const box2Area = box2.w * box2.h;
  const unionArea = box1Area + box2Area - interArea;
  return unionArea === 0 ? 0 : interArea / unionArea;
}

/** Caixa delimitadora no espaço da imagem (ex.: saída YOLO para adesivo de vistoria). */
export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Temporário: modelo treinado com poucas imagens retorna conf baixa; 0.1 para debug. */
const STICKER_YOLO_CONF_THRESHOLD = 0.1;

/**
 * Decodifica saída YOLO de 1 classe (adesivo): [cx, cy, w, h, conf] por detecção.
 * Varre todas as detecções, encontra a de maior confiança (> 0.3) e retorna uma única BoundingBox.
 */
function decodeYOLOAdesivo(
  output: tf.Tensor,
  gain: number,
  padX: number,
  padY: number
): BoundingBox | null {
  let tensor = output.squeeze();
  if (tensor.shape[0] === 5) {
    tensor = tensor.transpose([1, 0]);
  }
  const data = tensor.arraySync() as number[][];
  tensor.dispose();

  console.log('[DEBUG ADESIVO] Linhas na saída YOLO:', data.length);

  let bestConf = 0;
  let bestBox: BoundingBox | null = null;
  let aboveThreshold = 0;

  for (const row of data) {
    const cx = row[0] ?? 0;
    const cy = row[1] ?? 0;
    const w = row[2] ?? 0;
    const h = row[3] ?? 0;
    const conf = row[4] ?? 0;
    if (conf > STICKER_YOLO_CONF_THRESHOLD) {
      aboveThreshold += 1;
      if (conf > bestConf) {
        bestConf = conf;
        bestBox = {
          x: Math.max(0, (cx - padX) / gain - (w / gain) / 2),
          y: Math.max(0, (cy - padY) / gain - (h / gain) / 2),
          w: w / gain,
          h: h / gain,
        };
      }
    }
  }

  console.log('[DEBUG ADESIVO] Caixas brutas achadas (conf > 0.3):', aboveThreshold, 'Melhor conf:', bestConf.toFixed(3));
  return bestBox;
}

/**
 * Roda o YOLO de vistorias na imagem e retorna a primeira bounding box do adesivo detectado, ou null.
 */
export async function detectStickerBox(blob: Blob): Promise<BoundingBox | null> {
  const yolo = await loadYOLOVistoriasModel();
  if (!yolo) return null;

  const img = await createImageBitmap(blob);
  const origW = img.width;
  const origH = img.height;

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 640;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#727272';
  ctx.fillRect(0, 0, 640, 640);

  const gain = Math.min(640 / origW, 640 / origH);
  const padX = (640 - origW * gain) / 2;
  const padY = (640 - origH * gain) / 2;
  ctx.drawImage(img, 0, 0, origW, origH, padX, padY, origW * gain, origH * gain);

  const inputTensor = tf.browser.fromPixels(canvas, 3).expandDims(0).toFloat().div(255.0) as unknown as tf.Tensor4D;
  const out = yolo.predict(inputTensor) as tf.Tensor;
  const rawOut = Array.isArray(out) ? out[0] : out;
  const box = decodeYOLOAdesivo(rawOut, gain, padX, padY);
  if (rawOut && typeof (rawOut as tf.Tensor).dispose === 'function') (rawOut as tf.Tensor).dispose();
  inputTensor.dispose();
  if (typeof img.close === 'function') img.close();

  if (!box) return null;
  return box;
}

/** Opções opcionais para depuração do pipeline OCR do adesivo. */
export interface ExtractStickerOptions {
  /** Chamado com data URL do canvas binarizado enviado ao Tesseract (debug visual). */
  onDebugBinarized?: (dataUrl: string) => void;
}

/** Binarização simples (preto/branco) para melhorar leitura do Tesseract. */
function binarizeStickerCanvasForOCR(canvas: HTMLCanvasElement, threshold = 150): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  const imgData = ctx.getImageData(0, 0, width, height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
    const v = gray > threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
}

/**
 * Recorta o adesivo na bounding box, padding branco, escala 3× e binarização para Tesseract.
 */
export function extractAndPrepareSticker(
  source: HTMLImageElement | HTMLCanvasElement,
  box: BoundingBox,
  options?: ExtractStickerOptions
): HTMLCanvasElement {
  const PADDING = 20;
  const SCALE = 3;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (!ctx) throw new Error('Não foi possível iniciar o contexto do Canvas.');

  canvas.width = (box.w + PADDING * 2) * SCALE;
  canvas.height = (box.h + PADDING * 2) * SCALE;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.drawImage(
    source,
    box.x, box.y, box.w, box.h,
    PADDING * SCALE, PADDING * SCALE, box.w * SCALE, box.h * SCALE
  );

  binarizeStickerCanvasForOCR(canvas, 150);

  if (options?.onDebugBinarized) {
    options.onDebugBinarized(canvas.toDataURL('image/png'));
  }

  return canvas;
}

/**
 * Decodifica saída YOLOv8: arraySync, threshold assimétrico, NMS por IoU (0.45), reverte letterbox.
 * ROI com limiar dinâmico (carro vs moto por aspect ratio) e filtro de fragmentos por altura mínima.
 */
export async function decodeYOLOOutput(output: tf.Tensor, gain: number, padX: number, padY: number): Promise<YOLOBox[]> {
  let tensor = output.squeeze();
  if (tensor.shape[0] === 6) {
    tensor = tensor.transpose([1, 0]);
  }

  const data = tensor.arraySync() as number[][];
  tensor.dispose();

  const rawBoxes: YOLOBox[] = [];

  for (const row of data) {
    let maxConf = 0;
    let detectedClass = -1;
    
    // Varre as classes (Índice 4: Caractere/ID 0, Índice 5: Placa/ID 1)
    for (let c = 4; c < row.length; c++) {
      if (row[c] > maxConf) {
        maxConf = row[c];
        detectedClass = c - 4;
      }
    }

    // --- ESTRATÉGIA DE THRESHOLD ASSIMÉTRICO ---
    // 0.25 para caracteres (ajuda a pegar o "I") e 0.45 para a placa (evita falsos positivos)
    const threshold = (detectedClass === 0) ? 0.25 : 0.45;

    if (maxConf > threshold) {
      const cx = row[0], cy = row[1], w = row[2], h = row[3];

      rawBoxes.push({
        x: Math.max(0, (cx - padX) / gain - (w / gain) / 2),
        y: Math.max(0, (cy - padY) / gain - (h / gain) / 2),
        w: w / gain,
        h: h / gain,
        classIndex: detectedClass,
        confidence: maxConf
      });
    }
  }

  console.log('[DEBUG YOLO] Caixas brutas retornadas:', rawBoxes.length);

  // 1. NMS (Non-Maximum Suppression) por IoU
  const filtered: YOLOBox[] = [];
  rawBoxes.sort((a, b) => b.confidence - a.confidence);
  for (const box of rawBoxes) {
    const isDuplicate = filtered.some(other => {
      if (box.classIndex === other.classIndex) {
        return calculateIoU(box, other) > 0.45;
      }
      return false;
    });
    if (!isDuplicate) filtered.push(box);
  }

  // 2. SEPARAÇÃO E LÓGICA DE ROI + FILTRO DE FRAGMENTOS DINÂMICO
  const plateBoxes = filtered.filter(b => b.classIndex === 1);
  let charBoxes = filtered.filter(b => b.classIndex === 0);

  console.log('[DEBUG YOLO] Placas achadas:', plateBoxes.length, 'Caracteres achados:', charBoxes.length);

  if (plateBoxes.length > 0) {
    const mainPlate = plateBoxes[0];

    // Diferenciar placa de carro vs moto pela proporção (moto ≈ 2 linhas, mais estreita)
    const isMotoPlate = (mainPlate.w / mainPlate.h) <= 2.2;
    const minCharHeight = isMotoPlate ? (mainPlate.h * 0.2) : (mainPlate.h * 0.35);

    charBoxes = charBoxes.filter(char => {
      const charCX = char.x + char.w / 2;
      const charCY = char.y + char.h / 2;
      const isInside =
        charCX >= mainPlate.x &&
        charCX <= mainPlate.x + mainPlate.w &&
        charCY >= mainPlate.y &&
        charCY <= mainPlate.y + mainPlate.h;
      const isTallEnough = char.h >= minCharHeight;
      return isInside && isTallEnough;
    });
  }

  // --- FILTRO DE CONSENSO (Regra de Negócio: Altura Uniforme) ---
  // Só aplica o filtro se tivermos uma amostragem mínima confiável (ex: 3 caracteres)
  if (charBoxes.length >= 3) {
    const charBoxesBeforeConsensus = charBoxes;
    try {
      const heights = charBoxes.map(b => b.h);
      const medianHeight = getMedian(heights);

      const minAcceptableHeight = medianHeight * 0.7;
      const maxAcceptableHeight = medianHeight * 1.3;
      const afterConsensus = charBoxes.filter(char => {
        const isConsistent = char.h >= minAcceptableHeight && char.h <= maxAcceptableHeight;
        if (!isConsistent) {
          console.warn(`[ALPR Segurança] Fragmento descartado! Altura: ${char.h.toFixed(1)} | Mediana da Placa: ${medianHeight.toFixed(1)}`);
        }
        return isConsistent;
      });
      // Fallback: se o filtro esvaziou a lista, mantém a anterior (evita perder placa com poucos caracteres)
      charBoxes = afterConsensus.length > 0 ? afterConsensus : charBoxesBeforeConsensus;
      if (afterConsensus.length === 0 && charBoxesBeforeConsensus.length > 0) {
        console.warn('[DEBUG YOLO] Filtro de consenso esvaziou charBoxes; usando lista anterior.');
      }
    } catch (e) {
      console.warn('[DEBUG YOLO] Erro no filtro de consenso, mantendo charBoxes:', e);
      charBoxes = charBoxesBeforeConsensus;
    }
  }

  // 3. FILTRO DE PROPORÇÃO (Protege o "I" e remove ruídos horizontais)
  charBoxes = charBoxes.filter(b => b.h > b.w);

  // 4. ORDENAÇÃO 2D (Crucial para Motos)
  charBoxes.sort((a, b) => {
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) > a.h * 0.5) return yDiff; 
    return a.x - b.x;
  });

  console.log(`[ALPR] Deteções: ${charBoxes.length} caracteres dentro da placa.`);
  return charBoxes;
}

/**
 * Aplica escala de cinza, binarização por threshold dinâmico e padding em um canvas de caractere.
 * Retorna um novo canvas quadrado (targetSize×targetSize) pronto para ir para a CNN.
 */
function preprocessCharacterCanvas(sourceCanvas: HTMLCanvasElement, targetSize: number = 64): HTMLCanvasElement {
  const ctx = sourceCanvas.getContext('2d')!;
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  // 1. Calcula a média de brilho para usar como threshold dinâmico
  let sumBrightness = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sumBrightness += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const meanBrightness = sumBrightness / (width * height || 1);
  const threshold = meanBrightness * 0.95;

  // 2. Binarização (preto e branco puro)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const color = gray < threshold ? 0 : 255; // 0 = preto (letra), 255 = branco (fundo)
    data[i] = data[i + 1] = data[i + 2] = color;
    data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);

  // --- NOVO: FILTRO DE EROSÃO (Afina as letras pretas) ---
  const erodedData = new Uint8ClampedArray(data);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx] === 0) {
        const topIdx = ((y - 1) * width + x) * 4;
        const bottomIdx = ((y + 1) * width + x) * 4;
        const leftIdx = (y * width + (x - 1)) * 4;
        const rightIdx = (y * width + (x + 1)) * 4;
        const top = data[topIdx];
        const bottom = data[bottomIdx];
        const left = data[leftIdx];
        const right = data[rightIdx];
        if (top === 255 || bottom === 255 || left === 255 || right === 255) {
          erodedData[idx] = erodedData[idx + 1] = erodedData[idx + 2] = 255;
        }
      }
    }
  }
  for (let i = 0; i < data.length; i++) {
    data[i] = erodedData[i];
  }
  ctx.putImageData(imageData, 0, 0);
  // --- FIM DA EROSÃO ---

  // 3. Canvas final com padding (bordas brancas) para a CNN
  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = targetSize;
  finalCanvas.height = targetSize;
  const finalCtx = finalCanvas.getContext('2d')!;

  finalCtx.fillStyle = '#FFFFFF';
  finalCtx.fillRect(0, 0, targetSize, targetSize);

  const margin = Math.floor(targetSize * 0.15);
  const drawSize = targetSize - margin * 2;
  finalCtx.drawImage(sourceCanvas, margin, margin, drawSize, drawSize);

  return finalCanvas;
}

/**
 * Recorta região da imagem original (imageData) usando box e retorna:
 * - tensor [1,64,64,1] binarizado (0–255) para a CNN
 * - dataUrl da letra pré-processada para debug.
 */
function cropAndPrepareForCNN(
  imageData: Uint8ClampedArray,
  origW: number,
  origH: number,
  box: YOLOBox
): { tensor: tf.Tensor4D; debugUrl: string } {
  const { x, y, w, h } = box;
  const x1 = Math.max(0, Math.floor(x));
  const y1 = Math.max(0, Math.floor(y));
  const x2 = Math.min(origW, Math.ceil(x + w));
  const y2 = Math.min(origH, Math.ceil(y + h));
  const cropW = Math.max(1, x2 - x1);
  const cropH = Math.max(1, y2 - y1);

  const canvas = document.createElement('canvas');
  canvas.width = cropW;
  canvas.height = cropH;
  const ctx = canvas.getContext('2d')!;
  const cropData = ctx.createImageData(cropW, cropH);

  for (let dy = 0; dy < cropH; dy++) {
    for (let dx = 0; dx < cropW; dx++) {
      const sx = x1 + dx;
      const sy = y1 + dy;
      const si = (sy * origW + sx) * 4;
      const di = (dy * cropW + dx) * 4;
      const gray = Math.round(
        imageData[si] * 0.299 +
        imageData[si + 1] * 0.587 +
        imageData[si + 2] * 0.114
      );
      cropData.data[di] = cropData.data[di + 1] = cropData.data[di + 2] = gray;
      cropData.data[di + 3] = 255;
    }
  }
  ctx.putImageData(cropData, 0, 0);

  const binCanvas = preprocessCharacterCanvas(canvas, 64);

  const tensor = tf.tidy(() => {
    let t = tf.browser.fromPixels(binCanvas);
    t = t.mean(2).expandDims(2).expandDims(0);
    return t as unknown as tf.Tensor4D;
  });

  const debugUrl = binCanvas.toDataURL('image/png');
  return { tensor, debugUrl };
}

/** Retorna o caractere de maior score dentro do conjunto (LETTERS ou NUMBERS). */
function getBestFromSet(scores: Float32Array, set: string): string {
  let bestChar = '';
  let maxScore = -1;
  for (let i = 0; i < CHAR_CLASSES.length; i++) {
    const char = CHAR_CLASSES[i];
    if (set.includes(char) && scores[i] > maxScore) {
      maxScore = scores[i];
      bestChar = char;
    }
  }
  return bestChar || '?';
}

/**
 * Trava de segurança: refina a predição da CNN pela posição na placa.
 * Posições 0,1,2 = só letras; 3,5,6 = só números; 4 = qualquer.
 */
function refinePrediction(scores: Float32Array, position: number): string {
  if (position <= 2) {
    return getBestFromSet(scores, LETTERS);
  }
  if (position === 3 || position >= 5) {
    return getBestFromSet(scores, NUMBERS);
  }
  let maxIdx = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[maxIdx]) maxIdx = i;
  }
  return CHAR_CLASSES[maxIdx] ?? '?';
}

/** Classifica um tensor [1,64,64,1] com a CNN e retorna o caractere e confiança. Usa refinePrediction quando position é informado. */
async function predictCharWithCNN(
  cnnModel: tf.LayersModel | tf.GraphModel,
  tensor: tf.Tensor4D,
  position?: number
): Promise<{ char: string; confidence: number }> {
  const logits = cnnModel.predict(tensor) as tf.Tensor;
  const data = (await logits.data()) as Float32Array;
  logits.dispose();
  tensor.dispose();

  let char: string;
  if (position !== undefined) {
    char = refinePrediction(data, position);
  } else {
    let bestIdx = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i] > data[bestIdx]) bestIdx = i;
    }
    char = CHAR_CLASSES[bestIdx] ?? '?';
  }

  const idx = CHAR_CLASSES.indexOf(char as (typeof CHAR_CLASSES)[number]);
  const confidence = (idx >= 0 ? data[idx] : 0) * 100;
  return { char: idx >= 0 ? char : '?', confidence };
}

/** Pipeline placa: Blob → Letterbox (fundo #727272, sem div/255) → YOLO → boxes → CNN → { text, confidence, debugImage, charDebugImages }. */
export async function runPlatePipelineYOLO(
  blob: Blob
): Promise<{ text: string; confidence: number; debugImage?: string; charDebugImages?: string[] } | null> {
  const yolo = await loadYOLOModel();
  const cnn = await loadCNNModel();
  if (!yolo || !cnn) return null;

  const img = await createImageBitmap(blob);
  const origW = img.width;
  const origH = img.height;

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 640;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#727272';
  ctx.fillRect(0, 0, 640, 640);

  const gain = Math.min(640 / origW, 640 / origH);
  const padX = (640 - origW * gain) / 2;
  const padY = (640 - origH * gain) / 2;

  ctx.drawImage(img, 0, 0, origW, origH, padX, padY, origW * gain, origH * gain);

  // fromPixels(canvas, 3) força RGB (remove Alpha). .div(255.0) normaliza e evita alucinação das caixas.
  const inputTensor = tf.browser.fromPixels(canvas, 3).expandDims(0).toFloat().div(255.0) as unknown as tf.Tensor4D;
  const output = yolo.predict(inputTensor) as tf.Tensor;
  const rawOut = Array.isArray(output) ? output[0] : output;
  const boxes = await decodeYOLOOutput(rawOut, gain, padX, padY);

  console.log('[DEBUG YOLO] Caixas após decode (charBoxes para CNN):', boxes.length);

  inputTensor.dispose();

  if (boxes.length === 0) {
    if (typeof img.close === 'function') img.close();
    return { text: '', confidence: 0, debugImage: '', charDebugImages: [] };
  }

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = origW;
  srcCanvas.height = origH;
  srcCanvas.getContext('2d')!.drawImage(img, 0, 0);
  const imageDataObj = srcCanvas.getContext('2d')!.getImageData(0, 0, origW, origH);
  const imageData = imageDataObj.data;
  if (typeof img.close === 'function') img.close();

  const toProcess = boxes.slice(0, 7);
  const charResults: { char: string; confidence: number }[] = [];
  const charDebugImages: string[] = [];

  // Trava posicional: 0,1,2 = letra; 3 = número; 4 = livre; 5,6 = número (refinePrediction em predictCharWithCNN)
  for (let i = 0; i < toProcess.length; i++) {
    const box = toProcess[i];
    const { tensor, debugUrl } = cropAndPrepareForCNN(imageData, origW, origH, box);
    charDebugImages.push(debugUrl);

    const result = await predictCharWithCNN(cnn, tensor, i);
    charResults.push(result);
  }

  let plateText = charResults.map((r) => r.char).join('');
  const avgConf =
    charResults.length > 0
      ? charResults.reduce((s, r) => s + r.confidence, 0) / charResults.length
      : 0;

  if (plateText.length >= 7) {
    plateText = applyMercosulMask(plateText);
  }

  const debugOut = document.createElement('canvas');
  debugOut.width = origW;
  debugOut.height = origH;
  const dctx = debugOut.getContext('2d')!;
  dctx.putImageData(imageDataObj, 0, 0);
  dctx.strokeStyle = 'lime';
  dctx.lineWidth = 2;
  toProcess.forEach((b) => dctx.strokeRect(b.x, b.y, b.w, b.h));
  const debugImage = debugOut.toDataURL('image/png');

  return {
    text: plateText,
    confidence: avgConf,
    debugImage,
    charDebugImages,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLAHE — Contrast Limited Adaptive Histogram Equalization (TF.js accelerated)
// ═══════════════════════════════════════════════════════════════════════════════
async function applyCLAHE(
  imageData: ImageData,
  tileGridX = 8, tileGridY = 8, clipLimit = 2.5
): Promise<void> {
  await ensureTF();
  const { width, height, data } = imageData;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  }
  const tileW = Math.ceil(width / tileGridX);
  const tileH = Math.ceil(height / tileGridY);
  const nBins = 256;
  const tileLUTs: Uint8Array[][] = [];

  for (let ty = 0; ty < tileGridY; ty++) {
    tileLUTs[ty] = [];
    for (let tx = 0; tx < tileGridX; tx++) {
      const x0 = tx * tileW, y0 = ty * tileH;
      const x1 = Math.min(x0 + tileW, width), y1 = Math.min(y0 + tileH, height);
      const tilePixels = (x1 - x0) * (y1 - y0);
      const hist = new Float32Array(nBins);
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++)
          hist[Math.min(255, Math.max(0, Math.round(gray[y * width + x])))]++;
      const clipThreshold = clipLimit * (tilePixels / nBins);
      let excess = 0;
      for (let i = 0; i < nBins; i++) {
        if (hist[i] > clipThreshold) { excess += hist[i] - clipThreshold; hist[i] = clipThreshold; }
      }
      const redistribute = excess / nBins;
      for (let i = 0; i < nBins; i++) hist[i] += redistribute;
      const lut = new Uint8Array(nBins);
      let cdf = 0;
      for (let i = 0; i < nBins; i++) { cdf += hist[i]; lut[i] = Math.round((cdf / tilePixels) * 255); }
      tileLUTs[ty][tx] = lut;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const val = Math.min(255, Math.max(0, Math.round(gray[y * width + x])));
      const ftx = (x / tileW) - 0.5, fty = (y / tileH) - 0.5;
      const tx0 = Math.max(0, Math.floor(ftx)), ty0 = Math.max(0, Math.floor(fty));
      const tx1 = Math.min(tileGridX - 1, tx0 + 1), ty1 = Math.min(tileGridY - 1, ty0 + 1);
      const cfx = Math.max(0, Math.min(1, ftx - tx0)), cfy = Math.max(0, Math.min(1, fty - ty0));
      const top = tileLUTs[ty0][tx0][val] + cfx * (tileLUTs[ty0][tx1][val] - tileLUTs[ty0][tx0][val]);
      const bot = tileLUTs[ty1][tx0][val] + cfx * (tileLUTs[ty1][tx1][val] - tileLUTs[ty1][tx0][val]);
      const result = Math.round(top + cfy * (bot - top));
      const idx = (y * width + x) * 4;
      data[idx] = data[idx + 1] = data[idx + 2] = result;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Gaussian Blur (3×3)
// ═══════════════════════════════════════════════════════════════════════════════
function gaussianBlur(data: Uint8ClampedArray, width: number, height: number) {
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const kSum = 16;
  const copy = new Uint8ClampedArray(data);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0; let ki = 0;
        for (let ky = -1; ky <= 1; ky++)
          for (let kx = -1; kx <= 1; kx++)
            sum += copy[((y + ky) * width + (x + kx)) * 4 + c] * kernel[ki++];
        data[(y * width + x) * 4 + c] = Math.round(sum / kSum);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Otsu's Binarization — automatic optimal threshold
// ═══════════════════════════════════════════════════════════════════════════════
function otsuThreshold(data: Uint8ClampedArray, width: number, height: number): number {
  const hist = new Float64Array(256);
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const gray = Math.round(data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114);
    hist[Math.min(255, Math.max(0, gray))]++;
  }

  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];

  let sumB = 0, wB = 0;
  let maxVariance = 0, bestT = 128;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const meanB = sumB / wB;
    const meanF = (sumAll - sumB) / wF;
    const variance = wB * wF * (meanB - meanF) * (meanB - meanF);
    if (variance > maxVariance) { maxVariance = variance; bestT = t; }
  }
  return bestT;
}

function applyOtsuBinarization(data: Uint8ClampedArray, width: number, height: number) {
  const threshold = otsuThreshold(data, width, height);
  console.log(`[ALPR] Otsu threshold: ${threshold}`);
  for (let i = 0; i < width * height; i++) {
    const gray = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
    const val = gray > threshold ? 255 : 0;
    const idx = i * 4;
    data[idx] = data[idx + 1] = data[idx + 2] = val;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Adaptive Thresholding (local mean) — fallback strategy
// ═══════════════════════════════════════════════════════════════════════════════
function adaptiveThreshold(data: Uint8ClampedArray, width: number, height: number, blockSize = 15, C = 2) {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  }
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * (width + 1) + (x + 1)] = rowSum + integral[y * (width + 1) + (x + 1)];
    }
  }
  const half = Math.floor(blockSize / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - half), y1 = Math.max(0, y - half);
      const x2 = Math.min(width - 1, x + half), y2 = Math.min(height - 1, y + half);
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integral[(y2 + 1) * (width + 1) + (x2 + 1)] - integral[y1 * (width + 1) + (x2 + 1)]
        - integral[(y2 + 1) * (width + 1) + x1] + integral[y1 * (width + 1) + x1];
      const mean = sum / area;
      const idx = (y * width + x) * 4;
      const val = gray[y * width + x] > mean - C ? 255 : 0;
      data[idx] = data[idx + 1] = data[idx + 2] = val;
    }
  }
}

function computeAdaptiveWindowSize(height: number): number {
  // Window ~ 1/8 da altura (tamanho aproximado da letra), sempre ímpar e no mínimo 15
  const approx = Math.floor(height / 8);
  const base = Math.max(15, approx);
  return base % 2 === 0 ? base + 1 : base;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Morphological Operations
// ═══════════════════════════════════════════════════════════════════════════════
function morphDilate(data: Uint8ClampedArray, w: number, h: number) {
  const copy = new Uint8ClampedArray(data);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let maxVal = 0;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++)
          maxVal = Math.max(maxVal, copy[((y + ky) * w + (x + kx)) * 4]);
      const idx = (y * w + x) * 4;
      data[idx] = data[idx + 1] = data[idx + 2] = maxVal;
    }
  }
}

function morphErode(data: Uint8ClampedArray, w: number, h: number) {
  const copy = new Uint8ClampedArray(data);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let minVal = 255;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++)
          minVal = Math.min(minVal, copy[((y + ky) * w + (x + kx)) * 4]);
      const idx = (y * w + x) * 4;
      data[idx] = data[idx + 1] = data[idx + 2] = minVal;
    }
  }
}

// Simple speckle removal: remove isolated dark pixels surrounded by white
function removeIsolatedPixels(data: Uint8ClampedArray, w: number, h: number) {
  const copy = new Uint8ClampedArray(data);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      const gray = copy[idx];
      if (gray < 128) {
        let darkNeighbors = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            if (kx === 0 && ky === 0) continue;
            const nIdx = ((y + ky) * w + (x + kx)) * 4;
            if (copy[nIdx] < 128) darkNeighbors++;
          }
        }
        // Pixels with 0–1 dark neighbors are treated as isolated noise
        if (darkNeighbors <= 1) {
          data[idx] = data[idx + 1] = data[idx + 2] = 255;
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Character-level Morphology — Thinning & Light Dilation for OCR
// ═══════════════════════════════════════════════════════════════════════════════
function thinCharacterCanvas(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  if (width <= 2 || height <= 2) return;

  const img = ctx.getImageData(0, 0, width, height);
  const data = img.data;
  const copy = new Uint8ClampedArray(data);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      const gray = copy[idx];
      // Only consider dark pixels (character strokes)
      if (gray < 128) {
        let whiteNeighbors = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            if (kx === 0 && ky === 0) continue;
            const nIdx = ((y + ky) * width + (x + kx)) * 4;
            if (copy[nIdx] > 200) whiteNeighbors++;
          }
        }
        // If surrounded by at least 2 white neighbors, thin this pixel
        if (whiteNeighbors >= 2) {
          data[idx] = data[idx + 1] = data[idx + 2] = 255;
        }
      }
    }
  }

  ctx.putImageData(img, 0, 0);
}

function dilateCharacterCanvas(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  if (width <= 2 || height <= 2) return;

  const img = ctx.getImageData(0, 0, width, height);
  const data = img.data;
  const copy = new Uint8ClampedArray(data);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      const gray = copy[idx];
      // Only expand from existing dark pixels into nearby white pixels
      if (gray >= 128) {
        let hasDarkNeighbor = false;
        for (let ky = -1; ky <= 1 && !hasDarkNeighbor; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            if (kx === 0 && ky === 0) continue;
            const nIdx = ((y + ky) * width + (x + kx)) * 4;
            if (copy[nIdx] < 128) {
              hasDarkNeighbor = true;
              break;
            }
          }
        }
        if (hasDarkNeighbor) {
          data[idx] = data[idx + 1] = data[idx + 2] = 0;
        }
      }
    }
  }

  ctx.putImageData(img, 0, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Noise Removal — remove connected components smaller than threshold
// ═══════════════════════════════════════════════════════════════════════════════
function removeSmallNoise(data: Uint8ClampedArray, w: number, h: number, minSizeFraction = 0.05) {
  const minArea = Math.round(h * minSizeFraction * h * minSizeFraction);
  const labels = new Int32Array(w * h);
  let nextLabel = 1;
  const labelSizes: Map<number, number> = new Map();
  const labelPixels: Map<number, number[]> = new Map();

  // Connected component labeling (4-connected) on dark pixels
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (data[idx * 4] >= 128 || labels[idx] !== 0) continue; // skip white or already labeled
      
      // BFS flood fill
      const label = nextLabel++;
      const queue = [idx];
      labels[idx] = label;
      const pixels: number[] = [];
      
      while (queue.length > 0) {
        const ci = queue.pop()!;
        pixels.push(ci);
        const cx = ci % w, cy = Math.floor(ci / w);
        const neighbors = [
          cy > 0 ? ci - w : -1,
          cy < h - 1 ? ci + w : -1,
          cx > 0 ? ci - 1 : -1,
          cx < w - 1 ? ci + 1 : -1,
        ];
        for (const ni of neighbors) {
          if (ni >= 0 && labels[ni] === 0 && data[ni * 4] < 128) {
            labels[ni] = label;
            queue.push(ni);
          }
        }
      }
      
      labelSizes.set(label, pixels.length);
      labelPixels.set(label, pixels);
    }
  }

  // Remove components smaller than threshold
  let removed = 0;
  for (const [label, size] of labelSizes) {
    if (size < minArea) {
      const pixels = labelPixels.get(label)!;
      for (const pi of pixels) {
        const idx = pi * 4;
        data[idx] = data[idx + 1] = data[idx + 2] = 255; // turn to white
      }
      removed++;
    }
  }
  if (removed > 0) console.log(`[ALPR] Removed ${removed} noise components (min area: ${minArea}px)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Upscale — ensure minimum width for character recognition
// ═══════════════════════════════════════════════════════════════════════════════
function upscaleCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, minWidth = 1000) {
  if (canvas.width >= minWidth) return;
  const scale = minWidth / canvas.width;
  const newW = Math.round(canvas.width * scale);
  const newH = Math.round(canvas.height * scale);
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = newW; tmpCanvas.height = newH;
  const tmpCtx = tmpCanvas.getContext('2d')!;
  // Use high-quality interpolation
  tmpCtx.imageSmoothingEnabled = true;
  tmpCtx.imageSmoothingQuality = 'high';
  tmpCtx.drawImage(canvas, 0, 0, newW, newH);
  canvas.width = newW; canvas.height = newH;
  ctx.drawImage(tmpCanvas, 0, 0);
  console.log(`[ALPR] Upscaled from ${Math.round(newW / scale)}px to ${newW}px (${scale.toFixed(1)}x)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Perspective Warp (contour-based homography)
// ═══════════════════════════════════════════════════════════════════════════════
function findPlateContour(gray: Uint8Array, w: number, h: number): { x: number; y: number }[] | null {
  const rowSums = new Float32Array(h);
  const colSums = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const diff = Math.abs(gray[y * w + x] - gray[y * w + (x - 1)]);
      rowSums[y] += diff; colSums[x] += diff;
    }
  }
  const rowT = Math.max(...rowSums) * 0.3;
  let top = 0, bottom = h - 1;
  for (let y = 0; y < h; y++) if (rowSums[y] > rowT) { top = y; break; }
  for (let y = h - 1; y >= 0; y--) if (rowSums[y] > rowT) { bottom = y; break; }
  const colT = Math.max(...colSums) * 0.3;
  let left = 0, right = w - 1;
  for (let x = 0; x < w; x++) if (colSums[x] > colT) { left = x; break; }
  for (let x = w - 1; x >= 0; x--) if (colSums[x] > colT) { right = x; break; }
  const rW = right - left, rH = bottom - top;
  if (rW < w * 0.2 || rH < h * 0.1) return null;
  return [
    { x: left, y: top }, { x: right, y: top },
    { x: right, y: bottom }, { x: left, y: bottom },
  ];
}

function perspectiveWarp(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(imageData.data[i * 4] * 0.299 + imageData.data[i * 4 + 1] * 0.587 + imageData.data[i * 4 + 2] * 0.114);
  }
  const contour = findPlateContour(gray, width, height);
  if (!contour) return;
  const [tl, tr, br, bl] = contour;
  const srcW = Math.max(tr.x - tl.x, br.x - bl.x);
  const srcH = Math.max(bl.y - tl.y, br.y - tr.y);
  if (srcW < 20 || srcH < 10) return;
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = srcW; tmpCanvas.height = srcH;
  const tmpCtx = tmpCanvas.getContext('2d')!;
  const srcData = ctx.getImageData(0, 0, width, height);
  const dstData = tmpCtx.createImageData(srcW, srcH);
  for (let dy = 0; dy < srcH; dy++) {
    for (let dx = 0; dx < srcW; dx++) {
      const u = dx / srcW, v = dy / srcH;
      const topX = tl.x + u * (tr.x - tl.x), topY = tl.y + u * (tr.y - tl.y);
      const botX = bl.x + u * (br.x - bl.x), botY = bl.y + u * (br.y - bl.y);
      const sx = Math.round(topX + v * (botX - topX));
      const sy = Math.round(topY + v * (botY - topY));
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
        const si = (sy * width + sx) * 4, di = (dy * srcW + dx) * 4;
        dstData.data[di] = srcData.data[si];
        dstData.data[di + 1] = srcData.data[si + 1];
        dstData.data[di + 2] = srcData.data[si + 2];
        dstData.data[di + 3] = 255;
      }
    }
  }
  canvas.width = srcW; canvas.height = srcH;
  canvas.getContext('2d')?.putImageData(dstData, 0, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Crop to ROI overlay region
// ═══════════════════════════════════════════════════════════════════════════════
function cropToOverlay(
  canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D,
  img: HTMLImageElement, type: 'plate' | 'number'
) {
  canvas.width = img.width; canvas.height = img.height;
  ctx.drawImage(img, 0, 0);
  // Keep crop aligned with the camera guidance overlay:
  // - plate: large square (1:1) to allow freer framing (cars + bikes)
  // - number: keep compact rectangle
  const rawW = type === 'plate'
    ? Math.min(img.width, img.height) * 0.78
    : img.width * 0.45;
  const rawH = type === 'plate'
    ? rawW
    : img.height * 0.18;
  // Add 15% padding for OCR breathing room
  const padX = rawW * 0.15;
  const padY = rawH * 0.15;
  const cropX = Math.max(0, (img.width - rawW) / 2 - padX);
  const cropY = Math.max(0, (img.height - rawH) / 2 - padY);
  const cropW = Math.min(img.width - cropX, rawW + padX * 2);
  const cropH = Math.min(img.height - cropY, rawH + padY * 2);
  const cropped = ctx.getImageData(cropX, cropY, cropW, cropH);
  canvas.width = cropW; canvas.height = cropH;
  // White background fill for padding areas
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, cropW, cropH);
  ctx.putImageData(cropped, 0, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Full Preprocessing Pipeline — returns both processed blob AND debug image
// ═══════════════════════════════════════════════════════════════════════════════
async function preprocessAdvanced(
  blob: Blob,
  cropType: 'plate' | 'number' | undefined,
  strategy: 'otsu' | 'adaptive' | 'fixed',
  globalThreshold?: number
): Promise<{ processed: Blob; debugImage: string }> {
  await ensureTF();

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d')!;
        if (!ctx) return reject(new Error('No canvas context'));

        // Step 1: Crop to ROI
        if (cropType) {
          cropToOverlay(canvas, ctx, img, cropType);
        } else {
          ctx.drawImage(img, 0, 0);
        }

        // Step 2: Perspective correction (plate only)
        if (cropType === 'plate') {
          perspectiveWarp(canvas, ctx);
        }

        // Step 3: Upscale to minimum 1000px width
        const currentCtx = canvas.getContext('2d')!;
        upscaleCanvas(canvas, currentCtx, 1000);

        const w = canvas.width, h = canvas.height;
        const freshCtx = canvas.getContext('2d')!;
        let imageData = freshCtx.getImageData(0, 0, w, h);

        // Step 4: CLAHE — Adaptive Histogram Equalization (TF.js)
        // Usar grade de tiles proporcional ao tamanho da janela adaptativa (baseada na altura)
        const winSize = computeAdaptiveWindowSize(h);
        const tilesX = Math.max(4, Math.round(w / winSize));
        const tilesY = Math.max(4, Math.round(h / winSize));
        await applyCLAHE(imageData, tilesX, tilesY, 3.2);

        // Step 5: Gaussian Blur (noise reduction)
        gaussianBlur(imageData.data, w, h);

        // Step 6: Binarization — Adaptive thresholding (local mean over Gaussian-blurred image)
        // Janela proporcional à altura e C maior para eliminar fundo cinza de pátio/carro.
        adaptiveThreshold(imageData.data, w, h, winSize, 9);

        // Step 7: Morphological Opening (Erode then Dilate) — remove speckles and thin noise
        // Pequeno kernel 3x3 aproximando uma abertura com efeito de 2x2 em vizinhança local.
        morphErode(imageData.data, w, h);
        morphDilate(imageData.data, w, h);

        // Step 8: Remove small noise (< 5% of plate height)
        removeSmallNoise(imageData.data, w, h, 0.05);

        // Step 9: Remove isolated dark pixels (single speckles from grille/ground)
        removeIsolatedPixels(imageData.data, w, h);

        // Step 10: Normalize output to pure black/white (no intermediate grays)
        for (let i = 0; i < w * h; i++) {
          const idx = i * 4;
          const gray = imageData.data[idx];
          const v = gray > 128 ? 255 : 0;
          imageData.data[idx] = imageData.data[idx + 1] = imageData.data[idx + 2] = v;
        }

        freshCtx.putImageData(imageData, 0, 0);

        // Generate debug image (data URL)
        const debugImage = canvas.toDataURL('image/png');

        canvas.toBlob(
          (result) => {
            URL.revokeObjectURL(img.src);
            result ? resolve({ processed: result, debugImage }) : reject(new Error('toBlob failed'));
          },
          'image/png'
        );
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Mercosul Mask — Position-based character correction
// ═══════════════════════════════════════════════════════════════════════════════
const DIGIT_TO_LETTER: Record<string, string> = {
  '0': 'O', '1': 'I', '2': 'Z', '3': 'E', '4': 'A',
  '5': 'S', '6': 'G', '7': 'T', '8': 'B', '9': 'P',
};
const LETTER_TO_DIGIT: Record<string, string> = {
  'O': '0', 'I': '1', 'Z': '2', 'E': '3', 'A': '4',
  'S': '5', 'G': '6', 'T': '7', 'B': '8', 'P': '9', 'Q': '0', 'D': '0',
};

function applyMercosulMask(text: string): string {
  if (text.length < 7) return text;
  const chars = text.slice(0, 7).split('');

  // Positions 0,1,2 MUST be letters
  for (let i = 0; i < 3; i++) {
    if (/\d/.test(chars[i]) && DIGIT_TO_LETTER[chars[i]]) {
      chars[i] = DIGIT_TO_LETTER[chars[i]];
    }
  }

  // Position 3 MUST be a number
  if (/[A-Z]/.test(chars[3]) && LETTER_TO_DIGIT[chars[3]]) {
    chars[3] = LETTER_TO_DIGIT[chars[3]];
  }

  // Positions 5,6 MUST be numbers
  for (let i = 5; i < 7; i++) {
    if (/[A-Z]/.test(chars[i]) && LETTER_TO_DIGIT[chars[i]]) {
      chars[i] = LETTER_TO_DIGIT[chars[i]];
    }
  }

  return chars.join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// OCR: Placa = YOLO + CNN; Número = pré-processamento + Tesseract
// ═══════════════════════════════════════════════════════════════════════════════
export async function ocrWithVoting(
  blob: Blob,
  cropType: 'plate' | 'number',
  createWorkerFn: () => Promise<any>,
  whitelist: string
): Promise<{ text: string; confidence: number; corrections?: string[]; debugImage?: string; charDebugImages?: string[] }> {
  // ═══ PLACA: crop quadrado 1:1 → 640×640 → YOLO + CNN ═══
  if (cropType === 'plate') {
    try {
      const yolo = await loadYOLOModel();
      const cnn = await loadCNNModel();
      if (!yolo || !cnn) {
        console.error('[ALPR] Modelos YOLO/CNN indisponíveis em ocrWithVoting; retornando confiança 0');
        return { text: '', confidence: 0 };
      }
      const result = await runPlatePipelineYOLO(blob);
      if (!result) return { text: '', confidence: 0 };
      return {
        text: result.text,
        confidence: result.confidence,
        corrections: [],
        debugImage: result.debugImage,
        charDebugImages: result.charDebugImages,
      };
    } catch (e) {
      console.error('[ALPR] YOLO+CNN plate pipeline failed:', e);
      return { text: '', confidence: 0 };
    }
  }

  // ═══ NÚMERO DA VISTORIA: pré-processamento + Tesseract ═══
  const strategies: Array<{ strategy: 'adaptive'; threshold?: number }> = [
    { strategy: 'adaptive' },
  ];
  const preprocessResults: { processed: Blob; debugImage: string; strategy: string }[] = [];
  const preprocessPromises = strategies.map(async (s) => {
    try {
      const { processed, debugImage } = await preprocessAdvanced(blob, cropType, s.strategy, s.threshold);
      return { processed, debugImage, strategy: s.strategy };
    } catch { return null; }
  });
  const preprocessed = await Promise.all(preprocessPromises);
  for (const r of preprocessed) if (r) preprocessResults.push(r);

  if (preprocessResults.length === 0) return { text: '', confidence: 0 };

  // Full-image OCR (Tesseract) para número
  const results: { text: string; confidence: number; debugImage?: string }[] = [];

  for (const prep of preprocessResults) {
    try {
      const worker = await createWorkerFn();
      await worker.setParameters({
        tessedit_char_whitelist: whitelist,
      });
      const { data } = await worker.recognize(prep.processed);
      await worker.terminate();

      let text = data.text.replace(/\s/g, '').toUpperCase();
      results.push({ text, confidence: data.confidence || 0, debugImage: prep.debugImage });
    } catch (err) {
      console.error('OCR strategy failed:', err);
    }
  }

  if (results.length === 0) return { text: '', confidence: 0 };
  results.sort((a, b) => b.confidence - a.confidence);
  return { text: results[0].text, confidence: results[0].confidence, debugImage: results[0].debugImage };
}

/**
 * Recorta o quadrado central da imagem (menor lado × menor lado) e redimensiona para 640×640.
 * Usado antes do pipeline ALPR para eliminar letterbox: o YOLO recebe exatamente o que o usuário enquadrou.
 */
export async function cropToSquare640(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.width;
      const h = img.height;
      const min = Math.min(w, h);
      const sx = (w - min) / 2;
      const sy = (h - min) / 2;

      const canvas = document.createElement('canvas');
      canvas.width = YOLO_INPUT_SIZE;
      canvas.height = YOLO_INPUT_SIZE;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, sx, sy, min, min, 0, 0, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE);

      URL.revokeObjectURL(img.src);
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('cropToSquare640: toBlob failed'))),
        'image/jpeg',
        0.92
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error('cropToSquare640: image load failed'));
    };
    img.src = URL.createObjectURL(blob);
  });
}

// Helper: convert Blob to ImageData for classifier
async function blobToImageData(blob: Blob): Promise<{ imageData: Uint8ClampedArray; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height);
      URL.revokeObjectURL(img.src);
      resolve({ imageData: data.data, w: img.width, h: img.height });
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Backward-compatible export
// ═══════════════════════════════════════════════════════════════════════════════
export function preprocessForOCR(blob: Blob, cropType?: 'plate' | 'number'): Promise<Blob> {
  return preprocessAdvanced(blob, cropType, 'adaptive').then(r => r.processed);
}

// ═══════════════════════════════════════════════════════════════════════════════
// O/Q Ambiguity Detection
// ═══════════════════════════════════════════════════════════════════════════════
export function detectOQAmbiguity(plate: string): string | null {
  if (plate.length !== 7) return null;
  const letterPositions = [0, 1, 2, 4];
  const ambiguous: number[] = [];
  for (const pos of letterPositions) {
    const ch = plate[pos];
    if (ch === 'O' || ch === 'Q' || ch === '0') ambiguous.push(pos);
  }
  if (ambiguous.length > 0) {
    return `Detectamos '${plate}'. Verifique se 'O', 'Q' ou '0' estão corretos nas posições: ${ambiguous.map(p => p + 1).join(', ')}.`;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Image Compression
// ═══════════════════════════════════════════════════════════════════════════════
export function compressImage(blob: Blob, maxWidth = 1280, quality = 0.7): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round((h * maxWidth) / w); w = maxWidth; }
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('No canvas context'));
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (result) => { URL.revokeObjectURL(img.src); result ? resolve(result) : reject(new Error('toBlob failed')); },
        'image/jpeg', quality
      );
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}
