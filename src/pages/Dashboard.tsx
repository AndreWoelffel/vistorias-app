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
import { duplicateTypeShortLabel, duplicateValuesCaption } from "@/services/inspectionService";
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
  const [period, setPeriod] = useState<DashboardPeriod>("7d");
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
      toast({
        title: "Não carregou o painel",
        description: "Puxe para atualizar ou verifique a internet.",
        variant: "destructive",
      });
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
      toast({ title: "Envio tentado", description: "Confira os cards acima se algo ainda falhou." });
    } catch {
      toast({
        title: "Não foi possível enviar agora",
        description: "Espere a internet e tente de novo.",
        variant: "destructive",
      });
    } finally {
      setSyncingAttention(false);
    }
  };

  if (!ready) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AppHeader title="Painel" showBack onBack={() => navigate("/")} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Carregando…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Painel" showBack onBack={() => navigate("/")} />

      <div className={cn("flex-1 space-y-5 p-4 pb-28", loading && counts && "opacity-70 transition-opacity")}>
        {loading && !counts ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm">Carregando…</p>
          </div>
        ) : counts ? (
          <>
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-foreground">Hoje no leilão</h2>
                {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" aria-label="Atualizando" />}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <StatCard
                  icon={<CalendarDays className="h-4 w-4" />}
                  label="Hoje"
                  value={counts.today}
                  sub="feitas"
                  accent
                />
                <StatCard
                  icon={<BarChart3 className="h-4 w-4" />}
                  label="7 dias"
                  value={counts.week}
                  sub="feitas"
                />
                <StatCard
                  icon={<ClipboardList className="h-4 w-4" />}
                  label="Total"
                  value={counts.total}
                  sub="no aparelho"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <StatCard
                  icon={<CloudOff className="h-4 w-4" />}
                  label="A enviar"
                  value={counts.pendingQueue}
                  sub="na fila"
                  warn={counts.pendingQueue > 0}
                />
                <StatCard
                  icon={<AlertTriangle className="h-4 w-4" />}
                  label="Erro"
                  value={counts.erro}
                  sub="corrigir"
                  danger={counts.erro > 0}
                />
                <StatCard
                  icon={<Copy className="h-4 w-4" />}
                  label="Duplicado"
                  value={counts.conflito}
                  sub="ajustar"
                  danger={counts.conflito > 0}
                />
              </div>
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">Vistorias por dia</h2>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ["7d", "7 d"],
                    ["30d", "30 d"],
                    ["90d", "90 d"],
                    ["all", "Tudo"],
                  ] as const
                ).map(([p, lab]) => (
                  <Button
                    key={p}
                    type="button"
                    size="sm"
                    variant={period === p ? "default" : "ghost"}
                    className="h-9 rounded-full px-3 text-xs"
                    onClick={() => setPeriod(p)}
                  >
                    {lab}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1 border-b border-border/60 pb-2">
                <Button
                  type="button"
                  size="sm"
                  variant={chartView === "total" ? "secondary" : "ghost"}
                  className="h-8 rounded-lg text-xs"
                  onClick={() => setChartView("total")}
                >
                  Total
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={chartView === "vistoriador" ? "secondary" : "ghost"}
                  className="h-8 rounded-lg text-xs"
                  onClick={() => setChartView("vistoriador")}
                >
                  Por pessoa
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={chartView === "leilao" ? "secondary" : "ghost"}
                  className="h-8 rounded-lg text-xs"
                  onClick={() => setChartView("leilao")}
                >
                  Por leilão
                </Button>
              </div>

              <div className="overflow-x-auto rounded-xl border border-border/60 bg-card/50 p-2">
                {chartRows.length === 0 || chartKeys.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">Sem dados neste período.</p>
                ) : (
                  <div style={{ minWidth: chartMinWidth, height: 220 }}>
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
              <details className="group rounded-xl border border-border/50 bg-muted/10">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
                  <span>Mais números ({periodLabel})</span>
                  <span className="text-xs text-muted-foreground transition-transform group-open:rotate-180">▼</span>
                </summary>
                <div className="grid grid-cols-1 gap-2 border-t border-border/40 px-3 py-3 sm:grid-cols-2">
                  <MetricRow
                    icon={<TrendingUp className="h-4 w-4 text-emerald-600" />}
                    label="Enviadas no período"
                    value={`${periodMetrics.taxaSync}%`}
                    hint="Das que estão neste aparelho."
                  />
                  <MetricRow
                    icon={<User className="h-4 w-4 text-primary" />}
                    label="Quem mais fez"
                    value={periodMetrics.topVistoriador}
                    hint={`${periodMetrics.topVistoriadorCount} vistorias`}
                  />
                  <MetricRow
                    icon={<Gavel className="h-4 w-4 text-primary" />}
                    label="Leilão com mais registros"
                    value={periodMetrics.topLeilao}
                    hint={`${periodMetrics.topLeilaoCount} no período`}
                  />
                  <MetricRow
                    icon={<CalendarDays className="h-4 w-4 text-primary" />}
                    label="Média e pico"
                    value={`${periodMetrics.mediaDiaria} / dia`}
                    hint={`Pico num dia: ${periodMetrics.pico}`}
                  />
                </div>
              </details>
            )}

            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">Precisa de ação</h2>
              {attention.length === 0 ? (
                <p className="rounded-xl border border-border/40 bg-muted/15 px-4 py-5 text-center text-sm text-muted-foreground">
                  Nada pendente por aqui.
                </p>
              ) : (
                <ul className="space-y-2">
                  {attention.map((item) => {
                    const dupValuesLine = duplicateValuesCaption(item.duplicateType, item.duplicateInfo);
                    return (
                    <li
                      key={item.vistoriaId}
                      className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="text-lg font-bold tracking-wide text-foreground">{item.placa}</p>
                          <p className="text-sm text-muted-foreground">
                            #{item.numeroVistoria}
                            {item.vistoriador ? ` · ${item.vistoriador}` : ""}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {item.reasons.map((r) => (
                              <ReasonChip key={r} reason={r} duplicateType={item.duplicateType} />
                            ))}
                          </div>
                          {dupValuesLine ? (
                            <p className="mt-1.5 text-[11px] font-medium text-muted-foreground">{dupValuesLine}</p>
                          ) : null}
                          {item.syncMessage ? (
                            <p className="mt-2 text-xs leading-snug text-orange-800 dark:text-orange-200">{item.syncMessage}</p>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-stretch sm:shrink-0">
                          <Button
                            type="button"
                            className="h-11 min-h-11 flex-1 rounded-xl text-sm font-semibold sm:min-w-[140px]"
                            onClick={() => navigate(`/editar/${item.vistoriaId}`)}
                          >
                            Abrir e corrigir
                          </Button>
                          <div className="flex gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-9 text-xs text-muted-foreground"
                              onClick={() =>
                                navigate(`/historico/${id}`, {
                                  state: { focusVistoriaId: item.vistoriaId },
                                })
                              }
                            >
                              Ver na lista
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-9 gap-1 text-xs text-muted-foreground"
                              disabled={syncingAttention}
                              onClick={() => void handleTrySync()}
                            >
                              {syncingAttention ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3 w-3" />
                              )}
                              Tentar enviar
                            </Button>
                          </div>
                        </div>
                      </div>
                    </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        ) : null}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-10 w-full text-xs text-muted-foreground"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-2 h-3 w-3" />}
          Atualizar
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
          "text-xl font-black tabular-nums sm:text-2xl",
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
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-semibold text-foreground">{value}</p>
        {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

function ReasonChip({
  reason,
  duplicateType,
}: {
  reason: AttentionListItem["reasons"][number];
  duplicateType?: AttentionListItem["duplicateType"];
}) {
  const dupCls = "bg-orange-500/20 text-orange-900 dark:text-orange-100";
  if (
    (reason === "conflito_duplicidade" || reason === "aguardando_ajuste") &&
    duplicateType
  ) {
    return (
      <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", dupCls)}>
        {duplicateTypeShortLabel(duplicateType)}
      </span>
    );
  }
  const map: Record<AttentionListItem["reasons"][number], { label: string; className: string }> = {
    erro_sync: { label: "Erro ao enviar", className: "bg-red-500/15 text-red-700 dark:text-red-300" },
    conflito_duplicidade: {
      label: "Duplicado no servidor",
      className: dupCls,
    },
    aguardando_ajuste: {
      label: "Duplicado — ajuste",
      className: dupCls,
    },
    foto_falhou: { label: "Foto não foi", className: "bg-amber-400/25 text-amber-950 dark:text-amber-50" },
    pendente_sync: { label: "A enviar", className: "bg-amber-400/30 text-amber-950 dark:text-amber-50" },
    fila_com_falha: { label: "Envio travado", className: "bg-red-500/10 text-red-600 dark:text-red-400" },
  };
  const m = map[reason];
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", m.className)}>{m.label}</span>
  );
}
