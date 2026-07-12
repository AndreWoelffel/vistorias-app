import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { createWorker, type Worker } from 'tesseract.js';
import {
  Check,
  Camera,
  Hash,
  ImagePlus,
  Loader2,
  ArrowLeft,
  AlertTriangle,
  Bug,
  ShieldCheck,
  Settings,
  XCircle,
  X,
  Trash2,
  Ban,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AppHeader } from '@/components/AppHeader';
import { CameraCapture } from '@/components/CameraCapture';
import { RealtimeScannerCamera, type ScanCapture } from '@/components/RealtimeScannerCamera';
import { addVistoria } from '@/hooks/useVistorias';
import { addToQueue, updateVistoria } from '@/lib/db';
import { recalculateDuplicateVistoriasForLeilao } from '@/services/duplicateVistoriaRecalc';
import { analyzeLocalDuplicateVistoria, duplicateUserMessage } from '@/services/inspectionService';
import { generateUuid } from '@/lib/uuid';
import {
  ocrWithVoting,
  compressImage,
  detectOQAmbiguity,
  preloadAlprModels,
  runStickerPipelineYOLO,
} from '@/lib/imageUtils';
import { useAuth } from '@/hooks/useAuth';
import { useRequireValidLeilao } from '@/hooks/useLeilaoRoute';
import { toast } from '@/hooks/use-toast';
import { fieldToasts } from '@/lib/uxCopy';
import { afterInspectionPath } from '@/config/appMode';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { processarPlaca } from '@/lib/plateValidator';
import { beginPlateCapturePerf, logPlateCapturePerf } from '@/lib/plateOcrPerf';
import { PLACA_SEM_PLACA, isSemPlaca } from '@/lib/placaSemPlaca';

type Step = 'placa' | 'numero' | 'fotos';
type CameraMode = 'placa' | 'numero' | 'chassi' | 'motor' | 'geral' | null;

export default function NewInspection() {
  const { leilaoId: routeLeilaoId, ready: leilaoReady } = useRequireValidLeilao();
  const navigate = useNavigate();
  const id = routeLeilaoId;
  const { user } = useAuth();

  const isAdmin = user?.role === 'admin';
  const [debugMode, setDebugMode] = useState(false);

  // Estados da UI
  const [step, setStep] = useState<Step>('placa');
  const [cameraMode, setCameraMode] = useState<CameraMode>(null);
  const [viewerImage, setViewerImage] = useState<string | null>(null);
  const [isGalleryManagerOpen, setIsGalleryManagerOpen] = useState(false);

  // Dados da Vistoria
  const [placa, setPlaca] = useState('');
  const [numero, setNumero] = useState('');

  // Hard Example Mining: guarda o que a IA leu originalmente para detectar correções manuais
  const [placaOriginalIA, setPlacaOriginalIA] = useState<string | null>(null);

  // Fotos Base (Necessárias para o Resumo calcular o total)
  const [fotoPlaca, setFotoPlaca] = useState<Blob | null>(null);
  const [fotoAdesivo, setFotoAdesivo] = useState<Blob | null>(null);

  // Fotos Técnicas
  const [hasChassi, setHasChassi] = useState(true);
  const [fotoChassi, setFotoChassi] = useState<File | null>(null);
  const [chassiUrl, setChassiUrl] = useState<string | null>(null);

  const [hasMotor, setHasMotor] = useState(true);
  const [fotoMotor, setFotoMotor] = useState<File | null>(null);
  const [motorUrl, setMotorUrl] = useState<string | null>(null);

  // Fotos Gerais
  const [fotosGerais, setFotosGerais] = useState<File[]>([]);
  const [fotosGeraisUrls, setFotosGeraisUrls] = useState<string[]>([]);

  // Estados de IA e Debug
  const [ocrLoading, setOcrLoading] = useState(false);
  const [oqWarning, setOqWarning] = useState<string | null>(null);
  const [geoCorrections, setGeoCorrections] = useState<string[]>([]);
  const [debugImage, setDebugImage] = useState<string | null>(null);
  const [charDebugImages, setCharDebugImages] = useState<string[]>([]);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [stickerLoading, setStickerLoading] = useState(false);
  const [stickerOcrDebugUrl, setStickerOcrDebugUrl] = useState<string | null>(null);
  const [stickerCharDebugImages, setStickerCharDebugImages] = useState<string[]>([]);
  const [stickerOcrConfidence, setStickerOcrConfidence] = useState<number | null>(null);

  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Rastreador de URLs (Memory Leak Prevention)
  const urlTracker = useRef<Set<string>>(new Set());

  useEffect(() => {
    preloadAlprModels();
  }, []);

  // Limpa URLs apenas ao desmontar o componente
  useEffect(() => {
    return () => {
      urlTracker.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const createTrackedUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urlTracker.current.add(url);
    return url;
  };

  const removePhotoGeral = (index: number) => {
    const urlToRemove = fotosGeraisUrls[index];
    URL.revokeObjectURL(urlToRemove);
    urlTracker.current.delete(urlToRemove);

    setFotosGerais((prev) => prev.filter((_, i) => i !== index));
    setFotosGeraisUrls((prev) => prev.filter((_, i) => i !== index));
  };

  // ════════════════════════════════════════════════════════════════════════
  // PROCESSAMENTO DE IA (OCR / YOLO)
  // ════════════════════════════════════════════════════════════════════════

  const runOCR = useCallback(async (
    blob: Blob,
    type: 'placa' | 'numero',
    opts?: { precomputedPlate?: { text: string; confidence: number }; perfLabel?: string },
  ) => {
    if (type === 'placa') {
      beginPlateCapturePerf();
    }

    setOcrLoading(true);
    setOcrConfidence(null);
    setDebugImage(null);
    setCharDebugImages([]);

    try {
      const cropType = type === 'placa' ? 'plate' as const : 'number' as const;
      const whitelist = type === 'placa' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' : '0123456789';

      const { text: rawText, confidence, corrections, debugImage: dbgImg, charDebugImages: charDbg } = await ocrWithVoting(
        blob,
        cropType,
        () => createWorker('por'),
        whitelist,
        opts?.precomputedPlate ? { precomputedPlate: opts.precomputedPlate } : undefined,
      );

      // Salva o blob original para a contagem no Resumo e envio para nuvem
      if (type === 'placa') setFotoPlaca(blob);
      if (type === 'numero') setFotoAdesivo(blob);

      setOcrConfidence(confidence);
      if (dbgImg) setDebugImage(dbgImg);
      if (charDbg) setCharDebugImages(charDbg);
      if (corrections && corrections.length > 0) setGeoCorrections(corrections);
      else setGeoCorrections([]);

      if (type === 'placa' && (rawText === '' || confidence < 30)) {
        setPlaca('');
        toast({ ...fieldToasts.placaNaoLeu, variant: 'destructive' });
        return;
      }
      
      if (type === 'numero' && confidence < 10) {
        toast({ ...fieldToasts.leituraFracaNumero, variant: 'destructive' });
        return;
      }

      if (type === 'placa') {
        const finalPlate = processarPlaca(rawText).slice(0, 7);
        setPlaca(finalPlate);
        setPlacaOriginalIA(finalPlate);
        const warning = detectOQAmbiguity(finalPlate);
        if (warning) setOqWarning(warning);
        logPlateCapturePerf(opts?.perfLabel ?? 'placa');
      } else {
        const match = rawText.match(/\d{5}/);
        setNumero(match ? match[0] : rawText.slice(0, 5));
      }
    } catch (err) {
      console.error('OCR error:', err);
      toast({ ...fieldToasts.ocrFalhou, variant: 'destructive' });
    } finally {
      setOcrLoading(false);
    }
  }, []);

  const handleMultiFrameCapture = useCallback(async (blobs: Blob[], type: 'placa' | 'numero') => {
    setOcrLoading(true);
    setOcrConfidence(null);
    setDebugImage(null);
    setCharDebugImages([]);
    try {
      const cropType = type === 'placa' ? 'plate' as const : 'number' as const;
      const whitelist = type === 'placa' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' : '0123456789';

      const results: { text: string; confidence: number; corrections?: string[]; debugImage?: string; charDebugImages?: string[] }[] = [];
      for (const blob of blobs) {
        try {
          const result = await ocrWithVoting(blob, cropType, () => createWorker('por'), whitelist);
          results.push(result);
        } catch { /* skip failed frame */ }
      }

      if (results.length === 0) {
        if (type === 'placa') setPlaca('');
        toast({ ...fieldToasts.multiFrameFalhou, variant: 'destructive' });
        return;
      }

      results.sort((a, b) => b.confidence - a.confidence);
      const best = results[0];
      
      if (type === 'placa') setFotoPlaca(blobs[0]);
      if (type === 'numero') setFotoAdesivo(blobs[0]);

      let text = best.text;
      setOcrConfidence(best.confidence);
      if (best.debugImage) setDebugImage(best.debugImage);
      if (best.charDebugImages) setCharDebugImages(best.charDebugImages);
      if (best.corrections && best.corrections.length > 0) setGeoCorrections(best.corrections);
      else setGeoCorrections([]);

      if (type === 'placa' && (text === '' || best.confidence < 30)) {
        setPlaca('');
        toast({ ...fieldToasts.placaNaoLeu, variant: 'destructive' });
        return;
      }
      
      if (type === 'numero' && best.confidence < 10) {
        toast({ ...fieldToasts.leituraFracaNumero, variant: 'destructive' });
        return;
      }

      if (type === 'placa') {
        const plate = processarPlaca(text).slice(0, 7);
        setPlaca(plate);
        setPlacaOriginalIA(plate);
        const warning = detectOQAmbiguity(plate);
        if (warning) setOqWarning(warning);
      } else {
        const match = text.match(/\d{5}/);
        if (match) text = match[0];
        setNumero(text.slice(0, 5));
      }
    } catch (err) {
      console.error('Multi-frame OCR error:', err);
      if (type === 'placa') setPlaca('');
      toast({ title: 'Erro no ALPR', description: 'Insira manualmente.', variant: 'destructive' });
    } finally {
      setOcrLoading(false);
    }
  }, []);

  const handleStickerCapture = useCallback(async (blob: Blob) => {
    setCameraMode(null);
    setStickerLoading(true);
    setStickerOcrDebugUrl(null);
    setStickerCharDebugImages([]);
    setStickerOcrConfidence(null);
    setFotoAdesivo(blob);

    try {
      const result = await runStickerPipelineYOLO(blob);

      if (!result || result.text.length === 0) {
        toast({ ...fieldToasts.adesivoNaoViu, variant: 'destructive' });
        return;
      }

      if (result.debugImage) setStickerOcrDebugUrl(result.debugImage);
      if (result.charDebugImages) setStickerCharDebugImages(result.charDebugImages);
      setStickerOcrConfidence(result.confidence);
      setNumero(result.text);
      toast({ ...fieldToasts.numeroLido });
    } catch (err) {
      console.error('Ler adesivo:', err);
      toast({ ...fieldToasts.lerAdesivoErro, variant: 'destructive' });
    } finally {
      setStickerLoading(false);
    }
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // ROTEAMENTO DE CÂMERA E CAPTURA
  // ════════════════════════════════════════════════════════════════════════

  const handlePlateScanCapture = useCallback((capture: ScanCapture) => {
    setCameraMode(null);
    const reusePreview =
      capture.gateApproved === true &&
      !!capture.previewText &&
      capture.previewConfidence != null;

    runOCR(capture.originalImageBlob, 'placa', reusePreview
      ? {
          precomputedPlate: {
            text: capture.previewText!,
            confidence: capture.previewConfidence!,
          },
          perfLabel: 'auto-capture',
        }
      : { perfLabel: 'manual-capture' });
  }, [runOCR]);

  const handleContinuousGeralCapture = useCallback(async (blob: Blob) => {
    const compressed = await compressImage(blob);
    const url = createTrackedUrl(compressed);
    const timestamp = Date.now();
    const file = new File([compressed], `FOTO_${placa || 'GERAL'}_${timestamp}.jpg`, { type: 'image/jpeg' });
    setFotosGerais((prev) => [...prev, file]);
    setFotosGeraisUrls((prev) => [...prev, url]);
  }, [placa]);

  const handleCapture = async (blob: Blob) => {
    if (cameraMode === 'numero') {
      handleStickerCapture(blob);
    } else if (cameraMode === 'chassi') {
      setCameraMode(null);
      const compressed = await compressImage(blob);
      const url = createTrackedUrl(compressed);
      const file = new File([compressed], `CHASSI_${placa || 'SEM_PLACA'}.jpg`, { type: 'image/jpeg' });
      setFotoChassi(file);
      setChassiUrl(url);
    } else if (cameraMode === 'motor') {
      setCameraMode(null);
      const compressed = await compressImage(blob);
      const url = createTrackedUrl(compressed);
      const file = new File([compressed], `MOTOR_${placa || 'SEM_PLACA'}.jpg`, { type: 'image/jpeg' });
      setFotoMotor(file);
      setMotorUrl(url);
    }
  };

  const handleMultiCapture = (blobs: Blob[]) => {
    if (cameraMode === 'placa') {
      setCameraMode(null);
      handleMultiFrameCapture(blobs, 'placa');
    }
  };

  // ════════════════════════════════════════════════════════════════════════
  // SUBMISSÃO E FLUXO
  // ════════════════════════════════════════════════════════════════════════

  const handleSave = async () => {
    if (!placa || !numero || isSubmitting) {
      if (!placa || !numero) {
        toast({ title: 'Campos obrigatórios', description: 'Preencha placa e número.', variant: 'destructive' });
      }
      return;
    }

    setIsSubmitting(true);

    try {
      const createdBy = user?.nome?.trim() || 'Desconhecido';
      const createdByUserId = user?.id?.trim() || null;
      let localUuid: string;

      try {
        localUuid = generateUuid();
      } catch {
        toast({ title: 'Erro de ID', description: 'Feche o app e tente de novo.', variant: 'destructive' });
        setIsSubmitting(false);
        return;
      }

      const allFotos: Blob[] = [...fotosGerais];

      if (fotoPlaca) {
        allFotos.unshift(new File([fotoPlaca], `PLACA_${placa || 'SEM_PLACA'}.jpg`, { type: 'image/jpeg' }));
      }
      if (fotoAdesivo) {
        allFotos.unshift(new File([fotoAdesivo], `ADESIVO_${placa || 'SEM_PLACA'}.jpg`, { type: 'image/jpeg' }));
      }

      if (hasChassi && fotoChassi) allFotos.push(fotoChassi);
      if (hasMotor && fotoMotor) allFotos.push(fotoMotor);

      const nowMs = Date.now();
      const finalPlacaUpper = placa.toUpperCase();

      const isHardExample =
        !isSemPlaca(finalPlacaUpper) &&
        placaOriginalIA !== null &&
        placaOriginalIA !== finalPlacaUpper;
      const isYoloError =
        isHardExample && placaOriginalIA !== null && placaOriginalIA.length !== 7;
      const isCnnError =
        isHardExample && placaOriginalIA !== null && placaOriginalIA.length === 7;

      const localId = await addVistoria({
        leilaoId: id,
        placa: finalPlacaUpper,
        numeroVistoria: numero,
        vistoriador: user?.nome || '',
        fotos: allFotos,
        statusSync: 'pendente_sync',
        createdAt: new Date(),
        updatedAt: nowMs,
        localUuid,
        createdBy,
        createdByUserId,
        isHardExample: isHardExample || undefined,
        isYoloError: isYoloError || undefined,
        isCnnError: isCnnError || undefined,
        placaSugeridaIA: isHardExample && placaOriginalIA ? placaOriginalIA : undefined,
      });

      const localDup = await analyzeLocalDuplicateVistoria(
        id,
        finalPlacaUpper,
        numero,
        localId,
      );

      if (localDup.duplicate) {
        await updateVistoria(localId, {
          statusSync: 'aguardando_ajuste',
          syncMessage: duplicateUserMessage(localDup.type),
          duplicateType: localDup.type,
          duplicateInfo: localDup.info,
          duplicateConflictWith: localDup.conflictWith,
        });
        void recalculateDuplicateVistoriasForLeilao(id);
        toast({
          title: 'Salva no aparelho',
          description: duplicateUserMessage(localDup.type),
          variant: 'destructive',
        });
      } else {
        await addToQueue({ type: 'create', entity: 'vistoria', payload: { localVistoriaId: localId } });
        const { processQueue } = await import('@/services/syncService');
        void processQueue();
        void recalculateDuplicateVistoriasForLeilao(id);
        toast({
          title: 'Vistoria registrada',
          description: 'Sincronizando em segundo plano. Você já pode iniciar outra.',
        });
      }

      navigate(afterInspectionPath(id), { replace: true });
    } catch (err) {
      console.error(err);
      toast({ title: 'Não salvou', description: 'Tente de novo. Se continuar, feche e abra o app.', variant: 'destructive' });
      setIsSubmitting(false);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (step === 'placa' && placa) {
      setDebugImage(null);
      setCharDebugImages([]);
      setOcrConfidence(null);
      setStep('numero');
    }
    else if (step === 'numero' && numero) {
      setStep('fotos');
    }
    else if (step === 'fotos') {
      handleSave();
    }
  };

  const handleCancel = () => setShowCancelDialog(true);
  const confirmCancel = () => navigate(afterInspectionPath(id), { replace: true });

  // ════════════════════════════════════════════════════════════════════════
  // RENDERIZAÇÃO
  // ════════════════════════════════════════════════════════════════════════

  if (!leilaoReady) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AppHeader title="Nova Vistoria" showBack onBack={() => navigate(id ? afterInspectionPath(id) : '/')} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground text-center">Carregando…</p>
        </div>
      </div>
    );
  }

  // TELA 1: Lightbox (Visualizador de Imagem Cheia)
  if (viewerImage) {
    return (
      <div className="fixed inset-0 z-[100] flex flex-col bg-black">
        <div className="flex justify-end p-4">
          <Button 
            variant="secondary" 
            size="icon" 
            onClick={() => setViewerImage(null)} 
            className="rounded-full shadow-lg"
          >
            <X className="h-6 w-6" />
          </Button>
        </div>
        <div className="flex-1 overflow-auto flex items-center justify-center p-2">
          <img 
            src={viewerImage} 
            alt="Visualização" 
            className="max-w-full max-h-full object-contain" 
          />
        </div>
      </div>
    );
  }

  // TELA 2: Gerenciador de Galeria
  if (isGalleryManagerOpen) {
    return (
      <div className="fixed inset-0 z-[90] flex flex-col bg-background">
        <AppHeader 
          title="Gerenciar Fotos Extras" 
          showBack 
          onBack={() => setIsGalleryManagerOpen(false)} 
        />
        <div className="flex-1 overflow-y-auto p-4">
          {fotosGeraisUrls.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <ImagePlus className="h-12 w-12 mb-2 opacity-20" />
              <p>Nenhuma foto extra adicionada.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {fotosGeraisUrls.map((url, i) => (
                <div key={url} className="relative aspect-square rounded-xl overflow-hidden border border-border shadow-sm group">
                  <img 
                    src={url} 
                    className="w-full h-full object-cover cursor-pointer" 
                    onClick={() => setViewerImage(url)} 
                    alt={`Galeria ${i}`}
                  />
                  <button 
                    onClick={() => removePhotoGeral(i)} 
                    className="absolute top-2 right-2 p-2 bg-destructive/90 hover:bg-destructive text-white rounded-full shadow-lg active:scale-95 transition-all"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="p-4 border-t border-border/50 bg-card">
          <Button 
            onClick={() => setIsGalleryManagerOpen(false)} 
            className="w-full h-14 font-bold text-lg rounded-xl shadow-md"
          >
            Voltar para a Vistoria
          </Button>
        </div>
      </div>
    );
  }

  // TELA 3: Câmera Dinâmica
  if (cameraMode) {
    // Placa → scanner YOLO em tempo real (auto-trigger, model_yolo_placas)
    if (cameraMode === 'placa') {
      return (
        <RealtimeScannerCamera
          mode="plate"
          onCapture={handlePlateScanCapture}
          onCancel={() => setCameraMode(null)}
        />
      );
    }

    // Adesivo → scanner YOLO em tempo real (auto-trigger, model_yolo_vistorias)
    if (cameraMode === 'numero') {
      return (
        <RealtimeScannerCamera
          mode="sticker"
          onCapture={({ originalImageBlob }) => handleStickerCapture(originalImageBlob)}
          onCancel={() => setCameraMode(null)}
        />
      );
    }

    // Fotos gerais (chassi, motor, geral) → câmera manual existente
    let title = "Capturar Foto";
    if (cameraMode === 'chassi') title = "Foto do Chassi";
    if (cameraMode === 'motor')  title = "Foto do Motor";
    if (cameraMode === 'geral')  title = "Foto Geral";

    return (
      <CameraCapture
        title={title}
        overlayType="none"
        continuousMode={cameraMode === 'geral'}
        continuousCount={fotosGerais.length}
        onContinuousCapture={cameraMode === 'geral' ? handleContinuousGeralCapture : undefined}
        onFinishContinuous={cameraMode === 'geral' ? () => setCameraMode(null) : undefined}
        onCapture={handleCapture}
        onCancel={() => setCameraMode(null)}
      />
    );
  }

  const steps = [
    { key: 'placa', label: 'Placa', icon: Camera },
    { key: 'numero', label: 'Nº Vistoria', icon: Hash },
    { key: 'fotos', label: 'Fotos', icon: ImagePlus },
  ] as const;

  const currentIdx = steps.findIndex((s) => s.key === step);

  // Cálculo de Resumo de Fotos
  const totalFotos = 
    (fotoPlaca ? 1 : 0) + 
    (fotoAdesivo ? 1 : 0) + 
    (hasChassi && fotoChassi ? 1 : 0) + 
    (hasMotor && fotoMotor ? 1 : 0) + 
    fotosGerais.length;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Nova vistoria" showBack onBack={handleCancel} />

      {/* Progress & Admin Debug Toggle */}
      <div className="flex flex-col gap-2 px-4 py-2 sm:py-3">
        <div className="flex items-center gap-1 w-full">
          {steps.map((s, i) => (
            <div key={s.key} className="flex flex-1 items-center gap-1">
              <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                i < currentIdx ? 'bg-accent text-accent-foreground' :
                i === currentIdx ? 'bg-primary text-primary-foreground' :
                'bg-secondary text-muted-foreground'
              }`}>
                {i < currentIdx ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              {i < steps.length - 1 && (
                <div className={`h-0.5 flex-1 rounded-full transition-colors ${i < currentIdx ? 'bg-accent' : 'bg-border'}`} />
              )}
            </div>
          ))}
        </div>
        
        {isAdmin && step !== 'fotos' && (
          <div className="flex justify-end mt-1">
            <Button
              type="button"
              variant={debugMode ? "default" : "ghost"}
              size="sm"
              onClick={() => setDebugMode(!debugMode)}
              className="h-7 text-[10px] gap-1.5 uppercase font-bold tracking-wider rounded-full shadow-sm"
            >
              <Bug className="h-3 w-3" />
              {debugMode ? 'Debug Ativo' : 'Ativar Debug'}
            </Button>
          </div>
        )}
      </div>

      <form onSubmit={handleFormSubmit} className="flex-1 flex flex-col min-h-0">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-32 pt-2 space-y-4">
          
          {/* ETAPA 1: PLACA */}
          {step === 'placa' && (
            <div className="space-y-4">
              <div className="card-glow rounded-xl bg-card p-4 sm:p-5 space-y-4">
                <div>
                  <h2 className="text-lg font-bold">Placa</h2>
                  <p className="text-sm text-muted-foreground">Foto ou digitação.</p>
                </div>
                <Button 
                  type="button" 
                  onClick={() => setCameraMode('placa')} 
                  className="w-full min-h-12 h-12 gap-2 text-base font-semibold shadow-sm" 
                  disabled={ocrLoading || isSemPlaca(placa)}
                >
                  <Camera className="h-5 w-5" />
                  Tirar fotos da placa
                </Button>
                
                {ocrLoading && (
                  <div className="flex items-center justify-center gap-2 py-3 text-primary">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span className="text-sm font-medium">Lendo placa…</span>
                  </div>
                )}
                
                {/* DEBUG: PLACA */}
                {debugMode && ocrConfidence !== null && !ocrLoading && (
                  <div className={`flex items-center gap-2 rounded-lg p-3 ${
                    ocrConfidence >= 80 ? 'bg-accent/10 border border-accent/30' : 'bg-destructive/10 border border-destructive/30'
                  }`}>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold">Confiança do OCR</span>
                        <span className={`text-xs font-black ${ocrConfidence >= 80 ? 'text-accent' : 'text-destructive'}`}>
                          {ocrConfidence.toFixed(0)}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full transition-all ${ocrConfidence >= 80 ? 'bg-accent' : 'bg-destructive'}`}
                          style={{ width: `${Math.min(ocrConfidence, 100)}%` }}
                        />
                      </div>
                    </div>
                    {ocrConfidence < 80 && <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />}
                  </div>
                )}
                
                {ocrConfidence !== null && ocrConfidence < 80 && !ocrLoading && (
                  <p className="text-xs text-amber-800 dark:text-amber-200 font-medium bg-amber-500/10 p-2 rounded-md">
                    Confira a placa: se estiver errada, corrija no campo abaixo.
                  </p>
                )}
                
                {oqWarning && (
                  <div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/30 p-3">
                    <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
                    <p className="text-xs text-foreground font-medium">{oqWarning}</p>
                  </div>
                )}
                
                {debugMode && (geoCorrections ?? []).length > 0 && (
                  <div className="rounded-lg bg-primary/10 border border-primary/30 p-3 space-y-1">
                    <p className="text-xs font-bold text-primary">Correções Geométricas Aplicadas</p>
                    {(geoCorrections ?? []).map((c, i) => (
                      <p key={i} className="text-xs text-muted-foreground font-mono">{c}</p>
                    ))}
                  </div>
                )}
                
                {debugMode && debugImage && !ocrLoading && (
                  <div className="space-y-2 p-3 border border-border/60 rounded-lg bg-secondary/20">
                    <p className="text-xs font-bold text-foreground">Visão Binarizada do ALPR</p>
                    <img
                      src={debugImage}
                      alt="Imagem processada pelo ALPR"
                      className="w-full rounded-md border border-border bg-white"
                      style={{ imageRendering: 'pixelated' }}
                    />
                  </div>
                )}
                
                {debugMode && (charDebugImages ?? []).length > 0 && !ocrLoading && (
                  <div className="space-y-2 p-3 border border-border/60 rounded-lg bg-secondary/20">
                    <p className="text-xs font-bold text-foreground">Caracteres Segmentados</p>
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {(charDebugImages ?? []).map((img, i) => (
                        <div key={i} className="flex flex-col items-center gap-1 shrink-0">
                          <img
                            src={img}
                            alt={`Char ${i + 1}`}
                            className="w-10 h-auto rounded border border-border bg-white shadow-sm"
                            style={{ imageRendering: 'pixelated' }}
                          />
                          <span className="text-[10px] font-mono font-bold text-muted-foreground">{i + 1}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-semibold text-foreground/80 mb-1">Placa</label>
                  <Input
                    value={placa}
                    onChange={(e) => {
                      const next = e.target.value.toUpperCase();
                      if (isSemPlaca(next)) {
                        setPlaca(PLACA_SEM_PLACA);
                      } else {
                        setPlaca(next.replace(/[^A-Z0-9]/g, '').slice(0, 7));
                      }
                      setOqWarning(null);
                    }}
                    placeholder={ocrLoading ? 'Processando…' : 'Ex.: ABC1D23'}
                    maxLength={isSemPlaca(placa) ? PLACA_SEM_PLACA.length : 7}
                    readOnly={isSemPlaca(placa)}
                    autoCapitalize="characters"
                    enterKeyHint="next"
                    className="h-14 text-center text-xl font-black tracking-widest uppercase bg-background shadow-inner"
                  />
                  {isSemPlaca(placa) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mt-2 w-full text-xs text-muted-foreground"
                      onClick={() => {
                        setPlaca('');
                        setFotoPlaca(null);
                      }}
                    >
                      Informar placa normalmente
                    </Button>
                  )}
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPlaca(PLACA_SEM_PLACA);
                  setFotoPlaca(null);
                  setPlacaOriginalIA(null);
                  setOcrConfidence(null);
                  setOqWarning(null);
                  setGeoCorrections([]);
                  setDebugImage(null);
                  setCharDebugImages([]);
                  setStep('numero');
                }}
                className="w-full min-h-12 h-12 gap-2 text-base font-semibold"
                disabled={ocrLoading}
              >
                <Ban className="h-5 w-5" />
                Veículo sem placa
              </Button>
            </div>
          )}

          {/* ETAPA 2: ADESIVO */}
          {step === 'numero' && (
            <div className="space-y-4">
              <div className="card-glow rounded-xl bg-card p-4 sm:p-5 space-y-4">
                <div>
                  <h2 className="text-lg font-bold">Número da vistoria</h2>
                  <p className="text-sm text-muted-foreground">5 números do adesivo.</p>
                </div>
                <Button
                  type="button"
                  onClick={() => setCameraMode('numero')}
                  disabled={stickerLoading}
                  variant="secondary"
                  className="w-full min-h-12 h-12 text-base font-semibold gap-2 shadow-sm"
                >
                  {stickerLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
                  Foto do adesivo
                </Button>
                
                {stickerLoading && (
                  <p className="text-sm font-medium text-center text-primary mt-2">Lendo adesivo…</p>
                )}

                {/* DEBUG: ADESIVO — espelha a UI de debug da Etapa 1 (Placas) */}
                {debugMode && stickerOcrConfidence !== null && !stickerLoading && (
                  <div className={`flex items-center gap-2 rounded-lg p-3 ${
                    stickerOcrConfidence >= 80 ? 'bg-accent/10 border border-accent/30' : 'bg-destructive/10 border border-destructive/30'
                  }`}>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold">Confiança do OCR</span>
                        <span className={`text-xs font-black ${stickerOcrConfidence >= 80 ? 'text-accent' : 'text-destructive'}`}>
                          {stickerOcrConfidence.toFixed(0)}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full transition-all ${stickerOcrConfidence >= 80 ? 'bg-accent' : 'bg-destructive'}`}
                          style={{ width: `${Math.min(stickerOcrConfidence, 100)}%` }}
                        />
                      </div>
                    </div>
                    {stickerOcrConfidence < 80 && <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />}
                  </div>
                )}

                {debugMode && stickerOcrDebugUrl && !stickerLoading && (
                  <div className="space-y-2 p-3 border border-border/60 rounded-lg bg-secondary/20">
                    <p className="text-xs font-bold text-foreground">Visão do YOLO — Dígitos Detectados</p>
                    <img
                      src={stickerOcrDebugUrl}
                      alt="Foto com bounding boxes dos dígitos"
                      className="w-full rounded-md border border-border bg-white"
                      style={{ imageRendering: 'pixelated' }}
                    />
                  </div>
                )}

                {debugMode && (stickerCharDebugImages ?? []).length > 0 && !stickerLoading && (
                  <div className="space-y-2 p-3 border border-border/60 rounded-lg bg-secondary/20">
                    <p className="text-xs font-bold text-foreground">Dígitos Segmentados</p>
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {(stickerCharDebugImages ?? []).map((img, i) => (
                        <div key={i} className="flex flex-col items-center gap-1 shrink-0">
                          <img
                            src={img}
                            alt={`Dígito ${i + 1}`}
                            className="w-10 h-auto rounded border border-border bg-white shadow-sm"
                            style={{ imageRendering: 'pixelated' }}
                          />
                          <span className="text-[10px] font-mono font-bold text-muted-foreground">{i + 1}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-semibold text-foreground/80 mb-1">Número (5 dígitos)</label>
                  <Input
                    value={numero}
                    onChange={(e) => setNumero(e.target.value.replace(/\D/g, '').slice(0, 5))}
                    placeholder="00000"
                    maxLength={5}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    enterKeyHint="next"
                    autoComplete="off"
                    className="h-14 text-center text-2xl font-black tracking-widest tabular-nums bg-background shadow-inner"
                  />
                </div>
              </div>
            </div>
          )}

          {/* ETAPA 3: FOTOS E TÉCNICA */}
          {step === 'fotos' && (
            <div className="space-y-4">
              
              {/* CARD CHASSI */}
              <div className="card-glow rounded-xl bg-card p-5 space-y-4 border border-border/50">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <div className="bg-primary/10 p-2 rounded-lg">
                      <ShieldCheck className="text-primary h-5 w-5" />
                    </div>
                    <div>
                      <h2 className="text-base font-bold">Foto do Chassi</h2>
                      <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-tighter">
                        Numeração estrutural
                      </p>
                    </div>
                  </div>
                  <div className="flex bg-secondary rounded-lg p-1">
                    <button 
                      type="button" 
                      onClick={() => setHasChassi(true)} 
                      className={`px-3 py-1.5 text-[10px] font-black rounded-md transition-all ${hasChassi ? 'bg-primary text-white shadow' : 'text-muted-foreground'}`}
                    >
                      SIM
                    </button>
                    <button 
                      type="button" 
                      onClick={() => { setHasChassi(false); setFotoChassi(null); setChassiUrl(null); }} 
                      className={`px-3 py-1.5 text-[10px] font-black rounded-md transition-all ${!hasChassi ? 'bg-destructive text-white shadow' : 'text-muted-foreground'}`}
                    >
                      NÃO
                    </button>
                  </div>
                </div>

                {hasChassi ? (
                  <div className="flex items-center gap-3">
                    {chassiUrl && (
                      <div 
                        className="h-12 w-12 rounded-lg overflow-hidden border-2 border-primary/20 shadow-sm cursor-pointer shrink-0"
                        onClick={() => setViewerImage(chassiUrl)}
                      >
                        <img src={chassiUrl} className="h-full w-full object-cover" alt="Chassi" />
                      </div>
                    )}
                    <Button 
                      type="button" 
                      onClick={() => setCameraMode('chassi')} 
                      variant="outline" 
                      className="flex-1 h-12 gap-2 border-dashed border-primary/40 font-semibold text-foreground"
                    >
                      <Camera className="h-4 w-4 text-primary" /> 
                      {fotoChassi ? 'Trocar Foto' : 'Fotografar'}
                    </Button>
                  </div>
                ) : (
                  <p className="text-[10px] text-muted-foreground/80 italic flex items-center gap-1.5 bg-destructive/5 p-2 rounded-md border border-destructive/10">
                    <XCircle className="h-3 w-3 text-destructive" /> 
                    Inacessível ou inexistente.
                  </p>
                )}
              </div>

              {/* CARD MOTOR */}
              <div className="card-glow rounded-xl bg-card p-5 space-y-4 border border-border/50">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <div className="bg-primary/10 p-2 rounded-lg">
                      <Settings className="text-primary h-5 w-5" />
                    </div>
                    <div>
                      <h2 className="text-base font-bold">Foto do Motor</h2>
                      <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-tighter">
                        Numeração do bloco
                      </p>
                    </div>
                  </div>
                  <div className="flex bg-secondary rounded-lg p-1">
                    <button 
                      type="button" 
                      onClick={() => setHasMotor(true)} 
                      className={`px-3 py-1.5 text-[10px] font-black rounded-md transition-all ${hasMotor ? 'bg-primary text-white shadow' : 'text-muted-foreground'}`}
                    >
                      SIM
                    </button>
                    <button 
                      type="button" 
                      onClick={() => { setHasMotor(false); setFotoMotor(null); setMotorUrl(null); }} 
                      className={`px-3 py-1.5 text-[10px] font-black rounded-md transition-all ${!hasMotor ? 'bg-destructive text-white shadow' : 'text-muted-foreground'}`}
                    >
                      NÃO
                    </button>
                  </div>
                </div>

                {hasMotor ? (
                  <div className="flex items-center gap-3">
                    {motorUrl && (
                      <div 
                        className="h-12 w-12 rounded-lg overflow-hidden border-2 border-primary/20 shadow-sm cursor-pointer shrink-0"
                        onClick={() => setViewerImage(motorUrl)}
                      >
                        <img src={motorUrl} className="h-full w-full object-cover" alt="Motor" />
                      </div>
                    )}
                    <Button 
                      type="button" 
                      onClick={() => setCameraMode('motor')} 
                      variant="outline" 
                      className="flex-1 h-12 gap-2 border-dashed border-primary/40 font-semibold text-foreground"
                    >
                      <Camera className="h-4 w-4 text-primary" /> 
                      {fotoMotor ? 'Trocar Foto' : 'Fotografar'}
                    </Button>
                  </div>
                ) : (
                  <p className="text-[10px] text-muted-foreground/80 italic flex items-center gap-1.5 bg-destructive/5 p-2 rounded-md border border-destructive/10">
                    <XCircle className="h-3 w-3 text-destructive" /> 
                    Inacessível ou sem numeração.
                  </p>
                )}
              </div>

              {/* CARD FOTOS GERAIS */}
              <div className="card-glow rounded-xl bg-card p-5 space-y-4 border border-border/50">
                <div className="flex justify-between items-start">
                   <div>
                     <h2 className="text-lg font-bold flex items-center gap-2">
                       <ImagePlus className="text-primary h-5 w-5" /> Fotos Gerais
                     </h2>
                     <p className="text-xs text-muted-foreground mt-0.5">
                       Laterais, avarias e ângulos extras.
                     </p>
                   </div>
                   
                   {fotosGeraisUrls.length > 0 && (
                     <Button 
                       type="button" 
                       variant="ghost" 
                       onClick={() => setIsGalleryManagerOpen(true)} 
                       className="text-primary text-xs font-bold gap-1 px-2 h-8 underline"
                     >
                       <Trash2 className="h-3 w-3" /> Gerenciar
                     </Button>
                   )}
                </div>

                <Button 
                  type="button" 
                  onClick={() => setCameraMode('geral')} 
                  variant="secondary" 
                  className="w-full h-12 gap-2 font-bold shadow-sm"
                >
                  <ImagePlus className="h-5 w-5" /> 
                  Adicionar foto extra
                </Button>

                {fotosGeraisUrls.length > 0 && (
                  <div className="grid grid-cols-4 gap-2 pt-2">
                    {fotosGeraisUrls.slice(0, 4).map((url, i) => (
                      <div key={url} className="relative aspect-square">
                        <img 
                          src={url} 
                          onClick={() => setViewerImage(url)} 
                          className="w-full h-full object-cover rounded-lg border border-border cursor-pointer shadow-sm hover:opacity-80 transition-opacity" 
                          alt={`Galeria ${i}`}
                        />
                        {i === 3 && fotosGeraisUrls.length > 4 && (
                          <div 
                            className="absolute inset-0 bg-black/70 rounded-lg flex items-center justify-center text-white text-sm font-bold cursor-pointer backdrop-blur-[2px]"
                            onClick={() => setIsGalleryManagerOpen(true)}
                          >
                            +{fotosGeraisUrls.length - 3}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* CARD RESUMO FINAL */}
              <div className="card-glow rounded-xl bg-card p-5 space-y-2.5 text-sm border-t-4 border-primary">
                <h3 className="text-xs font-black text-muted-foreground uppercase tracking-widest mb-1">
                  Resumo da Vistoria
                </h3>
                <div className="flex justify-between items-center py-1 border-b border-border/40">
                  <span className="text-muted-foreground">Vistoriador</span>
                  <span className="font-bold">{user?.nome}</span>
                </div>
                <div className="flex justify-between items-center py-1 border-b border-border/40">
                  <span className="text-muted-foreground">Placa</span>
                  <span className={`font-black text-primary text-lg ${isSemPlaca(placa) ? 'tracking-normal' : 'tracking-widest'}`}>
                    {isSemPlaca(placa) ? 'Sem Placa' : placa}
                  </span>
                </div>
                <div className="flex justify-between items-center py-1 border-b border-border/40">
                  <span className="text-muted-foreground">Nº Adesivo</span>
                  <span className="font-black text-foreground tracking-widest">{numero}</span>
                </div>
                <div className="flex justify-between items-center py-1">
                  <span className="text-muted-foreground">Fotos da Vistoria</span>
                  <span className="font-black text-primary text-lg">{totalFotos}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border/50 bg-background/95 backdrop-blur-md px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-lg w-full gap-2">
            {step !== 'placa' && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep(step === 'fotos' ? 'numero' : 'placa')}
                className="h-14 min-w-[80px] rounded-xl"
                disabled={isSubmitting}
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
            )}
            <Button
              type="submit"
              disabled={
                isSubmitting ||
                (step === 'placa' ? !placa : step === 'numero' ? !numero : false)
              }
              className="h-14 flex-1 text-lg font-bold rounded-xl shadow-lg"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-6 w-6 animate-spin" /> Salvando…
                </>
              ) : step === 'fotos' ? (
                <>
                  <Check className="mr-2 h-6 w-6" /> Concluir Vistoria
                </>
              ) : (
                'Próximo Passo'
              )}
            </Button>
          </div>
        </div>
      </form>

      <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descartar vistoria?</AlertDialogTitle>
            <AlertDialogDescription>
              Tudo o que você preencheu ou fotografou até agora será perdido.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel className="font-medium mt-0">Continuar Vistoria</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCancel}
              className="bg-destructive text-destructive-foreground font-bold hover:bg-destructive/90"
            >
              Sim, descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}