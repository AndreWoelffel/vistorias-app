/**
 * Instrumentação de desempenho do OCR de placa — somente DEV (`import.meta.env.DEV`).
 */

export type PlateOcrPerfReport = {
  label: string;
  /** Último frame de preview antes da captura (YOLO + CNN). */
  lastPreviewYoloMs: number;
  lastPreviewCnnMs: number;
  /** Pós-captura (0 quando o resultado do preview é reutilizado). */
  postCaptureYoloMs: number;
  postCaptureCnnMs: number;
  /** onCapture / runOCR → placa preenchida na UI. */
  captureToPlateMs: number;
  postCaptureYoloInferences: number;
  postCaptureCnnInferences: number;
  reusedPreviewResult: boolean;
};

let captureStartMs = 0;
let lastPreviewYoloMs = 0;
let lastPreviewCnnMs = 0;
let postCaptureYoloMs = 0;
let postCaptureCnnMs = 0;
let postCaptureYoloInferences = 0;
let postCaptureCnnInferences = 0;
let reusedPreview = false;

function isDev(): boolean {
  return import.meta.env.DEV;
}

export function beginPlateCapturePerf(): void {
  if (!isDev()) return;
  captureStartMs = performance.now();
  postCaptureYoloMs = 0;
  postCaptureCnnMs = 0;
  postCaptureYoloInferences = 0;
  postCaptureCnnInferences = 0;
  reusedPreview = false;
}

export function recordLastPreviewFrame(yoloMs: number, cnnMs: number): void {
  if (!isDev()) return;
  lastPreviewYoloMs = yoloMs;
  lastPreviewCnnMs = cnnMs;
}

export function recordPostCaptureYolo(ms: number): void {
  if (!isDev()) return;
  postCaptureYoloMs += ms;
  postCaptureYoloInferences += 1;
}

export function recordPostCaptureCnn(count: number, ms: number): void {
  if (!isDev()) return;
  postCaptureCnnMs += ms;
  postCaptureCnnInferences += count;
}

export function markReusedPreviewResult(): void {
  if (!isDev()) return;
  reusedPreview = true;
}

export function logPlateCapturePerf(label: string): PlateOcrPerfReport | null {
  if (!isDev()) return null;

  const report: PlateOcrPerfReport = {
    label,
    lastPreviewYoloMs,
    lastPreviewCnnMs,
    postCaptureYoloMs,
    postCaptureCnnMs,
    captureToPlateMs: captureStartMs > 0 ? performance.now() - captureStartMs : 0,
    postCaptureYoloInferences,
    postCaptureCnnInferences,
    reusedPreviewResult: reusedPreview,
  };

  console.group(`[PlateOCR Perf] ${label}`);
  console.table(report);
  console.groupEnd();

  return report;
}
