import { AlertTriangle, Cloud, CloudOff, Clock, FileEdit } from "lucide-react";
import { normalizeVistoriaStatusSync, type Vistoria } from "@/lib/db";
import { cn } from "@/lib/utils";

interface SyncBadgeProps {
  status: Vistoria["statusSync"];
  fotoUploadFailed?: boolean;
  className?: string;
}

export function SyncBadge({ status, fotoUploadFailed, className }: SyncBadgeProps) {
  const n = normalizeVistoriaStatusSync(status);

  if (n === "conflito_duplicidade") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-900 dark:text-orange-200",
          className,
        )}
      >
        <AlertTriangle className="h-3 w-3 shrink-0" />
        Duplicidade
      </span>
    );
  }

  if (n === "erro_sync") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-800 dark:text-red-200",
          className,
        )}
      >
        <AlertTriangle className="h-3 w-3 shrink-0" />
        Erro sync
      </span>
    );
  }

  if (fotoUploadFailed) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold text-violet-800 dark:text-violet-200",
          className,
        )}
      >
        <CloudOff className="h-3 w-3 shrink-0" />
        Foto
      </span>
    );
  }

  if (n === "sincronizado") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:text-emerald-200",
          className,
        )}
      >
        <Cloud className="h-3 w-3 shrink-0" />
        Sincronizado
      </span>
    );
  }

  if (n === "rascunho") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground",
          className,
        )}
      >
        <FileEdit className="h-3 w-3 shrink-0" />
        Rascunho
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-900 dark:text-amber-200",
        className,
      )}
    >
      <Clock className="h-3 w-3 shrink-0" />
      Pendente
    </span>
  );
}
