import { WifiOff } from "lucide-react";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { cn } from "@/lib/utils";

/**
 * Aviso não bloqueante quando não há rede. O app continua usando bundle em cache + IndexedDB.
 */
export function OfflineNotice({ className }: { className?: string }) {
  const online = useOnlineStatus();

  if (online) return null;

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-950 dark:text-amber-100",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span>
        Você está <strong>offline</strong>. Dados locais e a fila de sincronização continuam disponíveis; a nuvem sincroniza quando a
        conexão voltar.
      </span>
    </div>
  );
}
