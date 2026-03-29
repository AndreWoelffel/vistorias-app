import { RefreshCw, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { getSyncStatusVariant } from "@/components/SyncStatusIndicator";

type Props = {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  failedCount: number;
  className?: string;
};

/** Verde = enviado · Amarelo = pendente · Vermelho = erro · Cinza = sem internet */
export function OperationalStatusStrip({
  online,
  syncing,
  pendingCount,
  failedCount,
  className,
}: Props) {
  const variant = getSyncStatusVariant(online, syncing, pendingCount, failedCount);

  const dotClass =
    variant === "error"
      ? "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]"
      : variant === "pending"
        ? "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.45)]"
        : variant === "synced"
          ? "bg-emerald-500 shadow-[0_0_6px_rgba(34,197,94,0.4)]"
          : "bg-muted-foreground/60";

  let label = "Enviado";
  if (!online) label = "Sem internet";
  else if (variant === "error") label = "Erro ao sincronizar";
  else if (variant === "pending") label = syncing ? "Enviando…" : "Pendente";

  return (
    <div
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-full border border-border/80 bg-card/80 px-3 py-1.5 text-xs font-medium",
        className,
      )}
      role="status"
    >
      {!online && <WifiOff className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />}
      {online && syncing && variant === "pending" && (
        <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-400" aria-hidden />
      )}
      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dotClass)} aria-hidden />
      <span
        className={cn(
          variant === "error" && "text-red-600 dark:text-red-400",
          variant === "pending" && online && "text-amber-700 dark:text-amber-300",
          variant === "synced" && online && "text-emerald-700 dark:text-emerald-300",
          !online && "text-muted-foreground",
        )}
      >
        {label}
        {online && variant === "error" && failedCount > 0 && (
          <span className="ml-1 tabular-nums font-semibold">({failedCount})</span>
        )}
        {online && variant === "pending" && !syncing && pendingCount > 0 && (
          <span className="ml-1 tabular-nums font-semibold">({pendingCount})</span>
        )}
      </span>
    </div>
  );
}
