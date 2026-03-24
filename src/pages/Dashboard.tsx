import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  ClipboardList,
  CloudOff,
  Copy,
  Loader2,
  RefreshCw,
  TrendingUp,
  User,
  Gavel,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { AppHeader } from "@/components/AppHeader";
import { LeilaoDashboardBottomBar } from "@/components/LeilaoDashboardBottomBar";
import { useRequireValidLeilao } from "@/hooks/useLeilaoRoute";
import {
  type DashboardPeriod,
  dashboardCountsForLeilao,
  formatDayKey,
  getVistoriasForLeilaoInRange,
  listAttentionItems,
  mergeStackKeys,
  periodMetricsForLeilao,
  periodToStartMs,
  startOfLocalDay,
  stackByDayAndLeilao,
  stackByDayAndVistoriador,
  collectSeriesNames,
  type AttentionListItem,
} from "@/lib/dashboardAggregates";
import { processQueue } from "@/services/syncService";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const CHART_COLORS = [
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#f97316",
  "#ec4899",
  "#14b8a6",
  "#eab308",
  "#6366f1",
];

type ChartView = "total" | "vistoriador" | "leilao";

function dayKeysBetween(fromMs: number, toMs: number): string[] {
  const keys: string[] = [];
  let curMs = startOfLocalDay(new Date(fromMs));
  const endMs = startOfLocalDay(new Date(toMs));
  while (curMs <= endMs) {
    keys.push(formatDayKey(curMs));
    curMs += 24 * 60 * 60 * 1000;
  }
  return keys;
}

export default function Dashboard() {
  const { leilaoId: id, ready } = useRequireValidLeilao();
  const navigate = useNavigate();
  const [counts, setCounts] = useState<Awaited<ReturnType<typeof dashboardCountsForLeilao>> | null>(
    null,
  );
  const [attention, setAttention] = useState<AttentionListItem[]>([]);
  const [period, setPeriod] = useState<DashboardPeriod>("30d");
  const [chartView, setChartView] = useState<ChartView>("vistoriador");
  const [chartRows, setChartRows] = useState<Record<string, string | number>[]>([]);
  const [chartKeys, setChartKeys] = useState<string[]>([]);
  const [periodMetrics, setPeriodMetrics] = useState<Awaited<
    ReturnType<typeof periodMetricsForLeilao>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncingAttention, setSyncingAttention] = useState(false);

  const load = useCallback(async () => {
    if (!ready || id == null) return;
    setLoading(true);
    try {
      const fromMs = periodToStartMs(period);
      const toMs = Date.now();
      const [c, att, pm, vs, byLeilao] = await Promise.all([
        dashboardCountsForLeilao(id),
        listAttentionItems(id),
        periodMetricsForLeilao(id, fromMs, toMs),
        getVistoriasForLeilaoInRange(id, fromMs, toMs),
        chartView === "leilao" ? stackByDayAndLeilao(fromMs, toMs) : Promise.resolve(null),
      ]);
      setCounts(c);
      setAttention(att);
      setPeriodMetrics(pm);

      let rows: Record<string, string | number>[] = [];
      let keys: string[] = [];

      if (chartView === "total") {
        const byDay: Record<string, number> = {};
        for (const v of vs) {
          const d = formatDayKey(startOfLocalDay(new Date(v.createdAt)));
          byDay[d] = (byDay[d] ?? 0) + 1;
        }
        const dayList =
          period === "all"
            ? Object.keys(byDay).sort()
            : dayKeysBetween(fromMs, toMs).length > 0
              ? dayKeysBetween(fromMs, toMs)
              : Object.keys(byDay).sort();
        rows = dayList.map((day) => ({ day, Total: byDay[day] ?? 0 }));
        keys = ["Total"];
      } else if (chartView === "vistoriador") {
        const stacked = stackByDayAndVistoriador(vs);
        const dayList =
          period === "all"
            ? mergeStackKeys(stacked)
            : dayKeysBetween(fromMs, toMs).length > 0
              ? dayKeysBetween(fromMs, toMs)
              : mergeStackKeys(stacked);
        keys = collectSeriesNames(stacked);
        rows = dayList.map((day) => {
          const row: Record<string, string | number> = { day };
          for (const n of keys) row[n] = stacked[day]?.[n] ?? 0;
          return row;
        });
      } else if (byLeilao) {
        const dayList =
          period === "all"
            ? mergeStackKeys(byLeilao)
            : dayKeysBetween(fromMs, toMs).length > 0
              ? dayKeysBetween(fromMs, toMs)
              : mergeStackKeys(byLeilao);
        keys = collectSeriesNames(byLeilao);
        rows = dayList.map((day) => {
          const row: Record<string, string | number> = { day };
          for (const n of keys) row[n] = byLeilao[day]?.[n] ?? 0;
          return row;
        });
      }

      setChartRows(rows);
      setChartKeys(keys);
    } catch (e) {
      console.error(e);
      toast({ title: "Erro ao carregar painel", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [ready, id, period, chartView]);

  useEffect(() => {
    void load();
  }, [load]);

  const chartMinWidth = useMemo(() => Math.max(320, chartRows.length * 44), [chartRows.length]);

  const periodLabel = useMemo(() => {
    if (period === "7d") return "7 dias";
    if (period === "30d") return "30 dias";
    if (period === "90d") return "90 dias";
    return "Todo o período";
  }, [period]);

  const handleTrySync = async () => {
    setSyncingAttention(true);
    try {
      await processQueue();
      await load();
      toast({ title: "Sincronização executada" });
    } catch {
      toast({ title: "Falha ao sincronizar", variant: "destructive" });
    } finally {
      setSyncingAttention(false);
    }
  };

  if (!ready) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AppHeader title="Dashboard" showBack onBack={() => navigate("/")} />
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Painel do dia" showBack onBack={() => navigate("/")} />

      <div className="flex-1 space-y-6 p-4 pb-28">
        {loading && !counts ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm">Carregando indicadores…</p>
          </div>
        ) : counts ? (
          <>
            <section className="space-y-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Resumo operacional
              </h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <StatCard
                  icon={<CalendarDays className="h-4 w-4" />}
                  label="Hoje"
                  value={counts.today}
                  sub="vistorias"
                  accent
                />
                <StatCard
                  icon={<BarChart3 className="h-4 w-4" />}
                  label="Na semana"
                  value={counts.week}
                  sub="vistorias"
                />
                <StatCard
                  icon={<ClipboardList className="h-4 w-4" />}
                  label="Total"
                  value={counts.total}
                  sub="vistorias"
                />
                <StatCard
                  icon={<CloudOff className="h-4 w-4" />}
                  label="Pendências (fila)"
                  value={counts.pendingQueue}
                  sub="itens"
                  warn={counts.pendingQueue > 0}
                />
                <StatCard
                  icon={<AlertTriangle className="h-4 w-4" />}
                  label="Com erro"
                  value={counts.erro}
                  sub="vistorias"
                  danger={counts.erro > 0}
                />
                <StatCard
                  icon={<Copy className="h-4 w-4" />}
                  label="Conflito / duplicidade"
                  value={counts.conflito}
                  sub="vistorias"
                  danger={counts.conflito > 0}
                />
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Produção — {periodLabel}
                </h2>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["7d", "7 dias"],
                    ["30d", "30 dias"],
                    ["90d", "90 dias"],
                    ["all", "Tudo"],
                  ] as const
                ).map(([p, lab]) => (
                  <Button
                    key={p}
                    type="button"
                    size="sm"
                    variant={period === p ? "default" : "secondary"}
                    className="h-8 rounded-lg text-xs"
                    onClick={() => setPeriod(p)}
                  >
                    {lab}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant={chartView === "total" ? "default" : "outline"}
                  className="h-8 rounded-lg text-xs"
                  onClick={() => setChartView("total")}
                >
                  Total
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={chartView === "vistoriador" ? "default" : "outline"}
                  className="h-8 rounded-lg text-xs"
                  onClick={() => setChartView("vistoriador")}
                >
                  Por vistoriador
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={chartView === "leilao" ? "default" : "outline"}
                  className="h-8 rounded-lg text-xs"
                  onClick={() => setChartView("leilao")}
                >
                  Por leilão
                </Button>
              </div>

              <div className="card-glow overflow-x-auto rounded-xl border border-border/60 bg-card/80 p-2">
                {chartRows.length === 0 || chartKeys.length === 0 ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    Sem dados no período selecionado.
                  </p>
                ) : (
                  <div style={{ minWidth: chartMinWidth, height: 280 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                        <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={32} />
                        <Tooltip
                          contentStyle={{
                            borderRadius: 8,
                            border: "1px solid hsl(var(--border))",
                            background: "hsl(var(--card))",
                          }}
                        />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        {chartKeys.map((k, i) => (
                          <Bar
                            key={k}
                            dataKey={k}
                            stackId="a"
                            fill={CHART_COLORS[i % CHART_COLORS.length]}
                            radius={[2, 2, 0, 0]}
                          />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </section>

            {periodMetrics && (
              <section className="space-y-2">
                <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Métricas ({periodLabel})
                </h2>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <MetricRow
                    icon={<TrendingUp className="h-4 w-4 text-primary" />}
                    label="Taxa de sincronização"
                    value={`${periodMetrics.taxaSync}%`}
                  />
                  <MetricRow
                    icon={<User className="h-4 w-4 text-primary" />}
                    label="Vistoriador mais ativo"
                    value={periodMetrics.topVistoriador}
                    hint={`${periodMetrics.topVistoriadorCount} vistorias`}
                  />
                  <MetricRow
                    icon={<Gavel className="h-4 w-4 text-primary" />}
                    label="Leilão com mais vistorias"
                    value={periodMetrics.topLeilao}
                    hint={`${periodMetrics.topLeilaoCount} no período`}
                  />
                  <MetricRow
                    icon={<CalendarDays className="h-4 w-4 text-primary" />}
                    label="Média diária / pico"
                    value={`${periodMetrics.mediaDiaria} / dia`}
                    hint={`Pico: ${periodMetrics.pico} em um dia`}
                  />
                </div>
              </section>
            )}

            <section className="space-y-3">
              <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Atenção necessária
              </h2>
              {attention.length === 0 ? (
                <p className="rounded-xl border border-border/50 bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                  Nenhum item crítico. Bom trabalho.
                </p>
              ) : (
                <ul className="space-y-2">
                  {attention.map((item) => (
                    <li
                      key={item.vistoriaId}
                      className="card-glow rounded-xl border border-border/60 bg-card p-3 space-y-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-black tracking-wide text-foreground">{item.placa}</p>
                          <p className="text-xs text-muted-foreground">
                            #{item.numeroVistoria}
                            {item.vistoriador ? ` · ${item.vistoriador}` : ""}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {item.reasons.map((r) => (
                              <ReasonChip key={r} reason={r} />
                            ))}
                          </div>
                          {item.syncMessage ? (
                            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                              {item.syncMessage}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-8 text-xs"
                            onClick={() =>
                              navigate(`/historico/${id}`, {
                                state: { focusVistoriaId: item.vistoriaId },
                              })
                            }
                          >
                            Abrir
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="default"
                            className="h-8 text-xs"
                            onClick={() => navigate(`/editar/${item.vistoriaId}`)}
                          >
                            Corrigir
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1 text-xs"
                            disabled={syncingAttention}
                            onClick={() => void handleTrySync()}
                          >
                            {syncingAttention ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3 w-3" />
                            )}
                            Sincronizar
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full text-xs text-muted-foreground"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-2 h-3 w-3" />}
          Atualizar painel
        </Button>
      </div>

      <LeilaoDashboardBottomBar leilaoId={id} />
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  accent,
  warn,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sub: string;
  accent?: boolean;
  warn?: boolean;
  danger?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/60 bg-card/90 p-3 shadow-sm",
        accent && "ring-1 ring-primary/25",
        warn && "border-amber-500/40",
        danger && "border-red-500/35",
      )}
    >
      <div className="mb-1 flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
      </div>
      <p
        className={cn(
          "text-2xl font-black tabular-nums",
          accent && "text-primary",
          danger && "text-red-600 dark:text-red-400",
          warn && !danger && "text-amber-700 dark:text-amber-300",
        )}
      >
        {value}
      </p>
      <p className="text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function MetricRow({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-card/60 px-3 py-2.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-semibold text-foreground">{value}</p>
        {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

function ReasonChip({ reason }: { reason: AttentionListItem["reasons"][number] }) {
  const map: Record<AttentionListItem["reasons"][number], { label: string; className: string }> = {
    erro_sync: { label: "Erro sync", className: "bg-red-500/15 text-red-700 dark:text-red-300" },
    conflito_duplicidade: {
      label: "Duplicidade",
      className: "bg-orange-500/15 text-orange-800 dark:text-orange-200",
    },
    foto_falhou: { label: "Foto", className: "bg-violet-500/15 text-violet-800 dark:text-violet-200" },
    pendente_sync: { label: "Pendente", className: "bg-amber-500/15 text-amber-800 dark:text-amber-200" },
    fila_com_falha: { label: "Fila com falha", className: "bg-red-500/10 text-red-600 dark:text-red-400" },
  };
  const m = map[reason];
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", m.className)}>{m.label}</span>
  );
}
