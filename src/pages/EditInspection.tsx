import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Save, Trash2, ImagePlus, Loader2, ArrowLeft, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AppHeader } from '@/components/AppHeader';
import { CameraCapture } from '@/components/CameraCapture';
import { getVistoriaById, updateVistoria, deleteVistoria } from '@/hooks/useVistorias';
import {
  addToQueue,
  removeVistoriaCreateFromQueue,
  removeVistoriaUpdateFromQueue,
  normalizeVistoriaStatusSync,
} from '@/lib/db';
import { findLocalDuplicateVistoria } from '@/services/inspectionService';
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
      toast({ title: 'Campos obrigatórios', variant: 'destructive' });
      return;
    }
    if (!vistoria) return;
    const dupLocal = await findLocalDuplicateVistoria(
      vistoria.leilaoId,
      placa.toUpperCase(),
      numero,
      vistoriaId,
    );
    if (dupLocal) {
      toast({
        title: 'Duplicidade',
        description: 'Outra vistoria neste leilão já usa esta placa ou este número.',
        variant: 'destructive',
      });
      return;
    }
    setSaving(true);
    try {
      const norm = normalizeVistoriaStatusSync(vistoria.statusSync);
      const clearingConflictOrError = norm === 'conflito_duplicidade' || norm === 'erro_sync';

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

      toast({ title: 'Vistoria atualizada!' });
      navigate(-1);
    } catch {
      toast({ title: 'Erro ao salvar', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Excluir esta vistoria permanentemente?')) return;
    try {
      await deleteVistoria(vistoriaId);
      toast({ title: 'Vistoria excluída' });
      navigate(-1);
    } catch {
      toast({ title: 'Erro ao excluir', variant: 'destructive' });
    }
  };

  if (showCamera) {
    return <CameraCapture title="📷 Adicionar Foto" overlayType="none" onCapture={handleFotoCapture} onCancel={() => setShowCamera(false)} />;
  }

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AppHeader title="Editar" showBack />
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Editar Vistoria" showBack />

      <div className="flex-1 p-4 space-y-4">
        <div className="card-glow rounded-xl bg-card p-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1">Vistoriador</label>
            <Input value={vistoriador} onChange={(e) => setVistoriadorField(e.target.value)} className="h-11" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1">Placa</label>
            <Input
              value={placa}
              onChange={(e) => setPlaca(e.target.value.toUpperCase().slice(0, 7))}
              maxLength={7}
              className="h-11 text-center text-lg font-black tracking-widest uppercase"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1">Nº Vistoria</label>
            <Input
              value={numero}
              onChange={(e) => setNumero(e.target.value.replace(/\D/g, '').slice(0, 5))}
              maxLength={5}
              inputMode="numeric"
              className="h-11 text-center text-lg font-black tracking-widest"
            />
          </div>
        </div>

        <div className="card-glow rounded-xl bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold">Fotos ({(fotos ?? []).length})</h3>
            <Button variant="secondary" size="sm" onClick={() => setShowCamera(true)} className="gap-1.5">
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
            <p className="text-sm text-muted-foreground text-center py-4">Nenhuma foto</p>
          )}
        </div>

        <div className="space-y-2 pt-2">
          <Button onClick={handleSave} disabled={saving} className="w-full h-13 text-base font-bold gap-2">
            {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
            Salvar Alterações
          </Button>
          <Button variant="destructive" onClick={handleDelete} className="w-full h-12 text-base font-semibold gap-2">
            <Trash2 className="h-5 w-5" />
            Excluir Vistoria
          </Button>
        </div>
      </div>
    </div>
  );
}
