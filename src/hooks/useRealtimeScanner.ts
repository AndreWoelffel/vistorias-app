import { useRef, useState, useCallback, useEffect } from 'react';
import { type YOLOBox } from '@/lib/imageUtils';

// ─── Constantes de heurística ────────────────────────────────────────────────
const INFERENCE_INTERVAL_MS  = 200;  // ~5 fps de inferência (poupa CPU/bateria)
export const STABLE_FRAMES_NEEDED = 4; // frames consecutivos com detecção completa

export interface RealtimeScannerState {
  boxes: YOLOBox[];
  stableCount: number;   // 0..STABLE_FRAMES_NEEDED
  isLocked: boolean;     // true quando auto-capture já foi disparado
}

interface UseRealtimeScannerOptions {
  videoRef: React.RefObject<HTMLVideoElement>;
  overlayCanvasRef: React.RefObject<HTMLCanvasElement>;
  enabled: boolean;
  onAutoCapture: (blob: Blob) => void;
  /** Função de scan: recebe canvas de frame, retorna YOLOBox[] */
  scanFn: (canvas: HTMLCanvasElement) => Promise<YOLOBox[]>;
  /** Quantos caracteres o scanner deve detectar para considerar completo */
  targetCharCount: number;
}

// ─── Utilidade de desenho do overlay ─────────────────────────────────────────
// Mapeia coordenadas de vídeo → canvas CSS usando escala `object-contain`.
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

  const scale   = Math.min(cW / videoNatW, cH / videoNatH);
  const offsetX = (cW - videoNatW * scale) / 2;
  const offsetY = (cH - videoNatH * scale) / 2;

  const progress = stableCount / STABLE_FRAMES_NEEDED;
  const isStable = stableCount >= STABLE_FRAMES_NEEDED;

  boxes.forEach((b) => {
    const sx = offsetX + b.x * scale;
    const sy = offsetY + b.y * scale;
    const sw = b.w * scale;
    const sh = b.h * scale;

    ctx.strokeStyle = isStable ? '#22c55e' : `rgba(34,197,94,${0.5 + progress * 0.5})`;
    ctx.lineWidth   = isStable ? 3 : 2;
    ctx.strokeRect(sx, sy, sw, sh);

    // Mini label de confiança acima da caixa
    const label = `${(b.confidence * 100).toFixed(0)}%`;
    ctx.font      = 'bold 11px monospace';
    ctx.fillStyle = isStable ? '#22c55e' : 'rgba(34,197,94,0.9)';
    ctx.fillText(label, sx + 2, sy > 14 ? sy - 3 : sy + sh + 12);
  });

  // Barra de progresso de estabilidade no topo do overlay
  if (stableCount > 0) {
    const barH = 4;
    ctx.fillStyle = 'rgba(34,197,94,0.35)';
    ctx.fillRect(0, 0, cW, barH);
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(0, 0, cW * progress, barH);
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useRealtimeScanner({
  videoRef,
  overlayCanvasRef,
  enabled,
  onAutoCapture,
  scanFn,
  targetCharCount,
}: UseRealtimeScannerOptions): RealtimeScannerState {

  const rafRef          = useRef<number | null>(null);
  const inferringRef    = useRef(false);
  const lockedRef       = useRef(false);
  const lastInferenceTs = useRef(0);
  const stableCountRef  = useRef(0);

  // Estabiliza callbacks sem recriação do loop
  const onAutoCaptureRef  = useRef(onAutoCapture);
  const scanFnRef         = useRef(scanFn);
  const targetCountRef    = useRef(targetCharCount);
  useEffect(() => { onAutoCaptureRef.current = onAutoCapture; }, [onAutoCapture]);
  useEffect(() => { scanFnRef.current = scanFn; }, [scanFn]);
  useEffect(() => { targetCountRef.current = targetCharCount; }, [targetCharCount]);

  const [state, setState] = useState<RealtimeScannerState>({
    boxes: [],
    stableCount: 0,
    isLocked: false,
  });

  // ── Passo de inferência assíncrono ──────────────────────────────────────────
  const runInferenceStep = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    // Captura frame atual para canvas temporário
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width  = video.videoWidth;
    frameCanvas.height = video.videoHeight;
    frameCanvas.getContext('2d')!.drawImage(video, 0, 0);

    let boxes: YOLOBox[] = [];
    try {
      boxes = await scanFnRef.current(frameCanvas);
    } catch {
      return; // frame silenciosamente descartado em caso de erro
    }

    // Atualiza overlay visual
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

    // ── Auto-capture ─────────────────────────────────────────────────────────
    if (stableCountRef.current >= STABLE_FRAMES_NEEDED) {
      lockedRef.current = true;
      setState(s => ({ ...s, isLocked: true }));

      // Feedback háptico
      if ('vibrate' in navigator) navigator.vibrate(200);

      // Exporta o frame capturado como Blob JPEG de alta qualidade
      const blob = await new Promise<Blob>((resolve, reject) => {
        frameCanvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('toBlob: null'))),
          'image/jpeg',
          0.92,
        );
      });

      onAutoCaptureRef.current(blob);
    }
  }, [videoRef, overlayCanvasRef]);

  // ── Loop RAF ─────────────────────────────────────────────────────────────────
  const loop = useCallback(() => {
    if (lockedRef.current) return;
    rafRef.current = requestAnimationFrame(loop);

    // Throttle: só inicia nova inferência após o intervalo mínimo
    const now = Date.now();
    if (inferringRef.current || now - lastInferenceTs.current < INFERENCE_INTERVAL_MS) return;

    lastInferenceTs.current = now;
    inferringRef.current    = true;

    runInferenceStep().finally(() => {
      inferringRef.current = false;
    });
  }, [runInferenceStep]);

  // ── Ciclo de vida ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;

    // Reset ao (re)ativar
    stableCountRef.current  = 0;
    lockedRef.current       = false;
    lastInferenceTs.current = 0;
    inferringRef.current    = false;
    setState({ boxes: [], stableCount: 0, isLocked: false });

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Limpa overlay ao desmontar
      const overlay = overlayCanvasRef.current;
      if (overlay) overlay.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height);
    };
  }, [enabled, loop, overlayCanvasRef]);

  return state;
}

