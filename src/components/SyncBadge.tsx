import { AlertTriangle, CheckCircle2, CloudOff, Clock, FileEdit } from "lucide-react";
import { normalizeVistoriaStatusSync, type Vistoria } from "@/lib/db";
import { duplicateTypeShortLabel } from "@/services/inspectionService";
import { cn } from "@/lib/utils";

interface SyncBadgeProps {
  status: Vistoria["statusSync"];
  fotoUploadFailed?: boolean;
  duplicateType?: Vistoria["duplicateType"];
  className?: string;
}

/** Cores: verde enviado · amarelo pendente · laranja ajuste/duplicado · vermelho erro */
export function SyncBadge({ status, fotoUploadFailed, duplicateType, className }: SyncBadgeProps) {
  const n = normalizeVistoriaStatusSync(status);

  if (n === "aguardando_ajuste") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-orange-500/20 px-2.5 py-1 text-[11px] font-semibold text-orange-900 dark:text-orange-100",
          className,
        )}
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {duplicateType ? duplicateTypeShortLabel(duplicateType) : "Ajuste antes de enviar"}
      </span>
    );
  }

  if (n === "conflito_duplicidade") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-orange-500/20 px-2.5 py-1 text-[11px] font-semibold text-orange-900 dark:text-orange-100",
          className,
        )}
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {duplicateType ? duplicateTypeShortLabel(duplicateType) : "Duplicado. Ajuste antes de enviar"}
      </span>
    );
  }

  if (n === "erro_sync") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2.5 py-1 text-[11px] font-semibold text-red-800 dark:text-red-200",
          className,
        )}
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Erro ao enviar
      </span>
    );
  }

  if (fotoUploadFailed && n === "sincronizado") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-950 dark:text-amber-100",
          className,
        )}
      >
        <CloudOff className="h-3.5 w-3.5 shrink-0" />
        Foto não enviada
      </span>
    );
  }

  if (fotoUploadFailed) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-950 dark:text-amber-100",
          className,
        )}
      >
        <CloudOff className="h-3.5 w-3.5 shrink-0" />
        Foto não enviada
      </span>
    );
  }

  if (n === "sincronizado") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 dark:text-emerald-200",
          className,
        )}
      >
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        Enviado
      </span>
    );
  }

  if (n === "rascunho") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[11px] font-semibold text-muted-foreground",
          className,
        )}
      >
        <FileEdit className="h-3.5 w-3.5 shrink-0" />
        Rascunho
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-amber-400/25 px-2.5 py-1 text-[11px] font-semibold text-amber-950 dark:text-amber-50",
        className,
      )}
    >
      <Clock className="h-3.5 w-3.5 shrink-0" />
      Pendente
    </span>
  );
}
