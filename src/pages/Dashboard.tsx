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
  const [counts, setCounts] = useState<Awaited<ReturnType<typeof dashboardCountsForLeilao>> | null>(null);
  const [attention, setAttention] = useState<AttentionListItem[]>([]);
  const [period, setPeriod] = useState<DashboardPeriod>("7d");
  const [chartView, setChartView] = useState<ChartView>("vistoriador");
  const [chartRows, setChartRows] = useState<Record<string, string | number>[]>([]);
  const [chartKeys, setChartKeys] = useState<string[]>([]);
  const [periodMetrics, setPeriodMetrics] = useState<Awaited<ReturnType<typeof periodMetricsForLeilao>> | null>(null);
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
    if (syncingAttention) return;
    setSyncingAttention(true);
    try {
      await processQueue();
      await load();
      toast({ title: "Envio concluído", description: "Verifique os cards acima para confirmar se tudo foi enviado." });
    } catch {
      toast({
        title: "Erro de comunicação",
        description: "Falha ao conectar com o Supabase. Tente mais tarde.",
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
          <p className="text-sm text-muted-foreground font-medium">Carregando métricas…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Painel" showBack onBack={() => navigate("/")} />

      <div className={cn("flex-1 space-y-6 p-4 pb-28", loading && counts && "opacity-60 transition-opacity duration-300")}>
        {loading && !counts ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm font-medium">Carregando Painel…</p>
          </div>
        ) : counts ? (
          <>
            <section className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-foreground uppercase tracking-wide">Hoje no leilão</h2>
                {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" aria-label="Atualizando" />}
              </div>
              <div className="grid grid-cols-3 gap-3">
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
              <div className="grid grid-cols-3 gap-3">
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

            <section className="space-y-3 pt-2">
              <h2 className="text-sm font-bold text-foreground uppercase tracking-wide">Vistorias por dia</h2>
              <div className="flex flex-wrap gap-2">
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
                    className="h-8 rounded-full px-4 text-xs font-semibold transition-colors"
                    onClick={() => setPeriod(p)}
                  >
                    {lab}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 border-b border-border/60 pb-3">
                <Button
                  type="button"
                  size="sm"
                  variant={chartView === "total" ? "secondary" : "ghost"}
                  className="h-8 rounded-lg text-xs font-medium"
                  onClick={() => setChartView("total")}
                >
                  Total Geral
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={chartView === "vistoriador" ? "secondary" : "ghost"}
                  className="h-8 rounded-lg text-xs font-medium"
                  onClick={() => setChartView("vistoriador")}
                >
                  Por Vistoriador
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={chartView === "leilao" ? "secondary" : "ghost"}
                  className="h-8 rounded-lg text-xs font-medium"
                  onClick={() => setChartView("leilao")}
                >
                  Por Leilão
                </Button>
              </div>

              <div className="overflow-x-auto rounded-xl border border-border/80 bg-card/40 p-3 shadow-inner">
                {chartRows.length === 0 || chartKeys.length === 0 ? (
                  <p className="py-12 text-center text-sm font-medium text-muted-foreground">Sem dados de vistorias neste período.</p>
                ) : (
                  <div style={{ minWidth: chartMinWidth, height: 240 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartRows} margin={{ top: 12, right: 10, left: -15, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" vertical={false} />
                        <XAxis dataKey="day" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickMargin={8} axisLine={false} tickLine={false} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} width={40} axisLine={false} tickLine={false} />
                        <Tooltip
                          cursor={{ fill: "hsl(var(--secondary))", opacity: 0.4 }}
                          contentStyle={{
                            borderRadius: 12,
                            border: "1px solid hsl(var(--border))",
                            background: "hsl(var(--card))",
                            color: "hsl(var(--foreground))",
                            boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                            padding: "8px 12px",
                            fontSize: "12px",
                            fontWeight: "500"
                          }}
                          itemStyle={{
                            color: "hsl(var(--foreground))",
                            fontWeight: "600"
                          }}
                        />
                        <Legend wrapperStyle={{ fontSize: 12, paddingTop: "10px", fontWeight: "500" }} iconType="circle" />
                        {chartKeys.map((k, i) => (
                          <Bar
                            key={k}
                            dataKey={k}
                            stackId="a"
                            fill={CHART_COLORS[i % CHART_COLORS.length]}
                            radius={[4, 4, 0, 0]}
                            maxBarSize={40}
                          />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </section>

            {periodMetrics && (
              <details className="group rounded-xl border border-border/80 bg-muted/20 shadow-sm transition-all open:bg-card">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3.5 text-sm font-bold text-foreground [&::-webkit-details-marker]:hidden hover:text-primary transition-colors">
                  <span>Métricas Detalhadas ({periodLabel})</span>
                  <span className="text-xs text-muted-foreground transition-transform duration-200 group-open:rotate-180">▼</span>
                </summary>
                <div className="grid grid-cols-1 gap-3 border-t border-border/50 px-4 py-4 sm:grid-cols-2">
                  <MetricRow
                    icon={<TrendingUp className="h-4 w-4 text-emerald-500" />}
                    label="Taxa de Envio"
                    value={`${periodMetrics.taxaSync}%`}
                    hint="Vistorias sincronizadas com o Supabase"
                  />
                  <MetricRow
                    icon={<User className="h-4 w-4 text-blue-500" />}
                    label="Top Vistoriador"
                    value={periodMetrics.topVistoriador}
                    hint={`${periodMetrics.topVistoriadorCount} vistorias realizadas`}
                  />
                  <MetricRow
                    icon={<Gavel className="h-4 w-4 text-purple-500" />}
                    label="Leilão Mais Ativo"
                    value={periodMetrics.topLeilao}
                    hint={`${periodMetrics.topLeilaoCount} registros no período`}
                  />
                  <MetricRow
                    icon={<CalendarDays className="h-4 w-4 text-orange-500" />}
                    label="Desempenho Diário"
                    value={`${periodMetrics.mediaDiaria} vistorias/dia`}
                    hint={`Pico máximo: ${periodMetrics.pico} em um único dia`}
                  />
                </div>
              </details>
            )}

            <section className="space-y-3 pt-2">
              <h2 className="text-sm font-bold text-foreground uppercase tracking-wide flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Atenção Necessária
              </h2>
              {attention.length === 0 ? (
                <div className="rounded-xl border border-border/50 bg-secondary/30 px-4 py-8 text-center flex flex-col items-center gap-2">
                  <ClipboardList className="h-8 w-8 text-muted-foreground/40" />
                  <p className="text-sm font-medium text-muted-foreground">
                    Nenhuma pendência ou erro detectado.
                  </p>
                </div>
              ) : (
                <ul className="space-y-3">
                  {attention.map((item) => {
                    const dupValuesLine = duplicateValuesCaption(item.duplicateType, item.duplicateInfo);
                    return (
                    <li
                      key={item.vistoriaId}
                      className="rounded-xl border border-border/80 bg-card p-4 shadow-sm hover:border-primary/40 transition-colors"
                    >
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="text-lg font-black tracking-wider text-foreground">{item.placa}</p>
                          <p className="text-sm font-medium text-muted-foreground mt-0.5">
                            ID: #{item.numeroVistoria}
                            {item.vistoriador ? ` · Vistoriador: ${item.vistoriador}` : ""}
                          </p>
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {item.reasons.map((r) => (
                              <ReasonChip key={r} reason={r} duplicateType={item.duplicateType} />
                            ))}
                          </div>
                          {dupValuesLine ? (
                            <p className="mt-2 text-xs font-semibold text-amber-700 dark:text-amber-400 bg-amber-500/10 inline-block px-2 py-1 rounded-md">{dupValuesLine}</p>
                          ) : null}
                          {item.syncMessage ? (
                            <p className="mt-2 text-xs font-medium text-destructive bg-destructive/10 inline-block px-2 py-1 rounded-md">{item.syncMessage}</p>
                          ) : null}
                        </div>
                        <div className="flex flex-col items-stretch gap-2 shrink-0">
                          <Button
                            type="button"
                            className="h-10 w-full sm:w-[150px] rounded-lg text-sm font-bold shadow-sm"
                            onClick={() => navigate(`/editar/${item.vistoriaId}`)}
                          >
                            Abrir e Corrigir
                          </Button>
                          <div className="grid grid-cols-2 gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-9 text-[11px] font-semibold"
                              onClick={() =>
                                navigate(`/historico/${id}`, {
                                  state: { focusVistoriaId: item.vistoriaId },
                                })
                              }
                            >
                              Ver Histórico
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              className="h-9 gap-1.5 text-[11px] font-semibold bg-blue-500/10 text-blue-700 hover:bg-blue-500/20 dark:text-blue-400"
                              disabled={syncingAttention}
                              onClick={() => void handleTrySync()}
                            >
                              {syncingAttention ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3 w-3" />
                              )}
                              Reenviar
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
          variant="outline"
          size="sm"
          className="h-12 w-full text-sm font-bold text-muted-foreground border-dashed border-border/60 hover:bg-secondary/50 mt-6"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Forçar Atualização do Painel
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
        "flex flex-col justify-between rounded-xl border border-border/80 bg-card p-3.5 shadow-sm transition-all hover:shadow-md",
        accent && "ring-2 ring-primary/40 border-primary/20",
        warn && "ring-1 ring-amber-500/50 border-amber-500/30 bg-amber-500/5",
        danger && "ring-1 ring-red-500/50 border-red-500/30 bg-red-500/5",
      )}
    >
      <div className="mb-2 flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">{label}</span>
      </div>
      <div>
        <p
          className={cn(
            "text-2xl font-black tabular-nums sm:text-3xl leading-none mb-1",
            accent && "text-primary",
            danger && "text-red-600 dark:text-red-400",
            warn && !danger && "text-amber-600 dark:text-amber-400",
          )}
        >
          {value}
        </p>
        <p className="text-[11px] font-medium text-muted-foreground/80 lowercase">{sub}</p>
      </div>
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
    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3 shadow-sm">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="truncate text-base font-black text-foreground mt-0.5">{value}</p>
        {hint ? <p className="text-xs font-medium text-muted-foreground/70 mt-0.5">{hint}</p> : null}
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
  const dupCls = "bg-orange-500/15 text-orange-700 dark:text-orange-300 border border-orange-500/30";
  if (
    (reason === "conflito_duplicidade" || reason === "aguardando_ajuste") &&
    duplicateType
  ) {
    return (
      <span className={cn("rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wide", dupCls)}>
        {duplicateTypeShortLabel(duplicateType)}
      </span>
    );
  }
  const map: Record<AttentionListItem["reasons"][number], { label: string; className: string }> = {
    erro_sync: { label: "Erro ao Enviar", className: "bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30" },
    conflito_duplicidade: {
      label: "Duplicado no Servidor",
      className: dupCls,
    },
    aguardando_ajuste: {
      label: "Duplicado — Ajuste",
      className: dupCls,
    },
    foto_falhou: { label: "Falha na Foto", className: "bg-amber-400/20 text-amber-800 dark:text-amber-200 border border-amber-500/30" },
    pendente_sync: { label: "Aguardando Envio", className: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-500/30" },
    fila_com_falha: { label: "Envio Travado", className: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30" },
  };
  const m = map[reason];
  return (
    <span className={cn("rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wide", m.className)}>{m.label}</span>
  );
}