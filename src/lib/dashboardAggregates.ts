import {
  getAllLeiloes,
  getQueue,
  getVistoriasByLeilao,
  normalizeVistoriaStatusSync,
  type SyncQueueItem,
  type Vistoria,
} from "@/lib/db";
/** Alinhado a `syncService.MAX_SYNC_RETRIES` (evita import circular). */
const QUEUE_MAX_RETRIES = 5;

export type DashboardPeriod = "7d" | "30d" | "90d" | "all";

export function periodToStartMs(period: DashboardPeriod): number {
  const now = Date.now();
  if (period === "all") return 0;
  const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
  return now - days * 24 * 60 * 60 * 1000;
}

export function startOfLocalDay(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

export function formatDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Vistorias do leilão com createdAt no intervalo [fromMs, toMs]. */
export async function getVistoriasForLeilaoInRange(
  leilaoId: number,
  fromMs: number,
  toMs: number,
): Promise<Vistoria[]> {
  const all = await getVistoriasByLeilao(leilaoId);
  return all.filter((v) => {
    const t = new Date(v.createdAt).getTime();
    return t >= fromMs && t <= toMs;
  });
}

export type StackedByVistoriador = Record<string, Record<string, number>>;

/** dayKey → vistoriador → count */
export function stackByDayAndVistoriador(vistorias: Vistoria[]): StackedByVistoriador {
  const out: StackedByVistoriador = {};
  for (const v of vistorias) {
    const day = formatDayKey(startOfLocalDay(new Date(v.createdAt)));
    const who = (v.vistoriador || "—").trim() || "—";
    if (!out[day]) out[day] = {};
    out[day][who] = (out[day][who] ?? 0) + 1;
  }
  return out;
}

/** dayKey → leilaoNome → count (todas as vistorias locais por leilão). */
export async function stackByDayAndLeilao(
  fromMs: number,
  toMs: number,
): Promise<Record<string, Record<string, number>>> {
  const leiloes = await getAllLeiloes();
  const active = (Array.isArray(leiloes) ? leiloes : []).filter((l) => !l.deleted && l.id != null);
  const out: Record<string, Record<string, number>> = {};
  for (const l of active) {
    const lid = l.id as number;
    const vs = await getVistoriasForLeilaoInRange(lid, fromMs, toMs);
    const nome = (l.nome || `Leilão ${lid}`).trim();
    for (const v of vs) {
      const day = formatDayKey(startOfLocalDay(new Date(v.createdAt)));
      if (!out[day]) out[day] = {};
      out[day][nome] = (out[day][nome] ?? 0) + 1;
    }
  }
  return out;
}

export function mergeStackKeys(data: Record<string, Record<string, number>>): string[] {
  return Object.keys(data).sort();
}

export function collectSeriesNames(data: Record<string, Record<string, number>>): string[] {
  const s = new Set<string>();
  for (const day of Object.keys(data)) {
    for (const k of Object.keys(data[day])) s.add(k);
  }
  return [...s].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

export async function countVistoriasThisWeek(leilaoId: number): Promise<number> {
  const now = Date.now();
  const start = now - 7 * 24 * 60 * 60 * 1000;
  const vs = await getVistoriasForLeilaoInRange(leilaoId, start, now);
  return vs.length;
}

export async function countByVistoriador(
  leilaoId: number,
  fromMs: number,
  toMs: number,
): Promise<Record<string, number>> {
  const vs = await getVistoriasForLeilaoInRange(leilaoId, fromMs, toMs);
  const m: Record<string, number> = {};
  for (const v of vs) {
    const who = (v.vistoriador || "—").trim() || "—";
    m[who] = (m[who] ?? 0) + 1;
  }
  return m;
}

export async function countByLeilaoTotal(fromMs: number, toMs: number): Promise<Record<string, number>> {
  const leiloes = await getAllLeiloes();
  const active = (Array.isArray(leiloes) ? leiloes : []).filter((l) => !l.deleted && l.id != null);
  const m: Record<string, number> = {};
  for (const l of active) {
    const lid = l.id as number;
    const vs = await getVistoriasForLeilaoInRange(lid, fromMs, toMs);
    const nome = (l.nome || `Leilão ${lid}`).trim();
    m[nome] = vs.length;
  }
  return m;
}

async function vistoriaBelongsToLeilaoQueueItem(item: SyncQueueItem, leilaoId: number): Promise<boolean> {
  const p = item.payload as { localVistoriaId?: number };
  const vid = p.localVistoriaId;
  if (vid == null) return false;
  const list = await getVistoriasByLeilao(leilaoId);
  return list.some((v) => v.id === vid);
}

function isQueueItemPermanentFailure(item: SyncQueueItem): boolean {
  if (item.status === "failed") return true;
  if (item.failed === true) return true;
  if ((item.retries ?? 0) >= QUEUE_MAX_RETRIES) return true;
  return false;
}

function isQueueItemActionable(item: SyncQueueItem, now: number): boolean {
  if (isQueueItemPermanentFailure(item)) return false;
  if (item.retryPaused) return false;
  if (item.nextAttemptAfter != null && item.nextAttemptAfter > now) return false;
  return true;
}

export async function countPendingQueueForLeilao(leilaoId: number): Promise<number> {
  const q = await getQueue();
  const now = Date.now();
  let n = 0;
  for (const item of q) {
    if (item.entity !== "vistoria") continue;
    if (item.status === "failed" || item.failed) continue;
    if (item.retryPaused) continue;
    if (item.nextAttemptAfter != null && item.nextAttemptAfter > now) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await vistoriaBelongsToLeilaoQueueItem(item, leilaoId);
    if (ok) n += 1;
  }
  return n;
}

export async function countFailedQueueForLeilao(leilaoId: number): Promise<number> {
  const q = await getQueue();
  let n = 0;
  for (const item of q) {
    if (item.entity !== "vistoria") continue;
    const failed = item.status === "failed" || item.failed || (item.retries ?? 0) >= 5;
    if (!failed) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await vistoriaBelongsToLeilaoQueueItem(item, leilaoId);
    if (ok) n += 1;
  }
  return n;
}

export async function dashboardCountsForLeilao(leilaoId: number) {
  const now = Date.now();
  const startToday = startOfLocalDay(new Date());
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const all = await getVistoriasByLeilao(leilaoId);
  const today = all.filter((v) => new Date(v.createdAt).getTime() >= startToday).length;
  const week = all.filter((v) => new Date(v.createdAt).getTime() >= weekAgo).length;
  const total = all.length;
  const synced = all.filter((v) => normalizeVistoriaStatusSync(v.statusSync) === "sincronizado").length;
  const conflito = all.filter((v) => {
    const n = normalizeVistoriaStatusSync(v.statusSync);
    return n === "conflito_duplicidade" || n === "aguardando_ajuste";
  }).length;
  const erro = all.filter((v) => normalizeVistoriaStatusSync(v.statusSync) === "erro_sync").length;
  const fotoFalha = all.filter((v) => v.fotoUploadFailed).length;
  const pendingQueue = await countPendingQueueForLeilao(leilaoId);
  const failedQueue = await countFailedQueueForLeilao(leilaoId);

  const byV = await countByVistoriador(leilaoId, 0, now);
  const topVistoriador = Object.entries(byV).sort((a, b) => b[1] - a[1])[0];

  const byL = await countByLeilaoTotal(0, now);
  const topLeilao = Object.entries(byL).sort((a, b) => b[1] - a[1])[0];

  const daysWithData = new Set(all.map((v) => formatDayKey(startOfLocalDay(new Date(v.createdAt))))).size;
  const numDays = Math.max(1, daysWithData || 1);
  const mediaDiaria = total / numDays;

  const byDayTotal: Record<string, number> = {};
  for (const v of all) {
    const d = formatDayKey(startOfLocalDay(new Date(v.createdAt)));
    byDayTotal[d] = (byDayTotal[d] ?? 0) + 1;
  }
  const pico = Math.max(0, ...Object.values(byDayTotal));

  const taxaSync = total > 0 ? Math.round((synced / total) * 100) : 100;

  return {
    today,
    week,
    total,
    synced,
    conflito,
    erro,
    fotoFalha,
    pendingQueue,
    failedQueue,
    taxaSync,
    topVistoriador: topVistoriador?.[0] ?? "—",
    topVistoriadorCount: topVistoriador?.[1] ?? 0,
    topLeilao: topLeilao?.[0] ?? "—",
    topLeilaoCount: topLeilao?.[1] ?? 0,
    mediaDiaria: Math.round(mediaDiaria * 10) / 10,
    pico,
  };
}

export type AttentionReason =
  | "erro_sync"
  | "conflito_duplicidade"
  | "aguardando_ajuste"
  | "foto_falhou"
  | "pendente_sync"
  | "fila_com_falha";

export type AttentionListItem = {
  vistoriaId: number;
  placa: string;
  numeroVistoria: string;
  vistoriador?: string;
  reasons: AttentionReason[];
  syncMessage?: string;
};

function reasonPriority(r: AttentionReason): number {
  if (r === "conflito_duplicidade" || r === "aguardando_ajuste") return 0;
  if (r === "erro_sync" || r === "fila_com_falha") return 1;
  if (r === "foto_falhou") return 2;
  return 3;
}

/** Vistorias que precisam de ação (erro, conflito, foto, fila ou ainda pendentes de envio). */
export async function listAttentionItems(leilaoId: number): Promise<AttentionListItem[]> {
  const vs = await getVistoriasByLeilao(leilaoId);
  const q = await getQueue();
  const now = Date.now();
  const actionableVids = new Set<number>();
  const failedVids = new Set<number>();
  for (const item of q) {
    if (item.entity !== "vistoria") continue;
    const vid = (item.payload as { localVistoriaId?: number }).localVistoriaId;
    if (vid == null) continue;
    if (!vs.some((v) => v.id === vid)) continue;
    if (isQueueItemPermanentFailure(item)) failedVids.add(vid);
    else if (isQueueItemActionable(item, now)) actionableVids.add(vid);
  }

  const out: AttentionListItem[] = [];
  for (const v of vs) {
    if (v.id == null) continue;
    const st = normalizeVistoriaStatusSync(v.statusSync);
    const reasons = new Set<AttentionReason>();
    if (st === "erro_sync") reasons.add("erro_sync");
    if (st === "conflito_duplicidade") reasons.add("conflito_duplicidade");
    if (st === "aguardando_ajuste") reasons.add("aguardando_ajuste");
    if (v.fotoUploadFailed) reasons.add("foto_falhou");
    if (st === "pendente_sync") reasons.add("pendente_sync");
    if (actionableVids.has(v.id)) reasons.add("pendente_sync");
    if (failedVids.has(v.id)) reasons.add("fila_com_falha");
    if (reasons.size === 0) continue;
    out.push({
      vistoriaId: v.id,
      placa: v.placa,
      numeroVistoria: v.numeroVistoria,
      vistoriador: v.vistoriador,
      reasons: [...reasons],
      syncMessage: v.syncMessage,
    });
  }
  out.sort(
    (a, b) =>
      Math.min(...a.reasons.map(reasonPriority)) - Math.min(...b.reasons.map(reasonPriority)),
  );
  return out;
}

/** Métricas extras respeitando o intervalo do gráfico (fromMs..toMs). */
export async function periodMetricsForLeilao(leilaoId: number, fromMs: number, toMs: number) {
  const vs = await getVistoriasForLeilaoInRange(leilaoId, fromMs, toMs);
  const total = vs.length;
  const byDay: Record<string, number> = {};
  for (const v of vs) {
    const d = formatDayKey(startOfLocalDay(new Date(v.createdAt)));
    byDay[d] = (byDay[d] ?? 0) + 1;
  }
  const pico = total === 0 ? 0 : Math.max(...Object.values(byDay));
  const spanDays =
    fromMs <= 0
      ? Math.max(1, Object.keys(byDay).length || 1)
      : Math.max(1, Math.ceil((toMs - fromMs) / (24 * 60 * 60 * 1000)));
  const mediaDiaria = Math.round((total / spanDays) * 10) / 10;
  const byV: Record<string, number> = {};
  for (const v of vs) {
    const who = (v.vistoriador || "—").trim() || "—";
    byV[who] = (byV[who] ?? 0) + 1;
  }
  const topV = Object.entries(byV).sort((a, b) => b[1] - a[1])[0];
  const byL = await countByLeilaoTotal(fromMs, toMs);
  const topL = Object.entries(byL).sort((a, b) => b[1] - a[1])[0];
  const synced = vs.filter((v) => normalizeVistoriaStatusSync(v.statusSync) === "sincronizado").length;
  const taxaSync = total > 0 ? Math.round((synced / total) * 100) : 100;
  return {
    taxaSync,
    topVistoriador: topV?.[0] ?? "—",
    topVistoriadorCount: topV?.[1] ?? 0,
    topLeilao: topL?.[0] ?? "—",
    topLeilaoCount: topL?.[1] ?? 0,
    mediaDiaria,
    pico,
  };
}
