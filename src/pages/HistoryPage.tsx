import { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Search, Calendar, Loader2, ChevronRight, RefreshCw, CloudDownload } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { AppHeader } from '@/components/AppHeader';
import { SyncBadge } from '@/components/SyncBadge';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useAutoSyncLeilaoOnEnter } from '@/hooks/useAutoSyncLeilaoOnEnter';
import { useVistorias } from '@/hooks/useVistorias';
import { useRequireValidLeilao } from '@/hooks/useLeilaoRoute';
import { isVistoriaSyncBlockedByDuplicate, normalizeVistoriaStatusSync, type Vistoria } from '@/lib/db';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { enqueueVistoriaResync, syncLeilaoFromCloud, type EnqueueVistoriaResyncResult } from '@/services/syncService';

export default function HistoryPage() {
  const { leilaoId: id, ready } = useRequireValidLeilao();
  const navigate = useNavigate();
  const location = useLocation();
  const focusVistoriaId = (location.state as { focusVistoriaId?: number } | null)?.focusVistoriaId;
  const { vistorias, loading, refresh } = useVistorias(ready ? id : null);

  const online = useOnlineStatus();

  const [search, setSearch] = useState('');
  const [todayOnly, setTodayOnly] = useState(false);
  const [resyncingId, setResyncingId] = useState<number | null>(null);
  const [pullingFromCloud, setPullingFromCloud] = useState(false);

  const refreshSilent = useCallback(() => refresh({ silent: true }), [refresh]);
  useAutoSyncLeilaoOnEnter(ready ? id : null, ready, refreshSilent);

  const filtered = useMemo(() => {
    const list = vistorias ?? [];
    let result = list;
    if (todayOnly) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      result = result.filter((v) => v.createdAt && new Date(v.createdAt) >= today);
    }
    if (search) {
      const q = search.toUpperCase();
      result = result.filter((v) =>
        (v.placa && v.placa.includes(q)) ||
        (v.numeroVistoria && v.numeroVistoria.includes(q))
      );
    }
    return result;
  }, [vistorias, search, todayOnly]);

  useEffect(() => {
    if (focusVistoriaId == null) return;
    const t = window.setTimeout(() => {
      document.getElementById(`vistoria-${focusVistoriaId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 300);
    return () => window.clearTimeout(t);
  }, [focusVistoriaId, filtered]);

  const handleResync = async (e: React.MouseEvent, v: Vistoria) => {
    e.stopPropagation();
    if (v.id == null) return;
    setResyncingId(v.id);
    try {
      const r = await enqueueVistoriaResync(v.id);
      if (r.ok) {
        toast({ title: 'Sincronização iniciada', description: 'Tentando enviar novamente.' });
      } else {
        const err = r as Extract<EnqueueVistoriaResyncResult, { ok: false }>;
        if ('blocked' in err && err.blocked) {
          toast({ title: 'Não é possível sincronizar agora', description: err.message, variant: 'destructive' });
        } else {
          toast({ title: 'Não foi possível', description: err.message, variant: 'destructive' });
        }
      }
    } finally {
      setResyncingId(null);
    }
  };

  const handlePullFromCloud = async () => {
    if (!online) {
      toast({
        title: 'Sem conexão',
        description: 'Conecte-se à internet para sincronizar com o servidor.',
        variant: 'destructive',
      });
      return;
    }
    setPullingFromCloud(true);
    try {
      const merged = await syncLeilaoFromCloud(id);
      if (!merged.ok) {
        toast({
          title: 'Não sincronizou',
          description: merged.message ?? 'Não foi possível buscar os dados do servidor.',
          variant: 'destructive',
        });
        return;
      }
      await refresh({ silent: true });
      const removedHint =
        merged.removedLocal > 0
          ? ` ${merged.removedLocal} registro(s) removido(s) deste aparelho.`
          : '';
      toast({
        title: 'Sincronizado com o servidor',
        description: `${merged.rowCount} vistoria(s) no servidor.${removedHint}`,
      });
    } catch {
      toast({
        title: 'Erro de sincronização',
        description: 'Não foi possível atualizar o histórico.',
        variant: 'destructive',
      });
    } finally {
      setPullingFromCloud(false);
    }
  };

  if (!ready) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AppHeader title="Histórico" showBack onBack={() => navigate(`/dashboard/${id}`)} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground font-medium">Carregando…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Histórico" showBack onBack={() => navigate(`/dashboard/${id}`)} />

      <div className="space-y-4 px-4 pt-4 pb-2">
        <p className="text-xs font-medium leading-snug text-muted-foreground/80">
          Sincroniza ao abrir. Use o botão para forçar o envio e a atualização com o servidor.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por placa ou número"
              className="h-12 pl-10 text-base font-medium shadow-sm bg-card"
              enterKeyHint="search"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 border-b border-border/50 pb-3">
          <Button
            type="button"
            variant={todayOnly ? 'default' : 'secondary'}
            size="sm"
            onClick={() => setTodayOnly(!todayOnly)}
            className={cn('h-9 gap-1.5 px-3 text-xs font-bold rounded-lg transition-colors', todayOnly && 'shadow-md')}
          >
            <Calendar className="h-3.5 w-3.5" />
            {todayOnly ? 'Só hoje' : 'Todas as datas'}
          </Button>
          <span className="text-xs font-semibold text-muted-foreground bg-muted/40 px-2 py-1 rounded-md">
            {filtered.length} {filtered.length === 1 ? 'item' : 'itens'}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handlePullFromCloud}
            disabled={!online || pullingFromCloud}
            title={online ? 'Enviar pendências e baixar do servidor' : 'Disponível apenas online'}
            className="ml-auto h-9 gap-1.5 px-3 text-xs font-bold"
          >
            {pullingFromCloud ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CloudDownload className="h-3.5 w-3.5" />
            )}
            Sincronizar
          </Button>
        </div>
      </div>

      <div className="flex-1 px-4 pb-6 pt-2">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm font-medium text-muted-foreground">Lendo banco de dados local…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/80 bg-card px-6 py-16 text-center shadow-sm">
            <p className="text-lg font-black text-foreground">O histórico local está vazio</p>
            <p className="mt-2 text-sm font-medium text-muted-foreground">
              Troque o filtro, faça uma nova vistoria, ou puxe os dados do servidor.
            </p>
            <Button
              className="mt-6 font-bold shadow-md"
              onClick={handlePullFromCloud}
              disabled={pullingFromCloud || !online}
            >
              {pullingFromCloud ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CloudDownload className="mr-2 h-4 w-4" />}
              Sincronizar com o servidor
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {(filtered ?? []).map((v) => {
              const rowSt = normalizeVistoriaStatusSync(v.statusSync);
              const showResync = rowSt === 'erro_sync' || rowSt === 'pendente_sync';
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    id={v.id != null ? `vistoria-${v.id}` : undefined}
                    onClick={() => navigate(`/editar/${v.id}`)}
                    className={cn(
                      'flex w-full min-h-[72px] items-center gap-3 rounded-2xl border px-4 py-4 text-left transition-all active:scale-[0.98]',
                      'shadow-sm hover:shadow-md hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                      isVistoriaSyncBlockedByDuplicate(v.statusSync)
                        ? 'border-orange-500/40 bg-orange-500/5'
                        : 'border-border/80 bg-card',
                    )}
                  >
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
                        <span className="text-xl font-black tracking-widest text-foreground uppercase">{v.placa}</span>
                        <span className="text-sm font-bold text-muted-foreground/70">#{v.numeroVistoria}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                        <span className="bg-muted/40 px-1.5 py-0.5 rounded text-foreground/80">
                          {new Date(v.createdAt).toLocaleString('pt-BR', {
                            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                          })}
                        </span>
                        {v.vistoriador ? <span>· {v.vistoriador}</span> : null}
                        <span>· {v.fotos?.length || 0} FOTOS</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-center">
                      <div className="flex flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                        <SyncBadge
                          status={v.statusSync}
                          fotoUploadFailed={v.fotoUploadFailed}
                          duplicateType={v.duplicateType}
                        />
                        {showResync && v.id != null ? (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="h-8 gap-1.5 px-3 text-[11px] font-bold shadow-sm"
                            disabled={resyncingId === v.id}
                            onClick={(e) => handleResync(e, v)}
                          >
                            {resyncingId === v.id ? (
                              <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
                            ) : (
                              <RefreshCw className="h-3 w-3 shrink-0" aria-hidden />
                            )}
                            Sincronizar
                          </Button>
                        ) : null}
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground/50 max-sm:hidden" aria-hidden />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
