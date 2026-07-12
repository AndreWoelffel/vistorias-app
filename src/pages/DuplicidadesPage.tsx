import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppHeader } from '@/components/AppHeader';
import { SyncBadge } from '@/components/SyncBadge';
import { useRequireValidLeilao } from '@/hooks/useLeilaoRoute';
import {
  getVistoriasByLeilao,
  normalizeVistoriaStatusSync,
  type Vistoria,
} from '@/lib/db';
import { duplicateTypeShortLabel, duplicateUserMessage } from '@/services/inspectionService';
import { recalculateDuplicateVistoriasForLeilao } from '@/services/duplicateVistoriaRecalc';
import { isSemPlaca } from '@/lib/placaSemPlaca';
import { cn } from '@/lib/utils';

function normPlaca(p: string): string {
  return p.trim().toUpperCase().replace(/\s+/g, '');
}

function normNum(n: string): string {
  return n.trim();
}

function clusterConflicts(rows: (Vistoria & { id: number })[]): (Vistoria & { id: number })[][] {
  if (rows.length === 0) return [];
  const adj = new Map<number, Set<number>>();
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      const samePlaca =
        !isSemPlaca(a.placa) &&
        !isSemPlaca(b.placa) &&
        normPlaca(a.placa) === normPlaca(b.placa);
      const sn = normNum(a.numeroVistoria) === normNum(b.numeroVistoria);
      if (samePlaca || sn) {
        if (!adj.has(a.id)) adj.set(a.id, new Set());
        if (!adj.has(b.id)) adj.set(b.id, new Set());
        adj.get(a.id)!.add(b.id);
        adj.get(b.id)!.add(a.id);
      }
    }
  }
  const seen = new Set<number>();
  const groups: (Vistoria & { id: number })[][] = [];
  for (const v of rows) {
    if (seen.has(v.id)) continue;
    const q: number[] = [v.id];
    seen.add(v.id);
    const comp: (Vistoria & { id: number })[] = [v];
    while (q.length) {
      const cur = q.shift()!;
      for (const nx of adj.get(cur) ?? []) {
        if (!seen.has(nx)) {
          seen.add(nx);
          const node = rows.find((r) => r.id === nx);
          if (node) {
            comp.push(node);
            q.push(nx);
          }
        }
      }
    }
    groups.push(comp);
  }
  return groups;
}

export default function DuplicidadesPage() {
  const { leilaoId: id, ready } = useRequireValidLeilao();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<(Vistoria & { id: number })[][]>([]);

  const load = useCallback(async () => {
    if (!ready || !Number.isFinite(id)) return;
    setLoading(true);
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        const { fetchAndMergeVistoriasFromCloudForLeilao } = await import('@/services/inspectionService');
        await fetchAndMergeVistoriasFromCloudForLeilao(id);
      }
      await recalculateDuplicateVistoriasForLeilao(id);
      const all = await getVistoriasByLeilao(id, { includePendingCloudDelete: true });
      const withId = (Array.isArray(all) ? all : []).filter(
        (v): v is Vistoria & { id: number } => v.id != null,
      );
      const conflict = withId.filter((v) => {
        const n = normalizeVistoriaStatusSync(v.statusSync);
        return n === 'aguardando_ajuste' || n === 'conflito_duplicidade';
      });
      setGroups(clusterConflicts(conflict));
    } finally {
      setLoading(false);
    }
  }, [id, ready]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!ready) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AppHeader title="Duplicidades" showBack />
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Carregando…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Duplicidades" showBack />

      <div className="space-y-3 px-4 pt-3 pb-2">
        <p className="text-[11px] leading-snug text-muted-foreground">
          Vistorias com placa ou número repetido neste leilão. Corrija uma ou mais para voltar a
          sincronizar.
        </p>
        <Button type="button" variant="outline" size="sm" className="h-9 w-full" onClick={() => void load()}>
          Atualizar lista
        </Button>
      </div>

      <div className="flex-1 space-y-4 px-4 pb-8">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Carregando conflitos…</p>
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-6 py-14 text-center">
            <p className="text-base font-semibold text-foreground">Nenhuma duplicidade pendente</p>
            <p className="mt-1 text-sm text-muted-foreground">Todas as vistorias deste leilão estão ok.</p>
          </div>
        ) : (
          groups.map((g, gi) => (
            <div
              key={gi}
              className="rounded-2xl border border-orange-500/35 bg-orange-500/5 p-3 shadow-sm dark:bg-orange-950/20"
            >
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-orange-800 dark:text-orange-200">
                <AlertTriangle className="h-3.5 w-3.5" />
                {g.length > 1 ? `Grupo ${gi + 1} — ${g.length} vínculos` : 'Conflito'}
              </div>
              <ul className="flex flex-col gap-2">
                {g.map((v) => {
                  const n = normalizeVistoriaStatusSync(v.statusSync);
                  const reason =
                    v.duplicateType != null
                      ? duplicateTypeShortLabel(v.duplicateType)
                      : n === 'conflito_duplicidade'
                        ? 'Conflito no servidor'
                        : 'Ajuste local';
                  const detail =
                    v.duplicateType != null
                      ? duplicateUserMessage(v.duplicateType)
                      : v.syncMessage ?? '';
                  const peerList =
                    v.duplicateConflictWithList && v.duplicateConflictWithList.length > 0
                      ? v.duplicateConflictWithList
                      : v.duplicateConflictWith
                        ? [v.duplicateConflictWith]
                        : [];
                  return (
                    <li key={v.id}>
                      <button
                        type="button"
                        onClick={() => navigate(`/editar/${v.id}`)}
                        className={cn(
                          'flex w-full min-h-[56px] items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition',
                          'border-border bg-card hover:bg-accent/50',
                        )}
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="text-base font-black tracking-wider">{v.placa}</span>
                            <span className="text-sm tabular-nums text-muted-foreground">#{v.numeroVistoria}</span>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {reason}
                            {detail ? ` · ${detail}` : ''}
                          </p>
                          {peerList.length > 0 ? (
                            <p className="text-[10px] text-muted-foreground">
                              Colide com:{' '}
                              {peerList
                                .map((p) => `#${p.localVistoriaId} (${p.placa} · ${p.numeroVistoria})`)
                                .join(' · ')}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <SyncBadge
                            status={v.statusSync}
                            fotoUploadFailed={v.fotoUploadFailed}
                            duplicateType={v.duplicateType}
                          />
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
