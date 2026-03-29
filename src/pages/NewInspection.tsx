import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { createWorker, type Worker } from 'tesseract.js';
import { Check, Camera, Hash, ImagePlus, Loader2, ArrowLeft, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AppHeader } from '@/components/AppHeader';
import { CameraCapture } from '@/components/CameraCapture';
import { StickerCameraCapture } from '@/components/StickerCameraCapture';
import { addVistoria, updateVistoria } from '@/hooks/useVistorias';
import { addToQueue, getVistoriaById, normalizeVistoriaStatusSync } from '@/lib/db';
import { analyzeLocalDuplicateVistoria, duplicateUserMessage } from '@/services/inspectionService';
import { ocrWithVoting, compressImage, detectOQAmbiguity, preloadAlprModels, detectStickerBox, extractAndPrepareSticker } from '@/lib/imageUtils';
import { readStickerNumber } from '@/services/ocrService';
import { useAuth } from '@/hooks/useAuth';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useRequireValidLeilao } from '@/hooks/useLeilaoRoute';
import { toast } from '@/hooks/use-toast';
import { fieldToasts } from '@/lib/uxCopy';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type Step = 'placa' | 'numero' | 'fotos' | 'saving';

export default function NewInspection() {
  const { leilaoId: routeLeilaoId, ready: leilaoReady } = useRequireValidLeilao();
  const navigate = useNavigate();
  const id = routeLeilaoId;
  const { user } = useAuth();
  const { currentUser } = useCurrentUser();

  const [step, setStep] = useState<Step>('placa');
  const [placa, setPlaca] = useState('');
  const [numero, setNumero] = useState('');
  const [fotos, setFotos] = useState<Blob[]>([]);
  const [fotoUrls, setFotoUrls] = useState<string[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [oqWarning, setOqWarning] = useState<string | null>(null);
  const [geoCorrections, setGeoCorrections] = useState<string[]>([]);
  const [debugImage, setDebugImage] = useState<string | null>(null);
  const [charDebugImages, setCharDebugImages] = useState<string[]>([]);
  const [showCancelDialog, setShowCancelDialog] = useState(false);

  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [stickerLoading, setStickerLoading] = useState(false);
  const [stickerOcrDebugOpen, setStickerOcrDebugOpen] = useState(false);
  const [stickerOcrDebugUrl, setStickerOcrDebugUrl] = useState<string | null>(null);

  useEffect(() => {
    preloadAlprModels();
  }, []);

  const runOCR = useCallback(async (blob: Blob, type: 'placa' | 'numero') => {
    setOcrLoading(true);
    setOcrConfidence(null);
    setDebugImage(null);
    setCharDebugImages([]);
    try {
      const cropType = type === 'placa' ? 'plate' as const : 'number' as const;
      const whitelist = type === 'placa'
        ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        : '0123456789';

      const { text: rawText, confidence, corrections, debugImage: dbgImg, charDebugImages: charDbg } = await ocrWithVoting(
        blob,
        cropType,
        () => createWorker('por'),
        whitelist
      );

      let text = rawText;
      setOcrConfidence(confidence);
      if (dbgImg) setDebugImage(dbgImg);
      if (charDbg) setCharDebugImages(charDbg);
      if (corrections && corrections.length > 0) setGeoCorrections(corrections);
      else setGeoCorrections([]);
      if (import.meta.env.DEV) {
        console.log(
          `ALPR result: "${text}" (confidence: ${confidence.toFixed(1)}%, corrections: ${corrections?.length || 0})`,
        );
      }

      // Fallback limpo: não preencher com texto inválido; limpa o campo
      if (type === 'placa' && (text === '' || confidence < 30)) {
        setPlaca('');
        toast({ ...fieldToasts.placaNaoLeu, variant: 'destructive' });
        return;
      }
      if (type === 'numero' && confidence < 10) {
        toast({ ...fieldToasts.leituraFracaNumero, variant: 'destructive' });
        return;
      }

      if (type === 'placa') {
        const match = text.match(/[A-Z]{3}[0-9][A-Z0-9][0-9]{2}/);
        if (match) text = match[0];
        const plate = text.slice(0, 7);
        setPlaca(plate);
        const warning = detectOQAmbiguity(plate);
        if (warning) setOqWarning(warning);
      } else {
        const match = text.match(/\d{5}/);
        if (match) text = match[0];
        setNumero(text.slice(0, 5));
      }
    } catch (err) {
      console.error('OCR error:', err);
      if (type === 'placa') setPlaca('');
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
      const whitelist = type === 'placa'
        ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        : '0123456789';

      // Process all frames and pick best result
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

      // Pick highest confidence
      results.sort((a, b) => b.confidence - a.confidence);
      const best = results[0];
      let text = best.text;
      setOcrConfidence(best.confidence);
      if (best.debugImage) setDebugImage(best.debugImage);
      if (best.charDebugImages) setCharDebugImages(best.charDebugImages);
      if (best.corrections && best.corrections.length > 0) setGeoCorrections(best.corrections);
      else setGeoCorrections([]);
      if (import.meta.env.DEV) {
        console.log(
          `Multi-frame ALPR: "${text}" (confidence: ${best.confidence.toFixed(1)}%, frames: ${results.length})`,
        );
      }

      // Fallback limpo para placa: limpa o campo e toast
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
        const match = text.match(/[A-Z]{3}[0-9][A-Z0-9][0-9]{2}/);
        if (match) text = match[0];
        const plate = text.slice(0, 7);
        setPlaca(plate);
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

  const handlePlacaCapture = (blob: Blob) => {
    setShowCamera(false);
    runOCR(blob, 'placa');
  };

  const handlePlacaMultiCapture = (blobs: Blob[]) => {
    setShowCamera(false);
    handleMultiFrameCapture(blobs, 'placa');
  };

  const handleNumeroCapture = (blob: Blob) => {
    setShowCamera(false);
    runOCR(blob, 'numero');
  };

  const handleNumeroMultiCapture = (blobs: Blob[]) => {
    setShowCamera(false);
    handleMultiFrameCapture(blobs, 'numero');
  };

  const handleFotoCapture = async (blob: Blob) => {
    setShowCamera(false);
    const compressed = await compressImage(blob);
    const url = URL.createObjectURL(compressed);
    setFotos((prev) => [...prev, compressed]);
    setFotoUrls((prev) => [...prev, url]);
  };

  const handleSave = async () => {
    if (!placa || !numero) {
      toast({ title: 'Campos obrigatórios', description: 'Preencha placa e número.', variant: 'destructive' });
      return;
    }
    setStep('saving');
    try {
      const createdBy =
        currentUser?.nome?.trim() || user?.nome?.trim() || 'Desconhecido';
      const createdByUserId =
        currentUser?.id != null ? String(currentUser.id) : null;

      const localUuid =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `vis-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

      const nowMs = Date.now();
      const dupLocal = await analyzeLocalDuplicateVistoria(id, placa.toUpperCase(), numero);
      const isDup = dupLocal.duplicate;
      const localId = await addVistoria({
        leilaoId: id,
        placa: placa.toUpperCase(),
        numeroVistoria: numero,
        vistoriador: user?.nome || '',
        fotos,
        statusSync: isDup ? 'aguardando_ajuste' : 'pendente_sync',
        syncMessage: isDup ? duplicateUserMessage(dupLocal.type) : undefined,
        duplicateType: isDup ? dupLocal.type : undefined,
        duplicateInfo: isDup ? dupLocal.info : undefined,
        createdAt: new Date(),
        updatedAt: nowMs,
        localUuid,
        createdBy,
        createdByUserId,
      });

      if (!isDup) {
        await addToQueue({
          type: 'create',
          entity: 'vistoria',
          payload: { localVistoriaId: localId },
        });
        const { processQueue } = await import('@/services/syncService');
        await processQueue();
      }

      const v = await getVistoriaById(localId);
      const st = normalizeVistoriaStatusSync(v?.statusSync);

      if (st === 'aguardando_ajuste') {
        toast({
          title: 'Salva no aparelho',
          description: v?.syncMessage ?? 'Corrija e envie de novo.',
        });
      } else if (st === 'conflito_duplicidade') {
        toast({
          title: 'Duplicado no servidor',
          description:
            v?.syncMessage ??
            'Já existe essa placa ou número lá. Abra o registro, corrija e envie de novo.',
          variant: 'destructive',
        });
      } else if (st === 'sincronizado') {
        toast({ title: 'Pronto', description: `Placa ${placa} já está no servidor.` });
      } else if (st === 'erro_sync') {
        toast({
          title: 'Erro ao enviar',
          description:
            v?.syncMessage ?? 'Sem internet ou falha no envio. Abra o painel e toque em enviar de novo.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Salva no aparelho',
          description: 'Enviamos automaticamente quando a internet voltar.',
        });
      }
      navigate(`/dashboard/${id}`, { replace: true });
    } catch (err) {
      console.error(err);
      toast({
        title: 'Não salvou',
        description: 'Tente de novo. Se continuar, feche e abra o app.',
        variant: 'destructive',
      });
      setStep('fotos');
    }
  };

  const handleStickerCapture = useCallback(async (blob: Blob) => {
    setShowCamera(false);
    setStickerLoading(true);
    try {
      const box = await detectStickerBox(blob);
      if (!box) {
        toast({ ...fieldToasts.adesivoNaoViu, variant: 'destructive' });
        return;
      }
      const img = await createImageBitmap(blob);
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = img.width;
      sourceCanvas.height = img.height;
      sourceCanvas.getContext('2d')!.drawImage(img, 0, 0);
      if (typeof img.close === 'function') img.close();

      const stickerCanvas = extractAndPrepareSticker(sourceCanvas, box, {
        onDebugBinarized: (url) => {
          setStickerOcrDebugUrl(url);
          setStickerOcrDebugOpen(true);
        },
      });
      const text = await readStickerNumber(stickerCanvas);
      setNumero(text ?? '');
      toast({ ...fieldToasts.numeroLido });
    } catch (err) {
      console.error('Ler adesivo:', err);
      toast({ ...fieldToasts.lerAdesivoErro, variant: 'destructive' });
    } finally {
      setStickerLoading(false);
    }
  }, []);

  const handleCancel = () => setShowCancelDialog(true);
  const confirmCancel = () => navigate(`/dashboard/${id}`, { replace: true });

  if (!leilaoReady) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AppHeader title="Nova Vistoria" showBack onBack={() => navigate('/')} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground text-center">Carregando…</p>
        </div>
      </div>
    );
  }

  if (showCamera) {
    if (step === 'placa') {
      return <CameraCapture title="Foto da placa" overlayType="plate" multiFrame onCapture={handlePlacaCapture} onMultiCapture={handlePlacaMultiCapture} onCancel={() => setShowCamera(false)} />;
    }
    if (step === 'numero') {
      return (
        <StickerCameraCapture
          title="Foto do adesivo"
          onCapture={(blob) => handleStickerCapture(blob)}
          onCancel={() => setShowCamera(false)}
        />
      );
    }
    return <CameraCapture title="Outra foto" overlayType="none" onCapture={handleFotoCapture} onCancel={() => setShowCamera(false)} />;
  }

  const steps = [
    { key: 'placa', label: 'Placa', icon: Camera },
    { key: 'numero', label: 'Nº Vistoria', icon: Hash },
    { key: 'fotos', label: 'Fotos', icon: ImagePlus },
  ] as const;

  const currentIdx = steps.findIndex((s) => s.key === step);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Nova vistoria" showBack onBack={handleCancel} />

      {/* Progress */}
      <div className="flex items-center gap-1 px-4 py-2 sm:py-3">
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

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-32 pt-2 space-y-4">
        {step === 'placa' && (
          <div className="space-y-4">
            <div className="card-glow rounded-xl bg-card p-4 sm:p-5 space-y-4">
              <div>
                <h2 className="text-lg font-bold">Placa</h2>
                <p className="text-sm text-muted-foreground">Foto ou digitação.</p>
              </div>
              <Button onClick={() => setShowCamera(true)} className="w-full min-h-12 h-12 gap-2 text-base font-semibold" disabled={ocrLoading}>
                <Camera className="h-5 w-5" />
                Tirar fotos da placa
              </Button>
              {ocrLoading && (
                <div className="flex items-center justify-center gap-2 py-3 text-primary">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="text-sm font-medium">Lendo placa…</span>
                </div>
              )}
              {import.meta.env.DEV && ocrConfidence !== null && !ocrLoading && (
                <div className={`flex items-center gap-2 rounded-lg p-3 ${
                  ocrConfidence >= 80
                    ? 'bg-accent/10 border border-accent/30'
                    : 'bg-destructive/10 border border-destructive/30'
                }`}>
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold">Confiança (dev)</span>
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
                  {ocrConfidence < 80 && (
                    <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                  )}
                </div>
              )}
              {ocrConfidence !== null && ocrConfidence < 80 && !ocrLoading && (
                <p className="text-xs text-amber-800 dark:text-amber-200 font-medium">
                  Confira a placa: se estiver errada, corrija no campo abaixo.
                </p>
              )}
              {oqWarning && (
                <div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/30 p-3">
                  <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
                  <p className="text-xs text-foreground">{oqWarning}</p>
                </div>
              )}
              {import.meta.env.DEV && (geoCorrections ?? []).length > 0 && (
                <div className="rounded-lg bg-primary/10 border border-primary/30 p-3 space-y-1">
                  <p className="text-xs font-bold text-primary">Correções (dev)</p>
                  {(geoCorrections ?? []).map((c, i) => (
                    <p key={i} className="text-xs text-muted-foreground font-mono">{c}</p>
                  ))}
                </div>
              )}
              {import.meta.env.DEV && debugImage && !ocrLoading && (
                <div className="space-y-2">
                  <p className="text-xs font-bold text-muted-foreground">Debug imagem</p>
                  <img
                    src={debugImage}
                    alt="Imagem binarizada processada pelo ALPR"
                    className="w-full rounded-lg border border-border"
                    style={{ imageRendering: 'pixelated' }}
                  />
                </div>
              )}
              {import.meta.env.DEV && (charDebugImages ?? []).length > 0 && !ocrLoading && (
                <div className="space-y-2">
                  <p className="text-xs font-bold text-muted-foreground">Caracteres (dev)</p>
                  <div className="flex gap-1 overflow-x-auto">
                    {(charDebugImages ?? []).map((img, i) => (
                      <div key={i} className="flex flex-col items-center gap-1 shrink-0">
                        <img
                          src={img}
                          alt={`Char ${i + 1}`}
                          className="w-12 h-auto rounded border border-border bg-white"
                          style={{ imageRendering: 'pixelated' }}
                        />
                        <span className="text-[10px] font-mono text-muted-foreground">{i + 1}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <label className="block text-sm font-semibold text-foreground/80 mb-1">Placa</label>
                <Input
                  value={placa}
                  onChange={(e) => { setPlaca(e.target.value.toUpperCase().slice(0, 7)); setOqWarning(null); }}
                  placeholder={ocrLoading ? '…' : 'Ex.: ABC1D23'}
                  maxLength={7}
                  autoCapitalize="characters"
                  enterKeyHint="next"
                  className="h-14 text-center text-xl font-black tracking-widest uppercase"
                />
              </div>
            </div>
          </div>
        )}

        {step === 'numero' && (
          <div className="space-y-4">
            <div className="card-glow rounded-xl bg-card p-4 sm:p-5 space-y-4">
              <div>
                <h2 className="text-lg font-bold">Número da vistoria</h2>
                <p className="text-sm text-muted-foreground">5 números do adesivo.</p>
              </div>
              <Button
                onClick={() => setShowCamera(true)}
                disabled={stickerLoading}
                variant="secondary"
                className="w-full min-h-12 h-12 text-base font-semibold gap-2"
              >
                {stickerLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Camera className="h-5 w-5" />
                )}
                Foto do adesivo
              </Button>
              {stickerLoading && (
                <p className="text-sm text-center text-muted-foreground">Lendo número…</p>
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
                  className="h-14 text-center text-2xl font-black tracking-widest tabular-nums"
                />
              </div>
            </div>
          </div>
        )}

        {step === 'fotos' && (
          <div className="space-y-4">
            <div className="card-glow rounded-xl bg-card p-4 sm:p-5 space-y-4">
              <div>
                <h2 className="text-lg font-bold">Fotos do veículo</h2>
                <p className="text-sm text-muted-foreground">Opcional: mais ângulos.</p>
              </div>
              <Button variant="secondary" onClick={() => setShowCamera(true)} className="w-full min-h-12 h-12 gap-2 text-base font-semibold">
                <ImagePlus className="h-5 w-5" />
                Adicionar foto ({fotos.length})
              </Button>
              {(fotoUrls ?? []).length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {(fotoUrls ?? []).map((url, i) => (
                    <img key={i} src={url} alt={`Foto ${i + 1}`} className="aspect-square rounded-lg object-cover border border-border" />
                  ))}
                </div>
              )}
            </div>

            <div className="card-glow rounded-xl bg-card p-4 space-y-1.5 text-sm">
              <h3 className="text-xs font-semibold text-muted-foreground">Resumo</h3>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Vistoriador</span>
                <span className="font-semibold">{user?.nome}</span>
              </div>
              <div className="flex justify-between text-sm gap-2">
                <span className="text-muted-foreground shrink-0">Criado por</span>
                <span className="font-semibold text-right truncate">
                  {currentUser?.nome?.trim() || user?.nome || "—"}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Placa</span>
                <span className="font-bold tracking-wider">{placa}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Nº Vistoria</span>
                <span className="font-bold tracking-wider">{numero}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Fotos</span>
                <span className="font-bold">{fotos.length}</span>
              </div>
            </div>

          </div>
        )}

        {step === 'saving' && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <Loader2 className="h-12 w-12 animate-spin text-primary" />
            <p className="text-base font-semibold text-foreground">Salvando…</p>
            <p className="text-sm text-muted-foreground text-center px-6">Não feche esta tela.</p>
          </div>
        )}
      </div>

      {step !== 'saving' && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-background/95 backdrop-blur-md px-4 pt-3 shadow-[0_-8px_30px_rgba(0,0,0,0.06)] dark:shadow-[0_-8px_30px_rgba(0,0,0,0.25)] pb-[max(1rem,env(safe-area-inset-bottom))]">
          {step === 'placa' && (
            <div className="mx-auto flex max-w-lg w-full gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={handleCancel} className="h-12 px-3 text-muted-foreground shrink-0">
                Sair
              </Button>
              <Button type="button" onClick={() => setStep('numero')} disabled={!placa} className="h-12 min-h-12 flex-1 text-base font-bold rounded-xl">
                Continuar
              </Button>
            </div>
          )}
          {step === 'numero' && (
            <div className="mx-auto flex max-w-lg w-full gap-2">
              <Button type="button" variant="ghost" onClick={() => setStep('placa')} className="h-12 min-h-12 px-3 shrink-0">
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <Button type="button" onClick={() => setStep('fotos')} disabled={!numero} className="h-12 min-h-12 flex-1 text-base font-bold rounded-xl">
                Continuar
              </Button>
            </div>
          )}
          {step === 'fotos' && (
            <div className="mx-auto flex max-w-lg w-full gap-2">
              <Button type="button" variant="ghost" onClick={() => setStep('numero')} className="h-12 min-h-12 px-3 shrink-0">
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <Button type="button" onClick={handleSave} className="h-14 min-h-14 flex-1 gap-2 text-lg font-bold rounded-xl">
                <Check className="h-6 w-6" />
                Salvar vistoria
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Cancel Confirmation Dialog */}
      <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sair sem salvar?</AlertDialogTitle>
            <AlertDialogDescription>
              O que você preencheu nesta tela será perdido. Para guardar, volte e toque em Salvar vistoria.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmCancel} className="bg-destructive text-destructive-foreground">
              Sair mesmo assim
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={stickerOcrDebugOpen} onOpenChange={setStickerOcrDebugOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Imagem para leitura (teste)</DialogTitle>
            <DialogDescription>Só aparece em modo desenvolvimento.</DialogDescription>
          </DialogHeader>
          {stickerOcrDebugUrl && (
            <img
              src={stickerOcrDebugUrl}
              alt="Imagem binarizada para OCR"
              className="w-full max-h-[50vh] object-contain rounded-md border border-border bg-white"
              style={{ imageRendering: 'pixelated' }}
            />
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setStickerOcrDebugOpen(false)}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
