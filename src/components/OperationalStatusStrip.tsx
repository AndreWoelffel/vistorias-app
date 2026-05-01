import { Loader2, AlertTriangle, CloudOff, CloudUpload } from 'lucide-react';
import { cn } from '@/lib/utils';

interface OperationalStatusStripProps {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  failedCount: number;
  className?: string;
}

export function OperationalStatusStrip({
  online,
  syncing,
  pendingCount,
  failedCount,
  className,
}: OperationalStatusStripProps) {
  
  // 1. Sem conexão
  if (!online) {
    return (
      <div className={cn("flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[11px] font-bold text-destructive shadow-sm", className)}>
        <CloudOff className="h-3.5 w-3.5" />
        <span>Offline</span>
      </div>
    );
  }

  // 2. Erros críticos na fila
  if (failedCount > 0) {
    return (
      <div className={cn("flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] font-bold text-red-600 dark:text-red-400 shadow-sm", className)}>
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>{failedCount} erro(s)</span>
      </div>
    );
  }

  // 3. Sistema trabalhando agora
  if (syncing) {
    return (
      <div className={cn("flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-[11px] font-bold text-blue-600 dark:text-blue-400 shadow-sm", className)}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Sincronizando...</span>
      </div>
    );
  }

  // 4. Conectado, mas com fila pendente
  if (pendingCount > 0) {
    return (
      <div className={cn("flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold text-amber-600 dark:text-amber-400 shadow-sm", className)}>
        <CloudUpload className="h-3.5 w-3.5" />
        <span>{pendingCount} na fila</span>
      </div>
    );
  }

  // 5. Estado Ideal: Conectado e fila limpa
  return (
    <div className={cn("flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-400 shadow-sm transition-all", className)}>
      <div className="relative flex h-2.5 w-2.5 items-center justify-center">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
      </div>
      <span className="tracking-wide">Online</span>
    </div>
  );
}