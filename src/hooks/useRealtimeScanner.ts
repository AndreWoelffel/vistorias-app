import { useRef, useState, useCallback, useEffect } from 'react';
import { type YOLOBox } from '@/lib/imageUtils';

// ─── Tipos públicos ───────────────────────────────────────────────────────────

/** Payload entregue ao callback onAutoCapture — evidência fotográfica + metadados YOLO */
export interface ScanCapture {
  /** Frame nativo da câmera no momento da captura (JPEG 92%) */
  originalImageBlob: Blob;
  /** Caixas detectadas pelo YOLO no frame capturado */
  yoloData: YOLOBox[];
  /** Placa lida no frame capturado (modo placa com gate CNN) */
  previewText?: string;
  previewConfidence?: number;
}

export interface RealtimeScanFrameResult {
  boxes: YOLOBox[];
  /**
   * Quando definido, controla a estabilidade em vez de só contar caixas.
   * Ex.: placa só fica pronta após CNN + nitidez + formato Mercosul.
   */
  ready?: boolean;
  previewText?: string;
  previewConfidence?: number;
}

export interface RealtimeScannerState {
  boxes: YOLOBox[];
  stableCount: number;
  isLocked: boolean;
  previewText?: string;
  previewConfidence?: number;
}

export interface RealtimeScannerControls extends RealtimeScannerState {
  /** Força captura imediata no frame atual (com scan no mesmo frame) */
  captureNow: () => void;
}

// ─── Constantes ───────────────────────────────────────────────────────────────
export const STABLE_FRAMES_NEEDED = 4;
const DEFAULT_INFERENCE_INTERVAL_MS = 250;

type ScanFn = (
  canvas: HTMLCanvasElement,
) => Promise<RealtimeScanFrameResult | YOLOBox[]>;

interface UseRealtimeScannerOptions {
  videoRef: React.RefObject<HTMLVideoElement>;
  overlayCanvasRef: React.RefObject<HTMLCanvasElement>;
  enabled: boolean;
  onAutoCapture: (capture: ScanCapture) => void;
  scanFn: ScanFn;
  targetCharCount: number;
  inferenceIntervalMs?: number;
  stableFramesNeeded?: number;
}

function normalizeScanResult(
  raw: RealtimeScanFrameResult | YOLOBox[],
): RealtimeScanFrameResult {
  if (Array.isArray(raw)) return { boxes: raw };
  return raw;
}

// ─── Utilitário de overlay ────────────────────────────────────────────────────
function drawBoxesOnCanvas(
  canvas: HTMLCanvasElement,
  boxes: YOLOBox[],
  videoNatW: number,
  videoNatH: number,
  stableCount: number,
  stableFramesNeeded: number,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cW = canvas.width;
  const cH = canvas.height;
  ctx.clearRect(0, 0, cW, cH);

  if (boxes.length === 0) return;

  const scale = Math.min(cW / videoNatW, cH / videoNatH);
  const offsetX = (cW - videoNatW * scale) / 2;
  const offsetY = (cH - videoNatH * scale) / 2;

  const progress = Math.min(stableCount / stableFramesNeeded, 1);
  const isStable = stableCount >= stableFramesNeeded;

  boxes.forEach((b) => {
    const sx = offsetX + b.x * scale;
    const sy = offsetY + b.y * scale;
    const sw = b.w * scale;
    const sh = b.h * scale;

    ctx.strokeStyle = isStable ? '#22c55e' : `rgba(34,197,94,${0.45 + progress * 0.55})`;
    ctx.lineWidth = isStable ? 3 : 2;
    ctx.strokeRect(sx, sy, sw, sh);

    const label = `${(b.confidence * 100).toFixed(0)}%`;
    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(label, sx + 2, sy > 14 ? sy - 3 : sy + sh + 12);
  });

  if (stableCount > 0) {
    const barH = 4;
    ctx.fillStyle = 'rgba(34,197,94,0.3)';
    ctx.fillRect(0, 0, cW, barH);
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(0, 0, cW * progress, barH);
  }
}

function snapVideoFrame(
  video: HTMLVideoElement,
): Promise<{ blob: Blob; canvas: HTMLCanvasElement }> {
  return new Promise((resolve, reject) => {
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d')!.drawImage(video, 0, 0);
    c.toBlob(
      (b) => (b ? resolve({ blob: b, canvas: c }) : reject(new Error('toBlob: null'))),
      'image/jpeg',
      0.92,
    );
  });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useRealtimeScanner({
  videoRef,
  overlayCanvasRef,
  enabled,
  onAutoCapture,
  scanFn,
  targetCharCount,
  inferenceIntervalMs = DEFAULT_INFERENCE_INTERVAL_MS,
  stableFramesNeeded = STABLE_FRAMES_NEEDED,
}: UseRealtimeScannerOptions): RealtimeScannerControls {
  const rafRef = useRef<number | null>(null);
  const inferringRef = useRef(false);
  const lockedRef = useRef(false);
  const lastInferenceTs = useRef(0);
  const stableCountRef = useRef(0);
  const lastPreviewTextRef = useRef<string | undefined>(undefined);

  const onAutoCaptureRef = useRef(onAutoCapture);
  const scanFnRef = useRef(scanFn);
  const targetCountRef = useRef(targetCharCount);
  const inferenceIntervalRef = useRef(inferenceIntervalMs);
  const stableFramesRef = useRef(stableFramesNeeded);

  useEffect(() => { onAutoCaptureRef.current = onAutoCapture; }, [onAutoCapture]);
  useEffect(() => { scanFnRef.current = scanFn; }, [scanFn]);
  useEffect(() => { targetCountRef.current = targetCharCount; }, [targetCharCount]);
  useEffect(() => { inferenceIntervalRef.current = inferenceIntervalMs; }, [inferenceIntervalMs]);
  useEffect(() => { stableFramesRef.current = stableFramesNeeded; }, [stableFramesNeeded]);

  const [state, setState] = useState<RealtimeScannerState>({
    boxes: [],
    stableCount: 0,
    isLocked: false,
  });

  const updateStability = useCallback((result: RealtimeScanFrameResult): number => {
    const ready =
      result.ready ??
      result.boxes.length === targetCountRef.current;

    if (!ready) {
      stableCountRef.current = 0;
      lastPreviewTextRef.current = undefined;
      return 0;
    }

    if (
      result.previewText != null &&
      lastPreviewTextRef.current != null &&
      result.previewText !== lastPreviewTextRef.current
    ) {
      stableCountRef.current = 1;
      lastPreviewTextRef.current = result.previewText;
      return 1;
    }

    stableCountRef.current = Math.min(
      stableCountRef.current + 1,
      stableFramesRef.current + 1,
    );
    if (result.previewText) {
      lastPreviewTextRef.current = result.previewText;
    }
    return stableCountRef.current;
  }, []);

  const runInferenceStep = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    let frameBlob: Blob;
    let frameCanvas: HTMLCanvasElement;
    try {
      ({ blob: frameBlob, canvas: frameCanvas } = await snapVideoFrame(video));
    } catch {
      return;
    }

    let result: RealtimeScanFrameResult;
    try {
      result = normalizeScanResult(await scanFnRef.current(frameCanvas));
    } catch {
      return;
    }

    const stableCount = updateStability(result);

    const overlay = overlayCanvasRef.current;
    if (overlay) {
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
      drawBoxesOnCanvas(
        overlay,
        result.boxes,
        video.videoWidth,
        video.videoHeight,
        stableCount,
        stableFramesRef.current,
      );
    }

    setState({
      boxes: result.boxes,
      stableCount,
      isLocked: false,
      previewText: result.previewText,
      previewConfidence: result.previewConfidence,
    });

    if (stableCount >= stableFramesRef.current) {
      lockedRef.current = true;
      setState((s) => ({ ...s, isLocked: true }));
      if ('vibrate' in navigator) navigator.vibrate(200);
      onAutoCaptureRef.current({
        originalImageBlob: frameBlob,
        yoloData: result.boxes,
        previewText: result.previewText,
        previewConfidence: result.previewConfidence,
      });
    }
  }, [videoRef, overlayCanvasRef, updateStability]);

  const loop = useCallback(() => {
    if (lockedRef.current) return;
    rafRef.current = requestAnimationFrame(loop);

    const now = performance.now();
    if (inferringRef.current || now - lastInferenceTs.current < inferenceIntervalRef.current) {
      return;
    }

    lastInferenceTs.current = now;
    inferringRef.current = true;
    runInferenceStep().finally(() => {
      inferringRef.current = false;
    });
  }, [runInferenceStep]);

  const captureNow = useCallback(() => {
    if (lockedRef.current) return;
    lockedRef.current = true;

    const video = videoRef.current;
    if (!video) return;

    if ('vibrate' in navigator) navigator.vibrate(100);

    snapVideoFrame(video)
      .then(async ({ blob, canvas }) => {
        let result: RealtimeScanFrameResult = { boxes: [] };
        try {
          result = normalizeScanResult(await scanFnRef.current(canvas));
        } catch {
          /* manual: envia foto mesmo se scan falhar */
        }
        setState((s) => ({
          ...s,
          isLocked: true,
          boxes: result.boxes,
          previewText: result.previewText,
          previewConfidence: result.previewConfidence,
        }));
        onAutoCaptureRef.current({
          originalImageBlob: blob,
          yoloData: result.boxes,
          previewText: result.previewText,
          previewConfidence: result.previewConfidence,
        });
      })
      .catch(console.error);
  }, [videoRef]);

  useEffect(() => {
    if (!enabled) return;

    stableCountRef.current = 0;
    lockedRef.current = false;
    lastInferenceTs.current = 0;
    inferringRef.current = false;
    lastPreviewTextRef.current = undefined;
    setState({ boxes: [], stableCount: 0, isLocked: false });

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      overlayCanvasRef.current?.getContext('2d')?.clearRect(
        0,
        0,
        overlayCanvasRef.current.width,
        overlayCanvasRef.current.height,
      );
    };
  }, [enabled, loop, overlayCanvasRef]);

  return { ...state, captureNow };
}
