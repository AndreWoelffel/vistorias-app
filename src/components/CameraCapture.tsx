import { useRef, useState, useCallback, useEffect } from 'react';
import { Camera, X, RotateCcw, Check, ImagePlus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GalleryCrop } from '@/components/GalleryCrop';
import { PlateFrameEditor } from '@/components/PlateFrameEditor';

interface CameraCaptureProps {
  onCapture: (blob: Blob, dataUrl: string) => void;
  onMultiCapture?: (blobs: Blob[]) => void;
  onCancel: () => void;
  overlayType?: 'plate' | 'number' | 'none';
  /** '1:1' = quadrado (adesivo); 'free' = retângulo livre (placa/número antigo) */
  cropAspectRatio?: '1:1' | 'free';
  title: string;
  multiFrame?: boolean;
}

export function CameraCapture({ onCapture, onMultiCapture, onCancel, overlayType = 'none', cropAspectRatio, title, multiFrame = false }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);
  const [multiFrameProgress, setMultiFrameProgress] = useState<number>(0);
  const [isCapturingMulti, setIsCapturingMulti] = useState(false);
  const [galleryCropUrl, setGalleryCropUrl] = useState<string | null>(null);
  const [galleryCropBlob, setGalleryCropBlob] = useState<Blob | null>(null);

  const startCamera = useCallback(async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
    } catch (err) {
      console.error('Erro ao acessar câmera:', err);
    }
  }, []);

  const stopCamera = useCallback(() => {
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
  }, [stream]);

  useEffect(() => {
    startCamera();
    return () => {
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const captureFrame = (): Promise<{ blob: Blob; dataUrl: string } | null> => {
    return new Promise((resolve) => {
      if (!videoRef.current || !canvasRef.current) return resolve(null);
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);
      ctx.drawImage(video, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) {
          resolve({ blob, dataUrl: canvas.toDataURL('image/jpeg', 0.85) });
        } else {
          resolve(null);
        }
      }, 'image/jpeg', 0.85);
    });
  };

  const capture = async () => {
    if (multiFrame && onMultiCapture) {
      // Multi-frame: capture 3 rapid frames with ~300ms interval
      setIsCapturingMulti(true);
      const blobs: Blob[] = [];
      for (let i = 0; i < 3; i++) {
        setMultiFrameProgress(i + 1);
        const result = await captureFrame();
        if (result) {
          blobs.push(result.blob);
          if (i === 0) {
            setCaptured(result.dataUrl);
          }
        }
        if (i < 2) await new Promise(r => setTimeout(r, 300));
      }
      setIsCapturingMulti(false);
      stopCamera();
      if (blobs.length > 0) {
        setCapturedBlob(blobs[0]);
        onMultiCapture(blobs);
      }
    } else {
      const result = await captureFrame();
      if (result) {
        setCapturedBlob(result.blob);
        setCaptured(result.dataUrl);
        stopCamera();
      }
    }
  };

  const handleGallery = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    stopCamera();

    // Placa: bypass crop — YOLO detecta a placa no contexto inteiro; envio direto preserva aspect ratio
    if (overlayType === 'plate') {
      const url = URL.createObjectURL(file);
      setCaptured(url);
      setCapturedBlob(file);
      return;
    }

    // Número: mostrar modal de recorte para enquadrar o código
    if (overlayType === 'number') {
      const url = URL.createObjectURL(file);
      setGalleryCropUrl(url);
      setGalleryCropBlob(file);
      return;
    }

    // For 'none' overlay (regular photos), skip crop
    const reader = new FileReader();
    reader.onload = () => {
      setCaptured(reader.result as string);
      setCapturedBlob(file);
    };
    reader.readAsDataURL(file);
  };

  const handleCropConfirm = (croppedBlob: Blob) => {
    const url = URL.createObjectURL(croppedBlob);
    setCaptured(url);
    setCapturedBlob(croppedBlob);
    if (galleryCropUrl) URL.revokeObjectURL(galleryCropUrl);
    setGalleryCropUrl(null);
    setGalleryCropBlob(null);
  };

  const handleCropCancel = () => {
    if (galleryCropUrl) URL.revokeObjectURL(galleryCropUrl);
    setGalleryCropUrl(null);
    setGalleryCropBlob(null);
    startCamera();
  };

  const retake = () => {
    setCaptured(null);
    setCapturedBlob(null);
    setMultiFrameProgress(0);
    startCamera();
  };

  const confirm = () => {
    if (capturedBlob && captured) {
      onCapture(capturedBlob, captured);
    }
  };

  if (galleryCropUrl && overlayType === 'number') {
    return (
      <GalleryCrop
        imageUrl={galleryCropUrl}
        imageBlob={galleryCropBlob!}
        overlayType={overlayType}
        cropAspectRatio={cropAspectRatio ?? '1:1'}
        onConfirm={handleCropConfirm}
        onCancel={handleCropCancel}
      />
    );
  }

  if (overlayType === 'plate' && captured && capturedBlob) {
    return (
      <PlateFrameEditor
        imageUrl={captured}
        imageBlob={capturedBlob}
        onConfirm={(blob, dataUrl) => onCapture(blob, dataUrl)}
        onCancel={retake}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between p-4">
        <h2 className="text-lg font-bold text-foreground">{title}</h2>
        <Button variant="ghost" size="icon" onClick={() => { stopCamera(); onCancel(); }}>
          <X className="h-6 w-6" />
        </Button>
      </div>

      <div className="relative flex-1 overflow-hidden bg-black">
        {!captured ? (
          <>
            <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
            {overlayType === 'plate' && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="camera-overlay w-[78vw] max-w-[420px] aspect-square" />
                <div className="absolute bottom-32 left-0 right-0 text-center space-y-1">
                  <p className="text-sm font-medium text-foreground/80">Enquadre a placa no quadrado</p>
                  <p className="text-xs text-muted-foreground/80">Será usado o recorte central 1:1 (640×640)</p>
                </div>
              </div>
            )}
            {overlayType === 'number' && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="camera-overlay w-[78vw] max-w-[420px] aspect-square" />
                <div className="absolute bottom-32 left-0 right-0 text-center space-y-1">
                  <p className="text-sm font-medium text-foreground/80">Enquadre o adesivo no quadrado</p>
                  <p className="text-xs text-muted-foreground/80">Será usado crop 1:1 para o YOLO do adesivo</p>
                </div>
              </div>
            )}
            {overlayType !== 'none' && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-0.5 w-[78vw] max-w-[420px] bg-accent/60 animate-scan-line" />
              </div>
            )}
            {isCapturingMulti && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <div className="flex flex-col items-center gap-2 rounded-xl bg-card/90 px-6 py-4">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  <p className="text-sm font-bold text-foreground">Capturando frame {multiFrameProgress}/3</p>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="relative h-full w-full flex items-center justify-center bg-black">
            <img src={captured} alt="Captura" className="max-h-full max-w-full object-contain" />
          </div>
        )}
        <canvas ref={canvasRef} className="hidden" />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>

      <div className="flex gap-3 p-4">
        {!captured ? (
          <>
            <Button variant="secondary" className="flex-1 h-14 text-base font-semibold" onClick={handleGallery}>
              <ImagePlus className="mr-2 h-5 w-5" />
              Galeria
            </Button>
            <Button className="flex-1 h-14 text-base font-bold" onClick={capture} disabled={isCapturingMulti}>
              <Camera className="mr-2 h-5 w-5" />
              {multiFrame ? 'ALPR (3x)' : 'Capturar'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" className="flex-1 h-14 text-base" onClick={retake}>
              <RotateCcw className="mr-2 h-5 w-5" />
              Refazer
            </Button>
            <Button className="flex-1 h-14 text-base font-bold" onClick={confirm}>
              <Check className="mr-2 h-5 w-5" />
              Confirmar
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
