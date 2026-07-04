import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Save,
  ImagePlus,
  Loader2,
  ArrowLeft,
  X,
  AlertTriangle,
  ShieldCheck,
  Settings,
  Camera,
  Eye,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AppHeader } from '@/components/AppHeader';
import { CameraCapture } from '@/components/CameraCapture';
import { getVistoriaById, updateVistoria, deleteVistoria } from '@/hooks/useVistorias';
import { addToQueue, removeVistoriaQueueItems, normalizeVistoriaStatusSync } from '@/lib/db';
import { duplicateUserMessage } from '@/services/inspectionService';
import { recalculateDuplicateVistoriasForLeilao } from '@/services/duplicateVistoriaRecalc';
import { compressImage } from '@/lib/imageUtils';
import { toast } from '@/hooks/use-toast';
import type { Vistoria } from '@/lib/db';

type CameraMode = 'chassi' | 'motor' | 'geral' | null;

export default function EditInspection() {
  const { id } = useParams();
  const navigate = useNavigate();
  const vistoriaId = Number(id);

  const [vistoria, setVistoria] = useState<Vistoria | null>(null);

  // Estados da UI
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>(null);
  const [viewerImage, setViewerImage] = useState<string | null>(null);
  const [isGalleryManagerOpen, setIsGalleryManagerOpen] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);

  // Dados Cadastrais
  const [placa, setPlaca] = useState('');
  const [numero, setNumero] = useState('');
  const [vistoriador, setVistoriadorField] = useState('');

  // Fotos Extraídas pela IA (Intocáveis manualmente na edição)
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

  // Prevenção de Memory Leak
  const urlTracker = useRef<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      urlTracker.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const createTrackedUrl = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urlTracker.current.add(url);
    return url;
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // PARSER DE FOTOS: Lê os rótulos do IndexedDB e distribui nos cards
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    getVistoriaById(vistoriaId).then((v) => {
      if (!v) {
        navigate(-1);
        return;
      }

      setVistoria(v);
      setPlaca(v.placa || '');
      setNumero(v.numeroVistoria || '');
      setVistoriadorField(v.vistoriador || '');

      const gerais: File[] = [];
      const geraisUrls: string[] = [];

      let foundChassi = false;
      let foundMotor = false;

      (v.fotos || []).forEach((blob) => {
        const file = blob as File;
        const fileName = file.name || '';

        if (fileName.startsWith('PLACA_')) {
          setFotoPlaca(blob);
        } else if (fileName.startsWith('ADESIVO_')) {
          setFotoAdesivo(blob);
        } else if (fileName.startsWith('CHASSI_')) {
          setFotoChassi(file);
          setChassiUrl(createTrackedUrl(blob));
          foundChassi = true;
        } else if (fileName.startsWith('MOTOR_')) {
          setFotoMotor(file);
          setMotorUrl(createTrackedUrl(blob));
          foundMotor = true;
        } else {
          // Arquivos sem rótulo caem na Galeria Geral
          const genFile = new File([blob], fileName || `FOTO_ANTIGA_${Date.now()}.jpg`, { type: blob.type });
          gerais.push(genFile);
          geraisUrls.push(createTrackedUrl(blob));
        }
      });

      setFotosGerais(gerais);
      setFotosGeraisUrls(geraisUrls);
      setHasChassi(foundChassi);
      setHasMotor(foundMotor);
      setLoading(false);
    });
  }, [vistoriaId, createTrackedUrl, navigate]);

  // ════════════════════════════════════════════════════════════════════════
  // CAPTURA E GERENCIAMENTO
  // ════════════════════════════════════════════════════════════════════════
  const handleCapture = async (blob: Blob) => {
    const mode = cameraMode;
    setCameraMode(null);

    const compressed = await compressImage(blob);
    const url = createTrackedUrl(compressed);
    const ts = Date.now();

    if (mode === 'chassi') {
      const file = new File([compressed], `CHASSI_${placa || 'SEM'}_${ts}.jpg`, { type: 'image/jpeg' });
      setFotoChassi(file);
      setChassiUrl(url);
    } else if (mode === 'motor') {
      const file = new File([compressed], `MOTOR_${placa || 'SEM'}_${ts}.jpg`, { type: 'image/jpeg' });
      setFotoMotor(file);
      setMotorUrl(url);
    } else if (mode === 'geral') {
      const file = new File([compressed], `FOTO_${placa || 'GERAL'}_${ts}.jpg`, { type: 'image/jpeg' });
      setFotosGerais((prev) => [...prev, file]);
      setFotosGeraisUrls((prev) => [...prev, url]);
    }
  };

  const removePhotoGeral = (index: number) => {
    const urlToRemove = fotosGeraisUrls[index];
    URL.revokeObjectURL(urlToRemove);
    urlTracker.current.delete(urlToRemove);

    setFotosGerais((prev) => prev.filter((_, i) => i !== index));
    setFotosGeraisUrls((prev) => prev.filter((_, i) => i !== index));
  };

  // ════════════════════════════════════════════════════════════════════════
  // SALVAMENTO E EXCLUSÃO
  // ════════════════════════════════════════════════════════════════════════
  const handleSave = async () => {
    if (!placa || !numero) {
      toast({
        title: 'Falta placa ou número',
        description: 'Preencha os dois para salvar.',
        variant: 'destructive',
      });
      return;
    }
    
    if (!vistoria) return;
    setSaving(true);
    
    try {
      const norm = normalizeVistoriaStatusSync(vistoria.statusSync);
      const clearingConflictOrError = norm === 'conflito_duplicidade' || norm === 'aguardando_ajuste' || norm === 'erro_sync';

      // Empacota a coleção respeitando a arquitetura
      const allFotos: Blob[] = [...fotosGerais];
      
      // Converte as fotos originais da IA em File caso ainda não sejam
      if (fotoPlaca) {
        allFotos.unshift(new File([fotoPlaca], `PLACA_${placa || 'SEM_PLACA'}.jpg`, { type: 'image/jpeg' }));
      }
      if (fotoAdesivo) {
        allFotos.unshift(new File([fotoAdesivo], `ADESIVO_${placa || 'SEM_PLACA'}.jpg`, { type: 'image/jpeg' }));
      }
      
      if (hasChassi && fotoChassi) allFotos.push(fotoChassi);
      if (hasMotor && fotoMotor) allFotos.push(fotoMotor);

      await updateVistoria(vistoriaId, {
        placa: placa.toUpperCase(),
        numeroVistoria: numero,
        vistoriador,
        fotos: allFotos,
        updatedAt: Date.now(),
        ...(clearingConflictOrError
          ? {
              statusSync: 'pendente_sync',
              syncMessage: undefined,
              duplicateType: undefined,
              duplicateInfo: undefined,
              duplicateConflictWith: undefined,
              duplicateConflictWithList: undefined,
            }
          : {}),
      });

      await recalculateDuplicateVistoriasForLeilao(vistoria.leilaoId);

      const afterRecalc = await getVistoriaById(vistoriaId);
      const fn = normalizeVistoriaStatusSync(afterRecalc?.statusSync);

      if (fn === 'aguardando_ajuste' || fn === 'conflito_duplicidade') {
        await removeVistoriaQueueItems(vistoriaId);
        toast({
          title: 'Duplicado. Ajuste antes de sincronizar',
          description: afterRecalc?.syncMessage ?? (afterRecalc?.duplicateType ? duplicateUserMessage(afterRecalc.duplicateType) : 'Corrija placa ou número e envie de novo.'),
          variant: 'destructive',
        });
        navigate(-1);
        return;
      }

      await removeVistoriaQueueItems(vistoriaId);

      const peerIds = new Set<number>();
      if (vistoria.duplicateConflictWith?.localVistoriaId != null) {
        peerIds.add(vistoria.duplicateConflictWith.localVistoriaId);
      }
      for (const p of vistoria.duplicateConflictWithList ?? []) {
        if (p.localVistoriaId != null) peerIds.add(p.localVistoriaId);
      }
      for (const pid of peerIds) {
        if (pid !== vistoriaId) await removeVistoriaQueueItems(pid);
      }

      const fresh = await getVistoriaById(vistoriaId);
      const fn2 = normalizeVistoriaStatusSync(fresh?.statusSync);
      
      if (fn2 !== 'rascunho') {
        const hasCloudAfter = Boolean(fresh?.cloudVistoriaId?.trim());
        await addToQueue({
          type: hasCloudAfter ? 'update' : 'create',
          entity: 'vistoria',
          payload: { localVistoriaId: vistoriaId },
        });
        const { processQueue } = await import('@/services/syncService');
        await processQueue();
        await recalculateDuplicateVistoriasForLeilao(vistoria.leilaoId);
      }

      const after = await getVistoriaById(vistoriaId);
      const st = normalizeVistoriaStatusSync(after?.statusSync);
      
      if (st === 'sincronizado') {
        toast({ title: 'Vistoria atualizada', description: 'Alterações já estão no servidor.' });
      } else if (st === 'pendente_sync') {
        toast({ title: 'Alterações salvas no aparelho', description: 'Pendente de envio quando houver internet.' });
      } else if (st === 'erro_sync') {
        toast({ title: 'Erro ao enviar', description: after?.syncMessage ?? 'Sem internet ou falha no envio. Tente de novo.', variant: 'destructive' });
      } else {
        toast({ title: 'Alterações salvas', description: 'Envio em segundo plano quando houver internet.' });
      }
      
      navigate(-1);
    } catch {
      toast({
        title: 'Não salvou',
        description: 'Tente de novo. Verifique se há espaço e internet.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Apagar esta vistoria deste aparelho? Não dá para desfazer.')) return;
    try {
      const v = await getVistoriaById(vistoriaId);
      if (!v) {
        toast({ title: 'Registro não encontrado', variant: 'destructive' });
        navigate(-1);
        return;
      }
      const cloudId = v.cloudVistoriaId?.trim();
      const syncedToCloud = Boolean(cloudId);

      if (!syncedToCloud) {
        const lid = v.leilaoId;
        await removeVistoriaQueueItems(vistoriaId);
        await deleteVistoria(vistoriaId);
        await recalculateDuplicateVistoriasForLeilao(lid);
        toast({ title: 'Vistoria removida', description: 'O registro foi apagado deste aparelho.' });
        navigate(-1);
        return;
      }

      await removeVistoriaQueueItems(vistoriaId);
      await updateVistoria(vistoriaId, { pendingCloudDelete: true });
      await recalculateDuplicateVistoriasForLeilao(v.leilaoId);
      await addToQueue({ type: 'delete', entity: 'vistoria', payload: { localVistoriaId: vistoriaId } });
      
      const { processQueue } = await import('@/services/syncService');
      await processQueue();
      await recalculateDuplicateVistoriasForLeilao(v.leilaoId);
      
      const stillThere = await getVistoriaById(vistoriaId);
      if (stillThere) {
        toast({ title: 'Vistoria marcada para exclusão', description: 'Será removida na nuvem ao sincronizar.' });
      } else {
        toast({ title: 'Vistoria removida', description: 'Registro apagado neste aparelho e na nuvem.' });
      }
      navigate(-1);
    } catch {
      toast({ title: 'Não removeu', description: 'Tente de novo em alguns segundos.', variant: 'destructive' });
    }
  };

  // ════════════════════════════════════════════════════════════════════════
  // RENDERIZAÇÃO
  // ════════════════════════════════════════════════════════════════════════

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AppHeader title="Editar" showBack />
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Carregando…</p>
        </div>
      </div>
    );
  }

  if (vistoria?.pendingCloudDelete) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AppHeader title="Editar vistoria" showBack />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Esta vistoria está marcada para exclusão e será removida na nuvem ao sincronizar.
          </p>
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>Voltar</Button>
        </div>
      </div>
    );
  }

  if (cameraMode) {
    let title = "Capturar Foto";
    if (cameraMode === 'chassi') title = "Foto do Chassi";
    if (cameraMode === 'motor') title = "Foto do Motor";
    if (cameraMode === 'geral') title = "Foto Geral";
    return <CameraCapture title={title} overlayType="none" onCapture={handleCapture} onCancel={() => setCameraMode(null)} />;
  }

  // Visualizador Tela Cheia (Lightbox)
  if (viewerImage) {
    return (
      <div className="fixed inset-0 z-[100] flex flex-col bg-black">
        <div className="flex justify-end p-4">
          <Button variant="secondary" size="icon" onClick={() => setViewerImage(null)} className="rounded-full shadow-lg">
            <X className="h-6 w-6" />
          </Button>
        </div>
        <div className="flex-1 overflow-auto flex items-center justify-center p-2">
          <img src={viewerImage} alt="Visualização" className="max-w-full max-h-full object-contain" />
        </div>
      </div>
    );
  }

  // Gerenciador de Galeria com Lixeira
  if (isGalleryManagerOpen) {
    return (
      <div className="fixed inset-0 z-[90] flex flex-col bg-background">
        <AppHeader title="Gerenciar Fotos Extras" showBack onBack={() => setIsGalleryManagerOpen(false)} />
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
                  <img src={url} className="w-full h-full object-cover cursor-pointer" onClick={() => setViewerImage(url)} alt={`Galeria ${i}`}/>
                  <button onClick={() => removePhotoGeral(i)} className="absolute top-2 right-2 p-2 bg-destructive/90 hover:bg-destructive text-white rounded-full shadow-lg active:scale-95 transition-all">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="p-4 border-t border-border/50 bg-card">
          <Button onClick={() => setIsGalleryManagerOpen(false)} className="w-full h-14 font-bold text-lg rounded-xl shadow-md">Concluir</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Editar vistoria" showBack />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-28 space-y-4">
        
        {/* BLOCO DE DADOS CADASTRAIS */}
        <div className="card-glow rounded-xl bg-card p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1">Placa</label>
            <Input
              value={placa}
              onChange={(e) => setPlaca(e.target.value.toUpperCase().slice(0, 7))}
              maxLength={7}
              enterKeyHint="next"
              className="h-14 text-center text-xl font-black tracking-widest uppercase bg-background shadow-inner"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1">Número (5 dígitos)</label>
            <Input
              value={numero}
              onChange={(e) => setNumero(e.target.value.replace(/\D/g, '').slice(0, 5))}
              maxLength={5}
              inputMode="numeric"
              pattern="[0-9]*"
              enterKeyHint="next"
              className="h-14 text-center text-2xl font-black tracking-widest tabular-nums bg-background shadow-inner"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1">Vistoriador</label>
            <Input 
              value={vistoriador} 
              onChange={(e) => setVistoriadorField(e.target.value)} 
              className="h-14 font-medium bg-background shadow-inner" 
            />
          </div>
        </div>

        {/* ALERTA DE DUPLICIDADE */}
        {(() => {
          const list = vistoria?.duplicateConflictWithList && vistoria.duplicateConflictWithList.length > 0
              ? vistoria.duplicateConflictWithList
              : vistoria?.duplicateConflictWith
                ? [vistoria.duplicateConflictWith]
                : [];
          if (list.length === 0) return null;
          return (
            <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-4 shadow-sm">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden />
                <div className="min-w-0 flex-1 space-y-3">
                  <p className="text-sm font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                    {list.length > 1 ? `Conflito com ${list.length} vistorias` : 'Conflito de Duplicidade'}
                  </p>
                  <ul className="space-y-2">
                    {list.map((peer) => (
                      <li key={peer.localVistoriaId} className="rounded-lg border border-amber-500/30 bg-background/50 px-3 py-2 shadow-inner">
                        <p className="text-sm font-medium text-foreground">
                          Placa <span className="font-black">{peer.placa}</span> · Nº <span className="font-mono font-bold">{peer.numeroVistoria}</span>
                        </p>
                        {peer.createdBy && (
                          <p className="text-[11px] text-muted-foreground mt-1">
                            Feito por: {peer.createdBy}
                          </p>
                        )}
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="mt-3 h-9 w-full font-bold shadow-sm"
                          onClick={() => navigate(`/editar/${peer.localVistoriaId}`)}
                        >
                          Abrir vistoria conflitante
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          );
        })()}

        {/* FOTOS TÉCNICAS E GERAIS */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
             <div className="h-0.5 flex-1 bg-border/50"></div>
             <p className="text-xs font-black text-muted-foreground uppercase tracking-widest">Identificação e Fotos</p>
             <div className="h-0.5 flex-1 bg-border/50"></div>
          </div>

          {/* CARD CHASSI */}
          <div className="card-glow rounded-xl bg-card p-5 space-y-4 border border-border/50">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-base font-bold flex items-center gap-2">
                  <ShieldCheck className="text-primary h-5 w-5" /> 
                  Foto do Chassi
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">Captura nítida da numeração.</p>
              </div>
              <div className="flex bg-secondary rounded-lg p-1 shrink-0 ml-2">
                <button type="button" onClick={() => setHasChassi(true)} className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${hasChassi ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground'}`}>SIM</button>
                <button type="button" onClick={() => {setHasChassi(false); setFotoChassi(null); setChassiUrl(null);}} className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${!hasChassi ? 'bg-destructive text-destructive-foreground shadow' : 'text-muted-foreground'}`}>NÃO</button>
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
              <p className="text-xs text-muted-foreground/80 italic flex items-center gap-1.5 bg-destructive/5 p-2 rounded-md border border-destructive/10">
                <XCircle className="h-3.5 w-3.5 text-destructive" /> Chassi inacessível ou inexistente.
              </p>
            )}
          </div>

          {/* CARD MOTOR */}
          <div className="card-glow rounded-xl bg-card p-5 space-y-4 border border-border/50">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-base font-bold flex items-center gap-2">
                  <Settings className="text-primary h-5 w-5" /> 
                  Foto do Motor
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">Captura do número do bloco.</p>
              </div>
              <div className="flex bg-secondary rounded-lg p-1 shrink-0 ml-2">
                <button type="button" onClick={() => setHasMotor(true)} className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${hasMotor ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground'}`}>SIM</button>
                <button type="button" onClick={() => {setHasMotor(false); setFotoMotor(null); setMotorUrl(null);}} className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${!hasMotor ? 'bg-destructive text-destructive-foreground shadow' : 'text-muted-foreground'}`}>NÃO</button>
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
              <p className="text-xs text-muted-foreground/80 italic flex items-center gap-1.5 bg-destructive/5 p-2 rounded-md border border-destructive/10">
                <XCircle className="h-3.5 w-3.5 text-destructive" /> Motor inacessível ou sem numeração.
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
                 <p className="text-xs text-muted-foreground mt-0.5">Laterais, avarias, etc.</p>
               </div>
               {fotosGeraisUrls.length > 0 && (
                 <Button type="button" variant="ghost" onClick={() => setIsGalleryManagerOpen(true)} className="text-primary text-xs font-bold gap-1 px-2 h-8 underline">
                   <Trash2 className="h-3 w-3" /> Gerenciar
                 </Button>
               )}
            </div>
            
            <Button type="button" onClick={() => setCameraMode('geral')} variant="secondary" className="w-full h-12 gap-2 font-bold shadow-sm">
              <ImagePlus className="h-5 w-5" /> Adicionar foto extra
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
        </div>

        <button
          type="button"
          onClick={handleDelete}
          className="w-full py-3 mt-4 mb-2 text-sm font-bold text-destructive/80 hover:text-destructive underline-offset-4 hover:underline transition-colors"
        >
          Apagar vistoria (Irreversível)
        </button>
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-background/95 backdrop-blur-md px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Button onClick={handleSave} disabled={saving} className="mx-auto flex h-14 min-h-14 w-full max-w-lg text-lg font-bold gap-2 rounded-xl shadow-lg">
          {saving ? <Loader2 className="h-6 w-6 animate-spin" /> : <Save className="h-6 w-6" />}
          Salvar Edição
        </Button>
      </div>
    </div>
  );
}