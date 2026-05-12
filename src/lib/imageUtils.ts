/**
 * ALPR — Pipeline de 2 estágios: YOLOv8 (detecção) + CNN (classificação)
 * Placa: YOLO detecta caracteres → recorte 64×64 → CNN classifica → Máscara Mercosul
 * Número da vistoria: pré-processamento + Tesseract (fallback)
 */

import * as tf from '@tensorflow/tfjs';
// Backend super-rápido para CPU caso o celular não suporte WebGL (Placa de vídeo)
import '@tensorflow/tfjs-backend-wasm';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';

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

// Configuração robusta de Backend (WebGL -> WASM -> CPU)
let tfReady: Promise<void> | null = null;
function ensureTF(): Promise<void> {
  if (!tfReady) {
    tfReady = (async () => {
      try {
        await tf.setBackend('webgl');
        await tf.ready();
        console.log('[ALPR] Motor da IA ativado com sucesso: WebGL (GPU)');
      } catch (e1) {
        console.warn('[ALPR] WebGL indisponível no dispositivo, tentando WASM...', e1);
        try {
          // Usa o CDN global para os binários do WASM (não pesa o seu build final)
          setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm/dist/');
          await tf.setBackend('wasm');
          await tf.ready();
          console.log('[ALPR] Motor da IA ativado com sucesso: WASM (Alta Performance CPU)');
        } catch (e2) {
          console.warn('[ALPR] WASM falhou. Entrando em modo segurança: CPU puro (Mais Lento)...', e2);
          await tf.setBackend('cpu');
          await tf.ready();
        }
      }
    })();
  }
  return tfReady;
}

let yoloModelPromise: Promise<tf.GraphModel | tf.LayersModel | null> | null = null;
let yoloVistoriasModelPromise: Promise<tf.GraphModel | tf.LayersModel | null> | null = null;
let cnnModelPromise: Promise<tf.GraphModel | tf.LayersModel | null> | null = null;

export async function loadYOLOModel(): Promise<tf.GraphModel | tf.LayersModel | null> {
  await ensureTF();
  if (!yoloModelPromise) {
    yoloModelPromise = (async () => {
      try {
        const g = await tf.loadGraphModel('/model_yolo_placas/model.json');
        return g;
      } catch (e1) {
        try {
          return await tf.loadLayersModel('/model_yolo_placas/model.json');
        } catch (e2) {
          console.error('[ALPR YOLO] Falha ao carregar o modelo de placa', e2);
          return null;
        }
      }
    })();
  }
  return yoloModelPromise;
}

export async function loadYOLOVistoriasModel(): Promise<tf.GraphModel | tf.LayersModel | null> {
  await ensureTF();
  if (!yoloVistoriasModelPromise) {
    yoloVistoriasModelPromise = (async () => {
      try {
        const g = await tf.loadGraphModel('/model_yolo_vistorias/model.json');
        return g;
      } catch (e1) {
        try {
          return await tf.loadLayersModel('/model_yolo_vistorias/model.json');
        } catch (e2) {
          console.error('[YOLO Vistorias] Falha ao carregar o modelo de adesivo', e2);
          return null;
        }
      }
    })();
  }
  return yoloVistoriasModelPromise;
}

export async function loadCNNModel(): Promise<tf.GraphModel | tf.LayersModel | null> {
  await ensureTF();
  if (!cnnModelPromise) {
    cnnModelPromise = (async () => {
      try {
        // Tenta carregar como Graph (Padrão YOLO)
        return await tf.loadGraphModel('/model_cnn/model.json');
      } catch (e1) {
        try {
          // Se falhar, tenta carregar como Layers (Padrão Keras/CNN)
          return await tf.loadLayersModel('/model_cnn/model.json');
        } catch (e2) {
          console.error('[ALPR CNN] Falha crítica ao carregar a CNN', e2);
          return null;
        }
      }
    })();
  }
  return cnnModelPromise;
}

/** * Pré-carrega E aquece (Warm-up) os modelos. 
 * Passar um tensor vazio obriga a GPU a compilar as rotinas antes de o usuário tirar a foto.
 */
export async function preloadAlprModels(): Promise<void> {
  try {
    const [yolo, yoloAdesivo, cnn] = await Promise.all([
      loadYOLOModel(),
      loadYOLOVistoriasModel(),
      loadCNNModel()
    ]);

    console.log('[ALPR] Iniciando Aquecimento (Warm-up) para evitar congelamento de tela...');

    if (yolo) {
      tf.tidy(() => {
        const dummy = tf.zeros([1, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE, 3]) as tf.Tensor;
        const out = yolo.predict(dummy) as tf.Tensor;
        out.dataSync(); // Executa e descarta
      });
    }

    if (yoloAdesivo) {
      tf.tidy(() => {
        const dummy = tf.zeros([1, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE, 3]) as tf.Tensor;
        const out = yoloAdesivo.predict(dummy) as tf.Tensor;
        out.dataSync();
      });
    }

    if (cnn) {
      tf.tidy(() => {
        const dummy = tf.zeros([1, 64, 64, 1]) as tf.Tensor;
        const out = cnn.predict(dummy) as tf.Tensor;
        out.dataSync();
      });
    }

    console.log('[ALPR] Motores aquecidos e prontos para inferência instantânea.');
  } catch (err) {
    console.warn('[ALPR] Falha no aquecimento', err);
  }
}

interface YOLOBox {
  x: number;
  y: number;
  w: number;
  h: number;
  classIndex: number;
  confidence: number;
  yoloCoords?: { cx: number; cy: number; w: number; h: number };
}

function getMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

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

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const STICKER_YOLO_CONF_THRESHOLD = 0.1;

async function decodeYOLOAdesivo(
  output: tf.Tensor,
  gain: number,
  padX: number,
  padY: number
): Promise<BoundingBox | null> {
  const tensor = tf.tidy(() => {
    let t = output.squeeze();
    if (t.shape[0] === 5) t = t.transpose([1, 0]);
    return t;
  });

  // Trocado arraySync() por array() para não congelar a UI do celular
  const data = await tensor.array() as number[][];
  tensor.dispose();

  let bestConf = 0;
  let bestBox: BoundingBox | null = null;

  for (const row of data) {
    const cx = row[0] ?? 0;
    const cy = row[1] ?? 0;
    const w = row[2] ?? 0;
    const h = row[3] ?? 0;
    const conf = row[4] ?? 0;
    if (conf > STICKER_YOLO_CONF_THRESHOLD) {
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
  return bestBox;
}

export async function detectStickerBox(blob: Blob): Promise<BoundingBox | null> {
  const yolo = await loadYOLOVistoriasModel();
  if (!yolo) return null;

  const img = await createImageBitmap(blob);
  const origW = img.width;
  const origH = img.height;

  const canvas = document.createElement('canvas');
  canvas.width = YOLO_INPUT_SIZE;
  canvas.height = YOLO_INPUT_SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#727272';
  ctx.fillRect(0, 0, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE);

  const gain = Math.min(YOLO_INPUT_SIZE / origW, YOLO_INPUT_SIZE / origH);
  const padX = (YOLO_INPUT_SIZE - origW * gain) / 2;
  const padY = (YOLO_INPUT_SIZE - origH * gain) / 2;
  ctx.drawImage(img, 0, 0, origW, origH, padX, padY, origW * gain, origH * gain);

  const inputTensor = tf.browser.fromPixels(canvas, 3).expandDims(0).toFloat().div(255.0) as unknown as tf.Tensor4D;
  const out = yolo.predict(inputTensor) as tf.Tensor;
  const rawOut = Array.isArray(out) ? out[0] : out;
  
  const box = await decodeYOLOAdesivo(rawOut, gain, padX, padY);
  
  // Limpeza rígida para não causar Memory Leak
  if (Array.isArray(out)) out.forEach(t => t.dispose());
  else out.dispose();
  inputTensor.dispose();
  if (typeof img.close === 'function') img.close();

  return box;
}

export interface ExtractStickerOptions {
  onDebugBinarized?: (dataUrl: string) => void;
}

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

export async function decodeYOLOOutput(output: tf.Tensor, gain: number, padX: number, padY: number): Promise<YOLOBox[]> {
  const tensor = tf.tidy(() => {
    let t = output.squeeze();
    if (t.shape[0] === 6) t = t.transpose([1, 0]);
    return t;
  });

  // Assíncrono para manter os loaders da interface rodando suavemente
  const data = await tensor.array() as number[][];
  tensor.dispose();

  const rawBoxes: YOLOBox[] = [];

  for (const row of data) {
    let maxConf = 0;
    let detectedClass = -1;
    
    for (let c = 4; c < row.length; c++) {
      if (row[c] > maxConf) {
        maxConf = row[c];
        detectedClass = c - 4;
      }
    }

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

  let plateBoxes = filtered.filter(b => b.classIndex === 1);
  let charBoxes = filtered.filter(b => b.classIndex === 0);

  // --- 🛡️ MÁGICA DO ARQUITETO: Auto-correção de Classes Invertidas ---
  // Uma placa de carro NUNCA terá mais Placas do que Caracteres.
  // Se isso acontecer, significa que o Roboflow inverteu os IDs no treinamento.
  if (plateBoxes.length > charBoxes.length) {
    console.warn("[ALPR] Classes invertidas detectadas pelo sistema! Destrocando...");
    const temp = plateBoxes;
    plateBoxes = charBoxes;
    charBoxes = temp;
  }
  // -------------------------------------------------------------------

  if (plateBoxes.length > 0) {
    const mainPlate = plateBoxes[0];
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

  if (charBoxes.length >= 3) {
    const charBoxesBeforeConsensus = charBoxes;
    try {
      const heights = charBoxes.map(b => b.h);
      const medianHeight = getMedian(heights);

      const minAcceptableHeight = medianHeight * 0.7;
      const maxAcceptableHeight = medianHeight * 1.3;
      const afterConsensus = charBoxes.filter(char => {
        return char.h >= minAcceptableHeight && char.h <= maxAcceptableHeight;
      });
      charBoxes = afterConsensus.length > 0 ? afterConsensus : charBoxesBeforeConsensus;
    } catch (e) {
      charBoxes = charBoxesBeforeConsensus;
    }
  }

  charBoxes = charBoxes.filter(b => b.h > b.w);

  charBoxes.sort((a, b) => {
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) > a.h * 0.5) return yDiff; 
    return a.x - b.x;
  });

  return charBoxes;
}

function preprocessCharacterCanvas(sourceCanvas: HTMLCanvasElement, targetSize: number = 64): HTMLCanvasElement {
  const ctx = sourceCanvas.getContext('2d')!;
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  let sumBrightness = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sumBrightness += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const meanBrightness = sumBrightness / (width * height || 1);
  const threshold = meanBrightness * 0.95;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const color = gray < threshold ? 0 : 255; 
    data[i] = data[i + 1] = data[i + 2] = color;
    data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);

  const erodedData = new Uint8ClampedArray(data);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx] === 0) {
        const topIdx = ((y - 1) * width + x) * 4;
        const bottomIdx = ((y + 1) * width + x) * 4;
        const leftIdx = (y * width + (x - 1)) * 4;
        const rightIdx = (y * width + (x + 1)) * 4;
        if (data[topIdx] === 255 || data[bottomIdx] === 255 || data[leftIdx] === 255 || data[rightIdx] === 255) {
          erodedData[idx] = erodedData[idx + 1] = erodedData[idx + 2] = 255;
        }
      }
    }
  }
  for (let i = 0; i < data.length; i++) {
    data[i] = erodedData[i];
  }
  ctx.putImageData(imageData, 0, 0);

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

function refinePrediction(scores: Float32Array, position: number): string {
  if (position <= 2) return getBestFromSet(scores, LETTERS);
  if (position === 3 || position >= 5) return getBestFromSet(scores, NUMBERS);
  let maxIdx = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[maxIdx]) maxIdx = i;
  }
  return CHAR_CLASSES[maxIdx] ?? '?';
}

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
  canvas.width = YOLO_INPUT_SIZE;
  canvas.height = YOLO_INPUT_SIZE;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE);

  const gain = Math.min(YOLO_INPUT_SIZE / origW, YOLO_INPUT_SIZE / origH);
  const padX = (YOLO_INPUT_SIZE - origW * gain) / 2;
  const padY = (YOLO_INPUT_SIZE - origH * gain) / 2;

  ctx.drawImage(img, 0, 0, origW, origH, padX, padY, origW * gain, origH * gain);

  const inputTensor = tf.browser.fromPixels(canvas, 3).expandDims(0).toFloat().div(255.0) as unknown as tf.Tensor4D;
  const output = yolo.predict(inputTensor) as tf.Tensor;
  const rawOut = Array.isArray(output) ? output[0] : output;
  const boxes = await decodeYOLOOutput(rawOut, gain, padX, padY);

  if (Array.isArray(output)) output.forEach(t => t.dispose());
  else output.dispose();
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
// CLAHE — Contrast Limited Adaptive Histogram Equalization
// ═══════════════════════════════════════════════════════════════════════════════
async function applyCLAHE(
  imageData: ImageData,
  tileGridX = 8, tileGridY = 8, clipLimit = 2.5
): Promise<void> {
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
// Adaptive Thresholding (local mean)
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
  const approx = Math.floor(height / 8);
  const base = Math.max(15, approx);
  return base % 2 === 0 ? base + 1 : base;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Morphological Operations & Noise Removal
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
        if (darkNeighbors <= 1) {
          data[idx] = data[idx + 1] = data[idx + 2] = 255;
        }
      }
    }
  }
}

function removeSmallNoise(data: Uint8ClampedArray, w: number, h: number, minSizeFraction = 0.05) {
  const minArea = Math.round(h * minSizeFraction * h * minSizeFraction);
  const labels = new Int32Array(w * h);
  let nextLabel = 1;
  const labelSizes: Map<number, number> = new Map();
  const labelPixels: Map<number, number[]> = new Map();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (data[idx * 4] >= 128 || labels[idx] !== 0) continue; 
      
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

  for (const [label, size] of labelSizes) {
    if (size < minArea) {
      const pixels = labelPixels.get(label)!;
      for (const pi of pixels) {
        const idx = pi * 4;
        data[idx] = data[idx + 1] = data[idx + 2] = 255; 
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Upscale 
// ═══════════════════════════════════════════════════════════════════════════════
function upscaleCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, minWidth = 1000) {
  if (canvas.width >= minWidth) return;
  const scale = minWidth / canvas.width;
  const newW = Math.round(canvas.width * scale);
  const newH = Math.round(canvas.height * scale);
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = newW; tmpCanvas.height = newH;
  const tmpCtx = tmpCanvas.getContext('2d')!;
  tmpCtx.imageSmoothingEnabled = true;
  tmpCtx.imageSmoothingQuality = 'high';
  tmpCtx.drawImage(canvas, 0, 0, newW, newH);
  canvas.width = newW; canvas.height = newH;
  ctx.drawImage(tmpCanvas, 0, 0);
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
  const rawW = type === 'plate' ? Math.min(img.width, img.height) * 0.78 : img.width * 0.45;
  const rawH = type === 'plate' ? rawW : img.height * 0.18;
  const padX = rawW * 0.15;
  const padY = rawH * 0.15;
  const cropX = Math.max(0, (img.width - rawW) / 2 - padX);
  const cropY = Math.max(0, (img.height - rawH) / 2 - padY);
  const cropW = Math.min(img.width - cropX, rawW + padX * 2);
  const cropH = Math.min(img.height - cropY, rawH + padY * 2);
  const cropped = ctx.getImageData(cropX, cropY, cropW, cropH);
  canvas.width = cropW; canvas.height = cropH;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, cropW, cropH);
  ctx.putImageData(cropped, 0, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Full Preprocessing Pipeline 
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

        if (cropType) cropToOverlay(canvas, ctx, img, cropType);
        else ctx.drawImage(img, 0, 0);

        if (cropType === 'plate') perspectiveWarp(canvas, ctx);

        const currentCtx = canvas.getContext('2d')!;
        upscaleCanvas(canvas, currentCtx, 1000);

        const w = canvas.width, h = canvas.height;
        const freshCtx = canvas.getContext('2d')!;
        let imageData = freshCtx.getImageData(0, 0, w, h);

        const winSize = computeAdaptiveWindowSize(h);
        const tilesX = Math.max(4, Math.round(w / winSize));
        const tilesY = Math.max(4, Math.round(h / winSize));
        await applyCLAHE(imageData, tilesX, tilesY, 3.2);

        gaussianBlur(imageData.data, w, h);
        adaptiveThreshold(imageData.data, w, h, winSize, 9);
        morphErode(imageData.data, w, h);
        morphDilate(imageData.data, w, h);
        removeSmallNoise(imageData.data, w, h, 0.05);
        removeIsolatedPixels(imageData.data, w, h);

        for (let i = 0; i < w * h; i++) {
          const idx = i * 4;
          const gray = imageData.data[idx];
          const v = gray > 128 ? 255 : 0;
          imageData.data[idx] = imageData.data[idx + 1] = imageData.data[idx + 2] = v;
        }

        freshCtx.putImageData(imageData, 0, 0);
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
// Mercosul Mask 
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

  for (let i = 0; i < 3; i++) {
    if (/\d/.test(chars[i]) && DIGIT_TO_LETTER[chars[i]]) chars[i] = DIGIT_TO_LETTER[chars[i]];
  }

  if (/[A-Z]/.test(chars[3]) && LETTER_TO_DIGIT[chars[3]]) {
    chars[3] = LETTER_TO_DIGIT[chars[3]];
  }

  for (let i = 5; i < 7; i++) {
    if (/[A-Z]/.test(chars[i]) && LETTER_TO_DIGIT[chars[i]]) chars[i] = LETTER_TO_DIGIT[chars[i]];
  }

  return chars.join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// OCR Principal 
// ═══════════════════════════════════════════════════════════════════════════════
export async function ocrWithVoting(
  blob: Blob,
  cropType: 'plate' | 'number',
  createWorkerFn: () => Promise<any>,
  whitelist: string
): Promise<{ text: string; confidence: number; corrections?: string[]; debugImage?: string; charDebugImages?: string[] }> {
  if (cropType === 'plate') {
    try {
      const yolo = await loadYOLOModel();
      const cnn = await loadCNNModel();
      if (!yolo || !cnn) return { text: '', confidence: 0 };
      
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
      console.error('[ALPR] YOLO+CNN falhou:', e);
      return { text: '', confidence: 0 };
    }
  }

  // Adesivo
  const strategies: Array<{ strategy: 'adaptive'; threshold?: number }> = [{ strategy: 'adaptive' }];
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

  const results: { text: string; confidence: number; debugImage?: string }[] = [];

  for (const prep of preprocessResults) {
    try {
      const worker = await createWorkerFn();
      await worker.setParameters({ tessedit_char_whitelist: whitelist });
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

export function preprocessForOCR(blob: Blob, cropType?: 'plate' | 'number'): Promise<Blob> {
  return preprocessAdvanced(blob, cropType, 'adaptive').then(r => r.processed);
}

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