import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, Loader2, Pencil, RefreshCw } from "lucide-react";
import { aplicarAtualizacao, useAtualizacaoPronta } from "@/lib/pwaUpdate";
import { Button } from "@/components/ui/button";
import { useAutoSyncLeilaoOnEnter } from "@/hooks/useAutoSyncLeilaoOnEnter";
import { useSyncStatus } from "@/hooks/useSyncStatus";
import { toast } from "@/hooks/use-toast";
import {
  getLeilaoHubSnapshot,
  type LeilaoHubSnapshot,
  type LeilaoSyncQueueEntry,
} from "@/lib/dashboardAggregates";
import {
  getRascunho,
  isVistoriaSyncBlockedByDuplicate,
  normalizeVistoriaStatusSync,
  type RascunhoVistoria,
} from "@/lib/db";
import { duplicateTypeShortLabel } from "@/services/inspectionService";
import { enviarTudoAgora, retryVistoriaFromHub, subscribeSyncUi } from "@/services/syncService";
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
  return (
    isVistoriaSyncBlockedByDuplicate(entry.statusSync) ||
    normalizeVistoriaStatusSync(entry.statusSync) === "aguardando_ajuste"
  );
}

function canRetrySync(entry: LeilaoSyncQueueEntry): boolean {
  if (isVistoriaSyncBlockedByDuplicate(entry.statusSync)) return false;
  const st = normalizeVistoriaStatusSync(entry.statusSync);
  if (st === "aguardando_ajuste") return false;
  return entry.queueFailed || st === "erro_sync" || entry.fotoUploadFailed === true;
}

function VistoriaCard({
  entry,
  onEdit,
  onRetry,
  retryingId,
  variant = "default",
}: {
  entry: LeilaoSyncQueueEntry;
  onEdit: (id: number) => void;
  onRetry: (id: number) => void;
  retryingId: number | null;
  variant?: "default" | "duplicate";
}) {
  const hint = statusHint(entry);
  const showEdit = needsEdit(entry);
  const showRetry = canRetrySync(entry);
  const isDup = isVistoriaSyncBlockedByDuplicate(entry.statusSync);
  const isRetrying = retryingId === entry.vistoriaId;

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
            {formatShortTime(entry.createdAtTs)}
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

      {(showRetry || showEdit) && (
        <div className="mt-3 flex flex-col gap-2">
          {showRetry && (
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-9 w-full rounded-lg text-xs font-bold gap-1.5"
              disabled={isRetrying}
              onClick={() => onRetry(entry.vistoriaId)}
            >
              {isRetrying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Tentar novamente
            </Button>
          )}
          {showEdit && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 w-full rounded-lg text-xs font-bold gap-1.5 border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-300"
              onClick={() => onEdit(entry.vistoriaId)}
            >
              <Pencil className="h-3.5 w-3.5" />
              Editar vistoria
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function HubSyncQueue({ leilaoId }: Props) {
  const navigate = useNavigate();
  const { pendingCount, syncing } = useSyncStatus();
  const atualizacaoPronta = useAtualizacaoPronta();
  const [snapshot, setSnapshot] = useState<LeilaoHubSnapshot>({
    latest: null,
    duplicates: [],
    aEnviar: 0,
    comErro: 0,
  });
  const [rascunho, setRascunho] = useState<RascunhoVistoria | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [enviando, setEnviando] = useState(false);

  const load = useCallback(async () => {
    try {
      const { recalculateDuplicateVistoriasForLeilao } = await import(
        "@/services/duplicateVistoriaRecalc",
      );
      await recalculateDuplicateVistoriasForLeilao(leilaoId);
      setSnapshot(await getLeilaoHubSnapshot(leilaoId));
      setRascunho((await getRascunho(leilaoId).catch(() => undefined)) ?? null);
    } catch (e) {
      console.error("[HubSyncQueue]", e);
      setSnapshot({ latest: null, duplicates: [], aEnviar: 0, comErro: 0 });
    } finally {
      setLoading(false);
    }
  }, [leilaoId]);

  const handleEnviarAgora = useCallback(async () => {
    setEnviando(true);
    try {
      const r = await enviarTudoAgora(leilaoId);
      if (!r.ok) {
        const offline = "offline" in r && r.offline;
        toast({
          title: offline ? "Sem internet" : "Ainda não enviou",
          description: offline
            ? "As vistorias ficam guardadas e sobem sozinhas quando o sinal voltar."
            : "O app continua tentando sozinho.",
          variant: "destructive",
        });
      }
      await load();
    } finally {
      setEnviando(false);
    }
  }, [leilaoId, load]);

  useAutoSyncLeilaoOnEnter(leilaoId, true, load);

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

  const { latest, duplicates, aEnviar, comErro } = snapshot;
  const goEdit = (vid: number) => navigate(`/editar/${vid}`);

  const handleRetry = useCallback(async (vistoriaId: number) => {
    setRetryingId(vistoriaId);
    try {
      const result = await retryVistoriaFromHub(vistoriaId);
      if (result.ok) {
        toast({ title: "Reenvio iniciado", description: "Sincronizando em segundo plano." });
        void load();
      } else {
        const message = "message" in result ? result.message : undefined;
        toast({ title: "Não foi possível reenviar", description: message, variant: "destructive" });
      }
    } finally {
      setRetryingId(null);
    }
  }, [load]);

  return (
    <section className="flex min-h-0 flex-1 flex-col w-full max-w-md mx-auto px-4 gap-6">
      {atualizacaoPronta && !rascunho && (
        <div className="shrink-0 rounded-lg border border-primary/40 bg-primary/[0.06] px-4 py-3">
          <p className="text-sm text-foreground">
            <span className="font-bold">Nova versão do app.</span> Suas vistorias continuam guardadas.
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-3 h-9 w-full rounded-lg text-xs font-bold gap-1.5"
            onClick={aplicarAtualizacao}
          >
            <Download className="h-3.5 w-3.5" />
            Atualizar agora
          </Button>
        </div>
      )}

      {rascunho && (
        <div className="shrink-0 rounded-lg border border-primary/40 bg-primary/[0.06] px-4 py-3">
          <p className="text-sm font-bold text-foreground">Vistoria não concluída</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {rascunho.placa ? `Placa ${rascunho.placa}` : "Sem placa ainda"}
            {rascunho.numero ? ` · Nº ${rascunho.numero}` : ""} · {formatShortTime(rascunho.atualizadoEm)}
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-3 h-9 w-full rounded-lg text-xs font-bold"
            onClick={() => navigate(`/vistoria/${leilaoId}`)}
          >
            Continuar vistoria
          </Button>
        </div>
      )}

      {aEnviar > 0 && (
        <div
          className={cn(
            "shrink-0 rounded-lg border px-4 py-3",
            comErro > 0 ? "border-red-500/50 bg-red-500/[0.06]" : "border-amber-500/30 bg-amber-500/[0.04]",
          )}
        >
          <p className="text-sm font-bold text-foreground">
            {aEnviar === 1 ? "1 vistoria aguardando envio" : `${aEnviar} vistorias aguardando envio`}
            {comErro > 0 ? ` · ${comErro} com erro` : ""}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Estão guardadas no celular e sobem sozinhas quando houver sinal.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 h-9 w-full rounded-lg text-xs font-bold gap-1.5"
            disabled={enviando || syncing}
            onClick={() => void handleEnviarAgora()}
          >
            {enviando || syncing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Enviar agora
          </Button>
        </div>
      )}

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
            <VistoriaCard entry={latest} onEdit={goEdit} onRetry={handleRetry} retryingId={retryingId} />
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
                onRetry={handleRetry}
                retryingId={retryingId}
                variant="duplicate"
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
