/**
 * Instrumentação do preview da placa em tempo real — somente DEV.
 * Use o console para correlacionar picos de tempo com travadas visuais.
 */

export type PlatePreviewStageTimings = {
  drawImageMs: number;
  yoloLetterboxMs: number;
  yoloInferMs: number;
  yoloDecodeMs: number;
  getImageDataMs: number;
  sharpnessMs: number;
  cnnCropPreprocessMs: number;
  cnnInferMs: number;
  cnnInferCount: number;
  gateMs: number;
  overlayMs: number;
  reactSetStateMs: number;
  totalMs: number;
  hadSevenBoxes: boolean;
  ranFullCnn: boolean;
  tfBackend: string;
};

let lastReport: PlatePreviewStageTimings | null = null;
let cnnFrameCount = 0;
let yoloOnlyFrameCount = 0;
let currentFrame: (Partial<PlatePreviewStageTimings> & { _started?: number }) | null = null;

const AGG: PlatePreviewStageTimings = {
  drawImageMs: 0,
  yoloLetterboxMs: 0,
  yoloInferMs: 0,
  yoloDecodeMs: 0,
  getImageDataMs: 0,
  sharpnessMs: 0,
  cnnCropPreprocessMs: 0,
  cnnInferMs: 0,
  cnnInferCount: 0,
  gateMs: 0,
  overlayMs: 0,
  reactSetStateMs: 0,
  totalMs: 0,
  hadSevenBoxes: false,
  ranFullCnn: false,
  tfBackend: '',
};

function isDev(): boolean {
  return import.meta.env.DEV;
}

export function resetPlatePreviewPerf(): void {
  if (!isDev()) return;
  lastReport = null;
  cnnFrameCount = 0;
  yoloOnlyFrameCount = 0;
  currentFrame = null;
  Object.keys(AGG).forEach((k) => {
    const key = k as keyof PlatePreviewStageTimings;
    if (typeof AGG[key] === 'number') (AGG as Record<string, number>)[key] = 0;
  });
}

/** Inicia medição de um frame de preview (hook + pipeline). */
export function beginPlatePreviewFrame(): void {
  if (!isDev()) return;
  currentFrame = { _started: performance.now() };
}

export function patchPlatePreviewFrame(patch: Partial<PlatePreviewStageTimings>): void {
  if (!isDev() || !currentFrame) return;
  Object.assign(currentFrame, patch);
}

/** Finaliza e registra o frame (chamar no hook após overlay/React). */
export function endPlatePreviewFrame(patch?: Partial<PlatePreviewStageTimings>): void {
  if (!isDev() || !currentFrame) return;
  const started = currentFrame._started ?? performance.now();
  const { _started: _, ...rest } = currentFrame;
  recordPlatePreviewFrame({
    ...rest,
    ...patch,
    totalMs: performance.now() - started,
  });
  currentFrame = null;
}

export function recordPlatePreviewFrame(
  timings: Partial<PlatePreviewStageTimings> & { totalMs: number },
): void {
  if (!isDev()) return;

  const report: PlatePreviewStageTimings = {
    drawImageMs: timings.drawImageMs ?? 0,
    yoloLetterboxMs: timings.yoloLetterboxMs ?? 0,
    yoloInferMs: timings.yoloInferMs ?? 0,
    yoloDecodeMs: timings.yoloDecodeMs ?? 0,
    getImageDataMs: timings.getImageDataMs ?? 0,
    sharpnessMs: timings.sharpnessMs ?? 0,
    cnnCropPreprocessMs: timings.cnnCropPreprocessMs ?? 0,
    cnnInferMs: timings.cnnInferMs ?? 0,
    cnnInferCount: timings.cnnInferCount ?? 0,
    gateMs: timings.gateMs ?? 0,
    overlayMs: timings.overlayMs ?? 0,
    reactSetStateMs: timings.reactSetStateMs ?? 0,
    totalMs: timings.totalMs,
    hadSevenBoxes: timings.hadSevenBoxes ?? false,
    ranFullCnn: timings.ranFullCnn ?? false,
    tfBackend: timings.tfBackend ?? '',
  };

  lastReport = report;

  if (report.ranFullCnn) {
    cnnFrameCount += 1;
    AGG.drawImageMs += report.drawImageMs;
    AGG.yoloLetterboxMs += report.yoloLetterboxMs;
    AGG.yoloInferMs += report.yoloInferMs;
    AGG.yoloDecodeMs += report.yoloDecodeMs;
    AGG.getImageDataMs += report.getImageDataMs;
    AGG.sharpnessMs += report.sharpnessMs;
    AGG.cnnCropPreprocessMs += report.cnnCropPreprocessMs;
    AGG.cnnInferMs += report.cnnInferMs;
    AGG.cnnInferCount += report.cnnInferCount;
    AGG.gateMs += report.gateMs;
    AGG.overlayMs += report.overlayMs;
    AGG.reactSetStateMs += report.reactSetStateMs;
    AGG.totalMs += report.totalMs;

    if (cnnFrameCount % 5 === 0) {
      const n = cnnFrameCount;
      console.group(`[PlatePreview Perf] média últimos ${n} frames CNN (7 chars)`);
      console.table({
        tfBackend: report.tfBackend,
        drawImageMs: (AGG.drawImageMs / n).toFixed(1),
        yoloLetterboxMs: (AGG.yoloLetterboxMs / n).toFixed(1),
        yoloInferMs: (AGG.yoloInferMs / n).toFixed(1),
        yoloDecodeMs: (AGG.yoloDecodeMs / n).toFixed(1),
        getImageDataMs: (AGG.getImageDataMs / n).toFixed(1),
        sharpnessMs: (AGG.sharpnessMs / n).toFixed(1),
        cnnCropPreprocessMs: (AGG.cnnCropPreprocessMs / n).toFixed(1),
        cnnInferMs: (AGG.cnnInferMs / n).toFixed(1),
        cnnInferCount: (AGG.cnnInferCount / n).toFixed(1),
        gateMs: (AGG.gateMs / n).toFixed(1),
        overlayMs: (AGG.overlayMs / n).toFixed(1),
        reactSetStateMs: (AGG.reactSetStateMs / n).toFixed(1),
        totalMs: (AGG.totalMs / n).toFixed(1),
      });
      console.groupEnd();
    }
  } else if (report.hadSevenBoxes === false) {
    yoloOnlyFrameCount += 1;
    if (yoloOnlyFrameCount % 20 === 0) {
      console.log(
        `[PlatePreview Perf] YOLO-only frame: total=${report.totalMs.toFixed(0)}ms ` +
          `(yolo=${(report.yoloInferMs + report.yoloDecodeMs).toFixed(0)}ms, draw=${report.drawImageMs.toFixed(0)}ms)`,
      );
    }
  }
}

export function getLastPlatePreviewReport(): PlatePreviewStageTimings | null {
  return lastReport;
}
