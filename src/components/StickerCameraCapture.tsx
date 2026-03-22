import { useRef, useState, useCallback, useEffect } from 'react';
import { Camera, X, RotateCcw, Check, ImagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StickerGalleryCrop } from '@/components/StickerGalleryCrop';

/**
 * Câmera dedicada ao Passo 2 (Adesivo). Tudo fixo em 1:1 (quadrado):
 * - Overlay da câmera é um quadrado perfeito
 * - Galeria abre recorte com aspect ratio 1:1 (sem corte livre)
 */
interface StickerCameraCaptureProps {
  onCapture: (blob: Blob, dataUrl: string) => void;
  onCancel: () => void;
  title: string;
}

export function StickerCameraCapture({ onCapture, onCancel, title }: StickerCameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);
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
    const result = await captureFrame();
    if (result) {
      setCapturedBlob(result.blob);
      setCaptured(result.dataUrl);
      stopCamera();
    }
  };

  const handleGallery = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    stopCamera();
    const url = URL.createObjectURL(file);
    setGalleryCropUrl(url);
    setGalleryCropBlob(file);
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
    startCamera();
  };

  const confirm = () => {
    if (capturedBlob && captured) {
      onCapture(capturedBlob, captured);
    }
  };

  // Galeria: crop quadrado "cego" (quadrado central fixo, sem biblioteca interativa)
  if (galleryCropUrl && galleryCropBlob) {
    return (
      <StickerGalleryCrop
        imageUrl={galleryCropUrl}
        imageBlob={galleryCropBlob}
        onConfirm={handleCropConfirm}
        onCancel={handleCropCancel}
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
            {/* Overlay fixo 1:1 — quadrado perfeito */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div
                className="camera-overlay border-2 border-green-500 bg-green-500/10 rounded-lg"
                style={{ width: 'min(78vw, 320px)', height: 'min(78vw, 320px)', aspectRatio: '1', boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)' }}
              />
            </div>
            <div className="absolute bottom-28 left-0 right-0 text-center space-y-1 pointer-events-none">
              <p className="text-sm font-medium text-white drop-shadow">Enquadre o adesivo no quadrado verde</p>
              <p className="text-xs text-white/80 drop-shadow">Crop 1:1 para o YOLO do adesivo</p>
            </div>
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
            <Button className="flex-1 h-14 text-base font-bold" onClick={capture}>
              <Camera className="mr-2 h-5 w-5" />
              Capturar
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
