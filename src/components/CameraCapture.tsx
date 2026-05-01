import { useRef, useState, useCallback, useEffect } from 'react';
import { Camera, X, RotateCcw, Check, ImagePlus, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PlateFrameEditor } from '@/components/PlateFrameEditor';

interface CameraCaptureProps {
  onCapture: (blob: Blob, dataUrl: string) => void;
  onMultiCapture?: (blobs: Blob[]) => void;
  onCancel: () => void;
  overlayType?: 'plate' | 'number' | 'none';
  title: string;
  multiFrame?: boolean;
}

export function CameraCapture({ onCapture, onMultiCapture, onCancel, overlayType = 'none', title, multiFrame = false }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Refs de Arquitetura Segura (Substituem o useState do Stream)
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const initRef = useRef<boolean>(false);

  // Estados de Controle de Hardware
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // A foto inteira (crua) recém tirada da câmera ou galeria (ainda sem crop)
  const [rawImageUrl, setRawImageUrl] = useState<string | null>(null);
  
  // A foto processada final (quando não precisa de crop, ex: fotos extras do carro)
  const [capturedFinal, setCapturedFinal] = useState<string | null>(null);
  const [capturedFinalBlob, setCapturedFinalBlob] = useState<Blob | null>(null);
  
  const [multiFrameProgress, setMultiFrameProgress] = useState<number>(0);
  const [isCapturingMulti, setIsCapturingMulti] = useState(false);

  // Inicialização segura anti-piscadas
  const startCamera = useCallback(async () => {
    if (initRef.current) return;
    initRef.current = true;
    setErrorMsg(null);

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      
      if (videoRef.current) {
        mediaStreamRef.current = mediaStream;
        videoRef.current.srcObject = mediaStream;
        videoRef.current.onloadedmetadata = () => {
          setHasPermission(true);
        };
      }
    } catch (err) {
      console.error('Erro ao acessar câmera:', err);
      setHasPermission(false);
      setErrorMsg('Não foi possível acessar a câmera. Verifique as permissões do navegador.');
      initRef.current = false; // Libera para tentar de novo
    }
  }, []);

  // Desligamento explícito de hardware
  const stopCamera = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, [startCamera, stopCamera]);

  // Limpeza de memória
  useEffect(() => {
    return () => {
      if (rawImageUrl) URL.revokeObjectURL(rawImageUrl);
    };
  }, [rawImageUrl]);

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

  const captureSingleOrRouteToCrop = async () => {
    const result = await captureFrame();
    if (result) {
      stopCamera();
      
      if (overlayType === 'none') {
        // Foto livre (Carro), não precisa de crop manual, vai direto pra visualização final
        setCapturedFinalBlob(result.blob);
        setCapturedFinal(result.dataUrl);
      } else {
        // Placa ou Adesivo: abre a tela de corte interativo
        setRawImageUrl(result.dataUrl);
      }
    }
  };

  const captureMulti = async () => {
    if (!onMultiCapture) return;
    setIsCapturingMulti(true);
    const blobs: Blob[] = [];
    for (let i = 0; i < 3; i++) {
      setMultiFrameProgress(i + 1);
      const result = await captureFrame();
      if (result) {
        blobs.push(result.blob);
      }
      if (i < 2) await new Promise((r) => setTimeout(r, 300));
    }
    setIsCapturingMulti(false);
    stopCamera();
    if (blobs.length > 0) {
      onMultiCapture(blobs); // Multi-frame não passa por crop manual
    }
  };

  const capture = () => {
    if (multiFrame) captureMulti();
    else captureSingleOrRouteToCrop();
  };

  const handleGallery = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    stopCamera();

    const url = URL.createObjectURL(file);
    
    if (overlayType === 'none') {
      // Foto Livre
      setCapturedFinal(url);
      setCapturedFinalBlob(file);
    } else {
      // Placa ou Adesivo: Manda para o editor de corte
      setRawImageUrl(url);
    }
  };

  const retake = () => {
    setCapturedFinal(null);
    setCapturedFinalBlob(null);
    if (rawImageUrl) URL.revokeObjectURL(rawImageUrl);
    setRawImageUrl(null);
    setMultiFrameProgress(0);
    initRef.current = false; // Libera a trava
    startCamera();
  };

  const confirmFinal = () => {
    if (capturedFinalBlob && capturedFinal) {
      onCapture(capturedFinalBlob, capturedFinal);
    }
  };

  const retryCamera = () => {
    initRef.current = false;
    startCamera();
  };

  // 1. SE TEM IMAGEM CRUA DE PLACA/ADESIVO, MOSTRA O EDITOR DE CORTE UNIFICADO
  if (rawImageUrl && (overlayType === 'plate' || overlayType === 'number')) {
    return (
      <PlateFrameEditor
        imageUrl={rawImageUrl}
        overlayType={overlayType}
        onConfirm={(blob, dataUrl) => onCapture(blob, dataUrl)}
        onCancel={retake}
      />
    );
  }

  // 2. TELA DA CÂMERA OU DE VISUALIZAÇÃO FINAL (Para fotos livres)
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between p-4 border-b border-border/50 bg-card">
        <h2 className="text-lg font-bold text-foreground">{title}</h2>
        <Button variant="ghost" size="icon" onClick={() => { stopCamera(); onCancel(); }}>
          <X className="h-6 w-6" />
        </Button>
      </div>

      <div className="relative flex-1 overflow-hidden bg-black flex items-center justify-center">
        {!capturedFinal ? (
          hasPermission === false ? (
            <div className="p-6 text-center space-y-4">
              <AlertTriangle className="h-12 w-12 text-destructive mx-auto" />
              <h3 className="text-xl font-bold text-white">Câmera Indisponível</h3>
              <p className="text-sm text-gray-400">{errorMsg}</p>
              <Button onClick={retryCamera} variant="secondary" className="mt-4 gap-2">
                <RefreshCw className="h-4 w-4" /> Tentar Novamente
              </Button>
            </div>
          ) : (
            <>
              <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-cover" />
              
              {/* Guias Visuais */}
              {overlayType === 'plate' && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="border-2 border-white/50 border-dashed rounded-lg w-[78vw] max-w-[320px] aspect-square" />
                  <div className="absolute bottom-28 left-0 right-0 text-center space-y-1 bg-black/40 py-2">
                    <p className="text-sm font-medium text-white">Centralize a Placa</p>
                    <p className="text-[10px] text-white/70">Você poderá ajustar o corte na próxima tela</p>
                  </div>
                </div>
              )}
              
              {overlayType === 'number' && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="border-2 border-white/50 border-dashed rounded-lg w-[78vw] max-w-[320px] aspect-square" />
                  <div className="absolute bottom-28 left-0 right-0 text-center space-y-1 bg-black/40 py-2">
                    <p className="text-sm font-medium text-white">Centralize o Adesivo</p>
                    <p className="text-[10px] text-white/70">Você poderá ajustar o corte na próxima tela</p>
                  </div>
                </div>
              )}

              {overlayType !== 'none' && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="h-0.5 w-[78vw] max-w-[320px] bg-primary/60 animate-scan-line" />
                </div>
              )}

              {isCapturingMulti && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm z-10">
                  <div className="flex flex-col items-center gap-3 rounded-2xl bg-card p-6 shadow-2xl">
                    <Loader2 className="h-10 w-10 animate-spin text-primary" />
                    <p className="text-sm font-bold text-foreground tracking-wide">LENDO FRAME {multiFrameProgress}/3</p>
                  </div>
                </div>
              )}
            </>
          )
        ) : (
          <div className="relative h-full w-full flex items-center justify-center bg-black">
            <img src={capturedFinal} alt="Captura Final" className="max-h-full max-w-full object-contain" />
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

      <div className="flex gap-3 p-4 bg-card border-t border-border/50 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {!capturedFinal ? (
          <>
            <Button variant="secondary" className="flex-1 h-16 text-base font-semibold rounded-xl" onClick={handleGallery}>
              <ImagePlus className="mr-2 h-5 w-5" />
              Galeria
            </Button>
            <Button 
              className="flex-1 h-16 text-base font-bold rounded-xl shadow-md" 
              onClick={capture} 
              disabled={isCapturingMulti || hasPermission === false}
            >
              <Camera className="mr-2 h-6 w-6" />
              {multiFrame ? 'ALPR (3x)' : 'Capturar'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" className="flex-1 h-14 text-base font-semibold rounded-xl" onClick={retake}>
              <RotateCcw className="mr-2 h-5 w-5" />
              Tirar Outra
            </Button>
            <Button className="flex-1 h-14 text-base font-bold rounded-xl shadow-md" onClick={confirmFinal}>
              <Check className="mr-2 h-5 w-5" />
              Confirmar Foto
            </Button>
          </>
        )}
      </div>
    </div>
  );
}