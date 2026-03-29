import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Search, Calendar, Download, Loader2, ChevronRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { AppHeader } from '@/components/AppHeader';
import { SyncBadge } from '@/components/SyncBadge';
import { useVistorias } from '@/hooks/useVistorias';
import { useRequireValidLeilao } from '@/hooks/useLeilaoRoute';
import { isVistoriaSyncBlockedByDuplicate, normalizeVistoriaStatusSync, type Vistoria } from '@/lib/db';
import * as XLSX from 'xlsx';
import { cn } from '@/lib/utils';

function statusLabelForExport(v: Vistoria): string {
  const n = normalizeVistoriaStatusSync(v.statusSync);
  const base =
    n === 'sincronizado'
      ? 'Enviado'
      : n === 'erro_sync'
        ? 'Erro ao enviar'
        : n === 'aguardando_ajuste'
          ? 'Ajuste duplicado (aparelho)'
          : n === 'conflito_duplicidade'
            ? 'Duplicado no servidor'
            : n === 'rascunho'
              ? 'Rascunho'
              : 'Pendente';
  if (v.fotoUploadFailed && n === 'sincronizado') return `${base} · foto não enviada`;
  if (v.fotoUploadFailed) return `${base} · foto`;
  return base;
}

export default function HistoryPage() {
  const { leilaoId: id, ready } = useRequireValidLeilao();
  const navigate = useNavigate();
  const location = useLocation();
  const focusVistoriaId = (location.state as { focusVistoriaId?: number } | null)?.focusVistoriaId;
  const { vistorias, loading } = useVistorias(ready ? id : null);
  const [search, setSearch] = useState('');
  const [todayOnly, setTodayOnly] = useState(false);
  const [exporting, setExporting] = useState(false);

  const filtered = useMemo(() => {
    const list = vistorias ?? [];
    let result = list;
    if (todayOnly) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      result = result.filter((v) => new Date(v.createdAt) >= today);
    }
    if (search) {
      const q = search.toUpperCase();
      result = result.filter((v) => v.placa.includes(q) || v.numeroVistoria.includes(q));
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

  const exportExcel = () => {
    setExporting(true);
    try {
      const data = (filtered ?? []).map((v) => ({
        Data: new Date(v.createdAt).toLocaleString('pt-BR'),
        Vistoriador: v.vistoriador || '-',
        'Criado por': v.createdBy || '-',
        'Leilão': `Leilão ${id}`,
        Placa: v.placa,
        'Nº Vistoria': v.numeroVistoria,
        Fotos: v.fotos?.length || 0,
        Status: statusLabelForExport(v),
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      ws['!cols'] = [
        { wch: 18 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 6 }, { wch: 18 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Vistorias');
      XLSX.writeFile(wb, `vistorias_leilao_${id}_${new Date().toISOString().slice(0,10)}.xlsx`);
    } catch (err) {
      console.error(err);
    } finally {
      setExporting(false);
    }
  };

  if (!ready) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AppHeader title="Histórico" showBack onBack={() => navigate('/')} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Carregando…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Histórico" showBack />

      <div className="space-y-3 px-4 pt-3 pb-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por placa ou número"
            className="h-12 pl-10 text-base"
            enterKeyHint="search"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={todayOnly ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTodayOnly(!todayOnly)}
            className="h-10 gap-1.5 px-3 text-sm"
          >
            <Calendar className="h-4 w-4" />
            {todayOnly ? 'Só hoje' : 'Todas as datas'}
          </Button>
          <span className="text-xs text-muted-foreground">{filtered.length} itens</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={exportExcel}
            disabled={exporting || filtered.length === 0}
            className="ml-auto h-10 gap-1.5 px-3 text-sm"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Planilha
          </Button>
        </div>
      </div>

      <div className="flex-1 px-4 pb-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Carregando lista…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-6 py-14 text-center">
            <p className="text-base font-semibold text-foreground">Nada encontrado</p>
            <p className="mt-1 text-sm text-muted-foreground">Troque o filtro ou faça uma nova vistoria.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {(filtered ?? []).map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  id={v.id != null ? `vistoria-${v.id}` : undefined}
                  onClick={() => navigate(`/editar/${v.id}`)}
                  className={cn(
                    'flex w-full min-h-[60px] items-center gap-3 rounded-2xl border px-4 py-3 text-left transition active:scale-[0.99]',
                    'shadow-sm hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    isVistoriaSyncBlockedByDuplicate(v.statusSync)
                      ? 'border-orange-400/50 bg-orange-500/10'
                      : 'border-border bg-card',
                  )}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
                      <span className="text-lg font-black tracking-wider text-foreground">{v.placa}</span>
                      <span className="text-sm tabular-nums text-muted-foreground">#{v.numeroVistoria}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span>
                        {new Date(v.createdAt).toLocaleString('pt-BR', {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      {v.vistoriador ? <span>· {v.vistoriador}</span> : null}
                      <span>· {v.fotos?.length || 0} foto(s)</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <SyncBadge
                      status={v.statusSync}
                      fotoUploadFailed={v.fotoUploadFailed}
                      duplicateType={v.duplicateType}
                    />
                    <ChevronRight className="h-5 w-5 text-muted-foreground" aria-hidden />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
