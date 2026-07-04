import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSyncStatus } from "@/hooks/useSyncStatus";
import {
  getLeilaoHubSnapshot,
  type LeilaoHubSnapshot,
  type LeilaoSyncQueueEntry,
} from "@/lib/dashboardAggregates";
import {
  isVistoriaSyncBlockedByDuplicate,
  normalizeVistoriaStatusSync,
} from "@/lib/db";
import { duplicateTypeShortLabel } from "@/services/inspectionService";
import { subscribeSyncUi } from "@/services/syncService";
import { subscribeRealtimeUi } from "@/services/realtimeService";
import { cn } from "@/lib/utils";

type Props = {
  leilaoId: number;
};

function formatShortTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return isToday ? `Hoje, ${time}` : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + ` · ${time}`;
}

function statusHint(entry: LeilaoSyncQueueEntry): { label: string; tone: "ok" | "wait" | "error" } {
  if (entry.queueFailed) return { label: "Falha ao enviar", tone: "error" };
  const st = normalizeVistoriaStatusSync(entry.statusSync);
  if (isVistoriaSyncBlockedByDuplicate(entry.statusSync)) {
    return { label: "Duplicidade", tone: "error" };
  }
  if (st === "erro_sync") return { label: "Erro ao enviar", tone: "error" };
  if (entry.fotoUploadFailed) return { label: "Foto pendente", tone: "error" };
  if (entry.inQueue || st === "pendente_sync") return { label: "Sincronizando…", tone: "wait" };
  if (st === "sincronizado") return { label: "Enviada", tone: "ok" };
  return { label: "Pendente", tone: "wait" };
}

function needsEdit(entry: LeilaoSyncQueueEntry): boolean {
  const st = normalizeVistoriaStatusSync(entry.statusSync);
  return (
    entry.queueFailed ||
    st === "erro_sync" ||
    isVistoriaSyncBlockedByDuplicate(entry.statusSync)
  );
}

function VistoriaCard({
  entry,
  onEdit,
  variant = "default",
}: {
  entry: LeilaoSyncQueueEntry;
  onEdit: (id: number) => void;
  variant?: "default" | "duplicate";
}) {
  const hint = statusHint(entry);
  const showEdit = needsEdit(entry);
  const isDup = isVistoriaSyncBlockedByDuplicate(entry.statusSync);

  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 transition-colors",
        (variant === "duplicate" || isDup || hint.tone === "error") &&
          "border-red-500/50 bg-red-500/[0.06] dark:bg-red-500/10",
        variant === "default" && hint.tone === "wait" &&
          "border-amber-500/30 bg-amber-500/[0.04]",
        variant === "default" && hint.tone === "ok" &&
          "border-border/60 bg-card/50",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-lg font-black tracking-widest text-foreground uppercase leading-tight">
            {entry.placa}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
            #{entry.numeroVistoria}
            <span className="mx-1.5 text-border">·</span>
            {formatShortTime(entry.sortTs)}
          </p>
          {entry.duplicateType && (
            <p className="text-[10px] font-semibold text-red-600 dark:text-red-400 mt-1">
              {duplicateTypeShortLabel(entry.duplicateType)}
            </p>
          )}
        </div>
        <span
          className={cn(
            "shrink-0 text-[10px] font-semibold uppercase tracking-wide pt-1",
            hint.tone === "ok" && "text-emerald-600 dark:text-emerald-400",
            hint.tone === "wait" && "text-amber-700 dark:text-amber-300",
            hint.tone === "error" && "text-red-600 dark:text-red-400",
          )}
        >
          {hint.label}
        </span>
      </div>

      {showEdit && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 h-9 w-full rounded-lg text-xs font-bold gap-1.5 border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-300"
          onClick={() => onEdit(entry.vistoriaId)}
        >
          <Pencil className="h-3.5 w-3.5" />
          Editar vistoria
        </Button>
      )}
    </div>
  );
}

export function HubSyncQueue({ leilaoId }: Props) {
  const navigate = useNavigate();
  const { pendingCount, syncing } = useSyncStatus();
  const [snapshot, setSnapshot] = useState<LeilaoHubSnapshot>({ latest: null, duplicates: [] });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { recalculateDuplicateVistoriasForLeilao } = await import(
        "@/services/duplicateVistoriaRecalc",
      );
      await recalculateDuplicateVistoriasForLeilao(leilaoId);
      setSnapshot(await getLeilaoHubSnapshot(leilaoId));
    } catch (e) {
      console.error("[HubSyncQueue]", e);
      setSnapshot({ latest: null, duplicates: [] });
    } finally {
      setLoading(false);
    }
  }, [leilaoId]);

  useEffect(() => {
    setLoading(true);
    void load();
    const unsubSync = subscribeSyncUi(() => {
      void load();
    });
    const unsubRt = subscribeRealtimeUi(() => {
      void load();
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubSync();
      unsubRt();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const { latest, duplicates } = snapshot;
  const goEdit = (id: number) => navigate(`/editar/${id}`);

  return (
    <section className="flex min-h-0 flex-1 flex-col w-full max-w-md mx-auto px-4 gap-6">
      {/* Última vistoria */}
      <div className="shrink-0">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
          Última vistoria
        </h3>
        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : latest ? (
          <>
            <VistoriaCard entry={latest} onEdit={goEdit} />
            {(pendingCount > 0 || syncing) && normalizeVistoriaStatusSync(latest.statusSync) !== "sincronizado" && (
              <p className="text-[10px] text-amber-700 dark:text-amber-300 mt-2 font-medium">
                {syncing ? "Sincronizando com a nuvem…" : `${pendingCount} item(ns) na fila`}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground py-6 text-center rounded-lg border border-dashed border-border/60">
            Nenhuma vistoria enviada neste leilão.
          </p>
        )}
      </div>

      {/* Duplicidades — só aparece se houver */}
      {duplicates.length > 0 && (
        <div className="shrink-0">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-red-600 dark:text-red-400 mb-2">
            Duplicidades ({duplicates.length})
          </h3>
          <div className="space-y-2">
            {duplicates.map((entry) => (
              <VistoriaCard
                key={entry.vistoriaId}
                entry={entry}
                onEdit={goEdit}
                variant="duplicate"
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
