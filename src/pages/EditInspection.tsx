import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Save, ImagePlus, Loader2, ArrowLeft, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AppHeader } from '@/components/AppHeader';
import { CameraCapture } from '@/components/CameraCapture';
import { getVistoriaById, updateVistoria, deleteVistoria } from '@/hooks/useVistorias';
import {
  addToQueue,
  removeVistoriaCreateFromQueue,
  removeVistoriaQueueItems,
  removeVistoriaUpdateFromQueue,
  normalizeVistoriaStatusSync,
} from '@/lib/db';
import { analyzeLocalDuplicateVistoria, duplicateUserMessage } from '@/services/inspectionService';
import { compressImage } from '@/lib/imageUtils';
import { toast } from '@/hooks/use-toast';
import type { Vistoria } from '@/lib/db';

export default function EditInspection() {
  const { id } = useParams();
  const navigate = useNavigate();
  const vistoriaId = Number(id);

  const [vistoria, setVistoria] = useState<Vistoria | null>(null);
  const [placa, setPlaca] = useState('');
  const [numero, setNumero] = useState('');
  const [vistoriador, setVistoriadorField] = useState('');
  const [fotos, setFotos] = useState<Blob[]>([]);
  const [fotoUrls, setFotoUrls] = useState<string[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getVistoriaById(vistoriaId).then((v) => {
      if (!v) { navigate(-1); return; }
      setVistoria(v);
      setPlaca(v.placa);
      setNumero(v.numeroVistoria);
      setVistoriadorField(v.vistoriador || '');
      setFotos(v.fotos || []);
      setFotoUrls(v.fotos?.map((b) => URL.createObjectURL(b)) || []);
      setLoading(false);
    });
  }, [vistoriaId]);

  const handleFotoCapture = async (blob: Blob) => {
    setShowCamera(false);
    const compressed = await compressImage(blob);
    const url = URL.createObjectURL(compressed);
    setFotos((prev) => [...prev, compressed]);
    setFotoUrls((prev) => [...prev, url]);
  };

  const removeFoto = (index: number) => {
    setFotos((prev) => prev.filter((_, i) => i !== index));
    setFotoUrls((prev) => prev.filter((_, i) => i !== index));
  };

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
    const dupLocal = await analyzeLocalDuplicateVistoria(
      vistoria.leilaoId,
      placa.toUpperCase(),
      numero,
      vistoriaId,
    );
    setSaving(true);
    try {
      const norm = normalizeVistoriaStatusSync(vistoria.statusSync);

      if (dupLocal.duplicate) {
        await updateVistoria(vistoriaId, {
          placa: placa.toUpperCase(),
          numeroVistoria: numero,
          vistoriador,
          fotos,
          updatedAt: Date.now(),
          statusSync: 'aguardando_ajuste',
          syncMessage: duplicateUserMessage(dupLocal.type),
          duplicateType: dupLocal.type,
          duplicateInfo: dupLocal.info,
        });
        await removeVistoriaUpdateFromQueue(vistoriaId);
        await removeVistoriaCreateFromQueue(vistoriaId);
        toast({
          title: 'Salva no aparelho',
          description: duplicateUserMessage(dupLocal.type),
        });
        navigate(-1);
        return;
      }

      const clearingConflictOrError =
        norm === 'conflito_duplicidade' || norm === 'aguardando_ajuste' || norm === 'erro_sync';

      await updateVistoria(vistoriaId, {
        placa: placa.toUpperCase(),
        numeroVistoria: numero,
        vistoriador,
        fotos,
        updatedAt: Date.now(),
        ...(clearingConflictOrError
          ? {
              statusSync: 'pendente_sync',
              syncMessage: undefined,
              duplicateType: undefined,
              duplicateInfo: undefined,
            }
          : {}),
      });

      await removeVistoriaUpdateFromQueue(vistoriaId);
      await removeVistoriaCreateFromQueue(vistoriaId);

      const fresh = await getVistoriaById(vistoriaId);
      const fn = normalizeVistoriaStatusSync(fresh?.statusSync);
      if (fn !== 'rascunho') {
        const hasCloud = Boolean(fresh?.cloudVistoriaId);
        if (hasCloud) {
          await addToQueue({
            type: 'update',
            entity: 'vistoria',
            payload: { localVistoriaId: vistoriaId },
          });
        } else {
          await addToQueue({
            type: 'create',
            entity: 'vistoria',
            payload: { localVistoriaId: vistoriaId },
          });
        }
        const { processQueue } = await import('@/services/syncService');
        await processQueue();
      }

      toast({ title: 'Alterações salvas', description: 'Envio em segundo plano quando houver internet.' });
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
        await removeVistoriaQueueItems(vistoriaId);
        await deleteVistoria(vistoriaId);
        toast({
          title: 'Vistoria removida',
          description: 'O registro foi apagado deste aparelho.',
        });
        navigate(-1);
        return;
      }

      await removeVistoriaQueueItems(vistoriaId);
      await updateVistoria(vistoriaId, { pendingCloudDelete: true });
      await addToQueue({
        type: 'delete',
        entity: 'vistoria',
        payload: { localVistoriaId: vistoriaId },
      });
      const { processQueue } = await import('@/services/syncService');
      await processQueue();
      const stillThere = await getVistoriaById(vistoriaId);
      if (stillThere) {
        toast({
          title: 'Vistoria marcada para exclusão',
          description: 'Será removida na nuvem ao sincronizar; já não aparece na lista.',
        });
      } else {
        toast({
          title: 'Vistoria removida',
          description: 'Registro apagado neste aparelho e na nuvem.',
        });
      }
      navigate(-1);
    } catch {
      toast({
        title: 'Não removeu',
        description: 'Tente de novo em alguns segundos.',
        variant: 'destructive',
      });
    }
  };

  if (showCamera) {
    return <CameraCapture title="Nova foto" overlayType="none" onCapture={handleFotoCapture} onCancel={() => setShowCamera(false)} />;
  }

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
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>
            Voltar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Editar vistoria" showBack />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-28 space-y-4">
        <div className="card-glow rounded-xl bg-card p-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1">Placa</label>
            <Input
              value={placa}
              onChange={(e) => setPlaca(e.target.value.toUpperCase().slice(0, 7))}
              maxLength={7}
              enterKeyHint="next"
              className="h-12 text-center text-lg font-black tracking-widest uppercase"
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
              enterKeyHint="done"
              className="h-12 text-center text-lg font-black tracking-widest tabular-nums"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1">Vistoriador</label>
            <Input value={vistoriador} onChange={(e) => setVistoriadorField(e.target.value)} className="h-12" />
          </div>
        </div>

        <div className="card-glow rounded-xl bg-card p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold">Fotos ({(fotos ?? []).length})</h3>
            <Button variant="outline" size="sm" onClick={() => setShowCamera(true)} className="gap-1.5 h-9 text-xs shrink-0">
              <ImagePlus className="h-4 w-4" />
              Adicionar
            </Button>
          </div>
          {(fotoUrls ?? []).length > 0 ? (
            <div className="grid grid-cols-3 gap-2">
              {(fotoUrls ?? []).map((url, i) => (
                <div key={i} className="relative">
                  <img src={url} alt={`Foto ${i + 1}`} className="aspect-square rounded-lg object-cover border border-border" />
                  <button
                    onClick={() => removeFoto(i)}
                    className="absolute -top-1.5 -right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">Sem fotos</p>
          )}
        </div>

        <button
          type="button"
          onClick={handleDelete}
          className="w-full py-2 text-sm text-destructive/90 underline-offset-4 hover:underline"
        >
          Apagar vistoria
        </button>
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-background/95 backdrop-blur-md px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Button onClick={handleSave} disabled={saving} className="mx-auto flex h-14 min-h-14 w-full max-w-lg text-base font-bold gap-2 rounded-xl">
          {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
          Salvar
        </Button>
      </div>
    </div>
  );
}
