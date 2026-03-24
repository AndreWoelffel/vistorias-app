import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Search, Filter, Download, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { AppHeader } from '@/components/AppHeader';
import { SyncBadge } from '@/components/SyncBadge';
import { useVistorias } from '@/hooks/useVistorias';
import { useRequireValidLeilao } from '@/hooks/useLeilaoRoute';
import { isVistoriaSyncBlockedByDuplicate, normalizeVistoriaStatusSync, type Vistoria } from '@/lib/db';
import * as XLSX from 'xlsx';

function statusLabelForExport(v: Vistoria): string {
  const n = normalizeVistoriaStatusSync(v.statusSync);
  const base =
    n === 'sincronizado'
      ? 'Sincronizado'
      : n === 'erro_sync'
        ? 'Erro de sincronização'
        : n === 'aguardando_ajuste'
          ? 'Aguardando ajuste (duplicidade local)'
          : n === 'conflito_duplicidade'
            ? 'Conflito (duplicidade na nuvem)'
          : n === 'rascunho'
            ? 'Rascunho'
            : 'Pendente de sincronização';
  if (v.fotoUploadFailed && n === 'sincronizado') return `${base} · falha no envio da foto`;
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
      document.getElementById(`vistoria-${focusVistoriaId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
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
      // Auto-size columns
      ws['!cols'] = [
        { wch: 18 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 6 }, { wch: 14 },
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
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Histórico" showBack />

      <div className="px-3 pt-2 pb-1 space-y-1.5">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar placa..."
            className="h-8 pl-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={todayOnly ? 'default' : 'secondary'}
            size="sm"
            onClick={() => setTodayOnly(!todayOnly)}
            className="gap-1 text-[10px] h-7 px-2"
          >
            <Filter className="h-3 w-3" />
            {todayOnly ? 'Hoje' : 'Todas'}
          </Button>
          <span className="text-[10px] text-muted-foreground ml-1">{filtered.length} registros</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={exportExcel}
            disabled={exporting || filtered.length === 0}
            className="gap-1 text-[10px] h-7 px-2 ml-auto"
          >
            {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            Excel
          </Button>
        </div>
      </div>

      <div className="flex-1 px-2 pb-2">
        {loading ? (
          <p className="text-center text-muted-foreground py-10 text-xs">Carregando...</p>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-sm font-bold text-muted-foreground">Nenhuma vistoria encontrada</p>
            <p className="text-[10px] text-muted-foreground mt-1">Realize sua primeira vistoria</p>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {(filtered ?? []).map((v) => (
              <button
                key={v.id}
                id={v.id != null ? `vistoria-${v.id}` : undefined}
                onClick={() => navigate(`/editar/${v.id}`)}
                className={
                  isVistoriaSyncBlockedByDuplicate(v.statusSync)
                    ? 'w-full text-left py-1.5 px-2 flex items-center gap-2 active:bg-secondary/50 transition-colors border-l-2 border-amber-500/80 bg-amber-500/5'
                    : 'w-full text-left py-1.5 px-2 flex items-center gap-2 active:bg-secondary/50 transition-colors'
                }
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-black tracking-wider text-foreground">{v.placa}</span>
                    <span className="text-[10px] text-muted-foreground">#{v.numeroVistoria}</span>
                    {v.vistoriador && (
                      <span className="text-[10px] text-muted-foreground truncate max-w-[80px]">• {v.vistoriador}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(v.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{v.fotos?.length || 0}📷</span>
                    {v.createdBy && (
                      <span className="text-[10px] text-muted-foreground truncate max-w-[140px]">
                        · Criado por: {v.createdBy}
                      </span>
                    )}
                  </div>
                </div>
                <SyncBadge status={v.statusSync} fotoUploadFailed={v.fotoUploadFailed} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
