import { useRef, useState, useCallback, useEffect } from 'react';
import { X, ImagePlus, RefreshCw, AlertTriangle, Camera } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PlateFrameEditor } from '@/components/PlateFrameEditor';
import { scanFrameForPlate, scanFrameForSticker } from '@/lib/imageUtils';
import {
  useRealtimeScanner,
  STABLE_FRAMES_NEEDED,
  type ScanCapture,
} from '@/hooks/useRealtimeScanner';

// ─────────────────────────────────────────────────────────────────────────────
// RealtimeScannerCamera
// Câmera com scanner YOLO em tempo real + fallback de captura manual.
//   mode='plate'   → model_yolo_placas,    7 chars, Mercosul
//   mode='sticker' → model_yolo_vistorias, 5 dígitos
//
// O callback onCapture entrega { originalImageBlob, yoloData } para
// auditoria e OCR downstream.
// ─────────────────────────────────────────────────────────────────────────────

export type { ScanCapture };

interface RealtimeScannerCameraProps {
  onCapture: (capture: ScanCapture) => void;
  onCancel: () => void;
  title?: string;
  mode?: 'plate' | 'sticker';
  /** Intervalo de inferência em ms (default 250 ≈ 4 fps).  */
  inferenceIntervalMs?: number;
}

// ─── Configuração por modo ────────────────────────────────────────────────────
const MODE_CONFIG = {
  plate: {
    scanFn:        scanFrameForPlate,
    targetCount:   7,
    overlayType:   'plate'  as const,
    defaultTitle:  'Leitura Automática da Placa',
    hint:          'Aponte a câmera para a placa',
    detectedLabel: (n: number) => `${n}/7 caractere(s) detectado(s)`,
    viewfinderAR:  '4 / 1',   // placa Mercosul ~400×100mm
  },
  sticker: {
    scanFn:        scanFrameForSticker,
    targetCount:   5,
    overlayType:   'number' as const,
    defaultTitle:  'Leitura Automática do Adesivo',
    hint:          'Aponte a câmera para o adesivo',
    detectedLabel: (n: number) => `${n}/5 dígito(s) detectado(s)`,
    viewfinderAR:  '3 / 1',
  },
} as const;

export function RealtimeScannerCamera({
  onCapture,
  onCancel,
  title,
  mode = 'sticker',
  inferenceIntervalMs,
}: RealtimeScannerCameraProps) {
  const cfg = MODE_CONFIG[mode];

  const videoRef     = useRef<HTMLVideoElement>(null);
  const overlayRef   = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef    = useRef<MediaStream | null>(null);

  const [videoReady,  setVideoReady]  = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [captured,    setCaptured]    = useState(false);
  const [galleryUrl,  setGalleryUrl]  = useState<string | null>(null);

  // ── Câmera ────────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch (err) {
      console.error('[Scanner] Câmera indisponível:', err);
      setCameraError('Não foi possível acessar a câmera. Verifique as permissões.');
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, [startCamera, stopCamera]);

  // ── Callback de captura (auto ou manual) ─────────────────────────────────
  const handleCapture = useCallback((capture: ScanCapture) => {
    if (captured) return;
    setCaptured(true);
    stopCamera();
    onCapture(capture);
  }, [captured, stopCamera, onCapture]);

  // ── Scanner em tempo real ──────────────────────────────────────────────────
  const { boxes, stableCount, isLocked, captureNow } = useRealtimeScanner({
    videoRef,
    overlayCanvasRef:   overlayRef,
    enabled:            videoReady && !captured,
    onAutoCapture:      handleCapture,
    scanFn:             cfg.scanFn,
    targetCharCount:    cfg.targetCount,
    inferenceIntervalMs,
  });

  // ── Captura manual pelo botão ─────────────────────────────────────────────
  const handleManualCapture = useCallback(() => {
    if (captured) return;
    // Trava o estado local imediatamente para desativar o botão
    setCaptured(true);
    stopCamera();
    // captureNow() dispara snapVideoFrame + vibrate + onAutoCapture internamente
    captureNow();
  }, [captured, stopCamera, captureNow]);

  // ── Galeria → PlateFrameEditor → onCapture ────────────────────────────────
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || captured) return;
    stopCamera();
    setGalleryUrl(URL.createObjectURL(file));
  }, [captured, stopCamera]);

  // ── Status ────────────────────────────────────────────────────────────────
  const capturedLabel = mode === 'plate' ? '✓ Placa capturada!' : '✓ Adesivo capturado!';
  const statusMsg = (() => {
    if (captured || isLocked) return capturedLabel;
    if (stableCount > 0)      return `Segure firme… ${stableCount}/${STABLE_FRAMES_NEEDED}`;
    if (boxes.length > 0)     return cfg.detectedLabel(boxes.length);
    return cfg.hint;
  })();

  const statusColor = (() => {
    if (captured || isLocked) return 'bg-green-600 text-white';
    if (stableCount > 0)      return 'bg-green-500/90 text-white animate-pulse';
    if (boxes.length > 0)     return 'bg-green-500/70 text-white';
    return 'bg-black/60 text-white/80';
  })();

  const viewfinderColor = (() => {
    if (captured || isLocked) return 'border-green-400';
    if (stableCount > 0)      return 'border-green-400 animate-pulse';
    if (boxes.length > 0)     return 'border-green-400/70';
    return 'border-white/40';
  })();

  // ── Galeria: crop antes de enviar ao YOLO ─────────────────────────────────
  if (galleryUrl) {
    return (
      <PlateFrameEditor
        imageUrl={galleryUrl}
        overlayType={cfg.overlayType}
        onConfirm={(blob) => {
          URL.revokeObjectURL(galleryUrl);
          setGalleryUrl(null);
          setCaptured(true);
          onCapture({ originalImageBlob: blob, yoloData: [] });
        }}
        onCancel={() => {
          URL.revokeObjectURL(galleryUrl);
          setGalleryUrl(null);
          startCamera();
        }}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">

      {/* ─── Cabeçalho ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/80 backdrop-blur-sm">
        <h2 className="text-base font-bold text-white truncate">
          {title ?? cfg.defaultTitle}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="text-white hover:bg-white/10 shrink-0"
          onClick={() => { stopCamera(); onCancel(); }}
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* ─── Área da câmera ─────────────────────────────────────────────── */}
      <div className="relative flex-1 overflow-hidden flex items-center justify-center">
        {cameraError ? (
          <div className="p-6 text-center space-y-4 max-w-xs">
            <AlertTriangle className="h-12 w-12 text-red-400 mx-auto" />
            <h3 className="text-lg font-bold text-white">Câmera Indisponível</h3>
            <p className="text-sm text-gray-300">{cameraError}</p>
            <Button variant="secondary" className="gap-2" onClick={startCamera}>
              <RefreshCw className="h-4 w-4" />
              Tentar Novamente
            </Button>
          </div>
        ) : (
          <>
            {/* Vídeo ao vivo — 30/60 fps sem interferência do YOLO */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-contain"
              onLoadedMetadata={() => {
                videoRef.current?.play();
                setVideoReady(true);
              }}
            />

            {/* Canvas de overlay YOLO (bounding boxes + barra de progresso) */}
            <canvas
              ref={overlayRef}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ objectFit: 'contain' }}
            />

            {/* Visor guia */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div
                className={cn(
                  'border-2 rounded-lg transition-colors duration-200 w-[85vw] max-w-sm',
                  viewfinderColor,
                )}
                style={{ aspectRatio: cfg.viewfinderAR }}
              />
            </div>

            {/* Pill de status */}
            <div className="absolute bottom-6 left-0 right-0 flex justify-center px-4 pointer-events-none">
              <div className={cn(
                'px-5 py-2 rounded-full text-sm font-semibold shadow-lg transition-all duration-300',
                statusColor,
              )}>
                {statusMsg}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ─── Rodapé ─────────────────────────────────────────────────────── */}
      <div
        className="flex gap-2 px-4 py-3 bg-black/80 backdrop-blur-sm"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        {/* Galeria */}
        <Button
          variant="outline"
          className="h-12 px-4 border-white/20 text-white bg-transparent hover:bg-white/10 shrink-0"
          onClick={() => fileInputRef.current?.click()}
          disabled={captured}
          title="Selecionar da galeria"
        >
          <ImagePlus className="h-4 w-4" />
        </Button>

        {/* Captura Manual — sempre disponível como fallback */}
        <Button
          className="flex-1 h-12 font-bold text-sm bg-white/10 hover:bg-white/20 border border-white/20 text-white"
          onClick={handleManualCapture}
          disabled={captured}
        >
          <Camera className="mr-2 h-4 w-4" />
          Captura Manual
        </Button>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>
    </div>
  );
}
