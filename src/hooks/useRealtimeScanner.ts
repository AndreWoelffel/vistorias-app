import { useRef, useState, useCallback, useEffect } from 'react';
import { type YOLOBox } from '@/lib/imageUtils';

// ─── Tipos públicos ───────────────────────────────────────────────────────────

/** Payload entregue ao callback onAutoCapture — evidência fotográfica + metadados YOLO */
export interface ScanCapture {
  /** Frame nativo da câmera no momento da captura (JPEG 92%) */
  originalImageBlob: Blob;
  /** Caixas detectadas pelo YOLO no frame capturado */
  yoloData: YOLOBox[];
}

export interface RealtimeScannerState {
  boxes: YOLOBox[];
  stableCount: number;  // 0..STABLE_FRAMES_NEEDED
  isLocked: boolean;    // true após auto-capture ou captureNow()
}

export interface RealtimeScannerControls extends RealtimeScannerState {
  /** Força captura imediata, mesmo sem estabilidade suficiente */
  captureNow: () => void;
}

// ─── Constantes ───────────────────────────────────────────────────────────────
export const STABLE_FRAMES_NEEDED      = 4;    // frames estáveis consecutivos para auto-disparo
const DEFAULT_INFERENCE_INTERVAL_MS    = 250;  // ~4 fps de inferência — equilíbrio térmico/responsividade

interface UseRealtimeScannerOptions {
  videoRef: React.RefObject<HTMLVideoElement>;
  overlayCanvasRef: React.RefObject<HTMLCanvasElement>;
  enabled: boolean;
  onAutoCapture: (capture: ScanCapture) => void;
  /** Função de detecção: recebe canvas de frame, retorna YOLOBox[] */
  scanFn: (canvas: HTMLCanvasElement) => Promise<YOLOBox[]>;
  /** Número de caracteres para considerar a detecção completa (5 adesivo, 7 placa) */
  targetCharCount: number;
  /**
   * Intervalo mínimo entre inferências em ms (default 250 ≈ 4 fps).
   * O <video> continua fluido a 30/60 fps — apenas a chamada ao YOLO é throttled.
   */
  inferenceIntervalMs?: number;
}

// ─── Utilitário de overlay ────────────────────────────────────────────────────
function drawBoxesOnCanvas(
  canvas: HTMLCanvasElement,
  boxes: YOLOBox[],
  videoNatW: number,
  videoNatH: number,
  stableCount: number,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cW = canvas.width;
  const cH = canvas.height;
  ctx.clearRect(0, 0, cW, cH);

  if (boxes.length === 0) return;

  // object-contain: escala uniforme com offset de letterbox
  const scale   = Math.min(cW / videoNatW, cH / videoNatH);
  const offsetX = (cW - videoNatW * scale) / 2;
  const offsetY = (cH - videoNatH * scale) / 2;

  const progress = Math.min(stableCount / STABLE_FRAMES_NEEDED, 1);
  const isStable = stableCount >= STABLE_FRAMES_NEEDED;

  boxes.forEach((b) => {
    const sx = offsetX + b.x * scale;
    const sy = offsetY + b.y * scale;
    const sw = b.w * scale;
    const sh = b.h * scale;

    ctx.strokeStyle = isStable ? '#22c55e' : `rgba(34,197,94,${0.45 + progress * 0.55})`;
    ctx.lineWidth   = isStable ? 3 : 2;
    ctx.strokeRect(sx, sy, sw, sh);

    const label = `${(b.confidence * 100).toFixed(0)}%`;
    ctx.font      = 'bold 11px monospace';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(label, sx + 2, sy > 14 ? sy - 3 : sy + sh + 12);
  });

  // Barra de progresso no topo
  if (stableCount > 0) {
    const barH = 4;
    ctx.fillStyle = 'rgba(34,197,94,0.3)';
    ctx.fillRect(0, 0, cW, barH);
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(0, 0, cW * progress, barH);
  }
}

// ─── Extrai blob do frame atual do <video> ────────────────────────────────────
function snapVideoFrame(video: HTMLVideoElement): Promise<{ blob: Blob; canvas: HTMLCanvasElement }> {
  return new Promise((resolve, reject) => {
    const c = document.createElement('canvas');
    c.width  = video.videoWidth;
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
}: UseRealtimeScannerOptions): RealtimeScannerControls {

  const rafRef          = useRef<number | null>(null);
  const inferringRef    = useRef(false);
  const lockedRef       = useRef(false);
  const lastInferenceTs = useRef(0);
  const stableCountRef  = useRef(0);
  const lastBoxesRef    = useRef<YOLOBox[]>([]);   // última detecção — usada pelo captureNow

  // Estabiliza callbacks via refs (evita re-criação do loop)
  const onAutoCaptureRef      = useRef(onAutoCapture);
  const scanFnRef             = useRef(scanFn);
  const targetCountRef        = useRef(targetCharCount);
  const inferenceIntervalRef  = useRef(inferenceIntervalMs);
  useEffect(() => { onAutoCaptureRef.current = onAutoCapture; },       [onAutoCapture]);
  useEffect(() => { scanFnRef.current = scanFn; },                     [scanFn]);
  useEffect(() => { targetCountRef.current = targetCharCount; },       [targetCharCount]);
  useEffect(() => { inferenceIntervalRef.current = inferenceIntervalMs; }, [inferenceIntervalMs]);

  const [state, setState] = useState<RealtimeScannerState>({
    boxes: [], stableCount: 0, isLocked: false,
  });

  // ── Passo de inferência (async, throttled pelo loop RAF) ──────────────────
  const runInferenceStep = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    // Snapshot do frame para canvas reutilizado na detecção E na captura
    let frameBlob: Blob;
    let frameCanvas: HTMLCanvasElement;
    try {
      ({ blob: frameBlob, canvas: frameCanvas } = await snapVideoFrame(video));
    } catch {
      return;
    }

    // Detecção YOLO
    let boxes: YOLOBox[] = [];
    try {
      boxes = await scanFnRef.current(frameCanvas);
    } catch {
      return; // frame descartado silenciosamente
    }

    lastBoxesRef.current = boxes;

    // Overlay visual
    const overlay = overlayCanvasRef.current;
    if (overlay) {
      overlay.width  = video.videoWidth;
      overlay.height = video.videoHeight;
      drawBoxesOnCanvas(overlay, boxes, video.videoWidth, video.videoHeight, stableCountRef.current);
    }

    // Heurística de estabilidade
    if (boxes.length === targetCountRef.current) {
      stableCountRef.current = Math.min(stableCountRef.current + 1, STABLE_FRAMES_NEEDED + 1);
    } else {
      stableCountRef.current = 0;
    }

    setState({ boxes, stableCount: stableCountRef.current, isLocked: false });

    // ── Auto-disparo quando estável ────────────────────────────────────────
    if (stableCountRef.current >= STABLE_FRAMES_NEEDED) {
      lockedRef.current = true;
      setState(s => ({ ...s, isLocked: true }));
      if ('vibrate' in navigator) navigator.vibrate(200);
      onAutoCaptureRef.current({ originalImageBlob: frameBlob, yoloData: boxes });
    }
  }, [videoRef, overlayCanvasRef]);

  // ── Loop RAF — vídeo roda a 30/60 fps; YOLO é throttled ──────────────────
  const loop = useCallback(() => {
    if (lockedRef.current) return;
    rafRef.current = requestAnimationFrame(loop);

    const now = performance.now();
    if (inferringRef.current || now - lastInferenceTs.current < inferenceIntervalRef.current) return;

    lastInferenceTs.current = now;
    inferringRef.current    = true;
    runInferenceStep().finally(() => { inferringRef.current = false; });
  }, [runInferenceStep]);

  // ── Captura manual imediata ───────────────────────────────────────────────
  const captureNow = useCallback(() => {
    if (lockedRef.current) return;
    lockedRef.current = true;

    const video = videoRef.current;
    if (!video) return;

    if ('vibrate' in navigator) navigator.vibrate(100);

    snapVideoFrame(video)
      .then(({ blob }) => {
        setState(s => ({ ...s, isLocked: true }));
        onAutoCaptureRef.current({ originalImageBlob: blob, yoloData: lastBoxesRef.current });
      })
      .catch(console.error);
  }, [videoRef]);

  // ── Ciclo de vida ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;

    stableCountRef.current  = 0;
    lockedRef.current       = false;
    lastInferenceTs.current = 0;
    inferringRef.current    = false;
    lastBoxesRef.current    = [];
    setState({ boxes: [], stableCount: 0, isLocked: false });

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      overlayCanvasRef.current?.getContext('2d')?.clearRect(
        0, 0,
        overlayCanvasRef.current.width,
        overlayCanvasRef.current.height,
      );
    };
  }, [enabled, loop, overlayCanvasRef]);

  return { ...state, captureNow };
}
