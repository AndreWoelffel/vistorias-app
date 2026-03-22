import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SyncStatusVariant = 'synced' | 'pending' | 'error' | 'offline';

export function getSyncStatusVariant(
  online: boolean,
  syncing: boolean,
  pendingCount: number,
  failedCount: number,
): SyncStatusVariant {
  if (!online) return 'offline';
  if (failedCount > 0) return 'error';
  if (syncing || pendingCount > 0) return 'pending';
  return 'synced';
}

type Props = {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  failedCount: number;
  /** Mostrar número ao lado do ponto (falhas / pendentes) */
  showCounts?: boolean;
  className?: string;
};

/**
 * Indicador: verde = sincronizado, amarelo = pendente/sincronizando, vermelho = erro na fila.
 */
export function SyncStatusIndicator({
  online,
  syncing,
  pendingCount,
  failedCount,
  showCounts = true,
  className,
}: Props) {
  const variant = getSyncStatusVariant(online, syncing, pendingCount, failedCount);

  const dotClass =
    variant === 'error'
      ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]'
      : variant === 'pending'
        ? 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]'
        : variant === 'synced'
          ? 'bg-emerald-500 shadow-[0_0_6px_rgba(34,197,94,0.45)]'
          : 'bg-muted-foreground/50';

  const label =
    variant === 'error'
      ? 'Erro na sincronização'
      : variant === 'pending'
        ? syncing
          ? 'Sincronizando…'
          : 'Pendente'
        : variant === 'synced'
          ? 'Sincronizado'
          : 'Offline';

  return (
    <div
      className={cn('inline-flex items-center gap-1.5 text-[10px] font-medium', className)}
      title={
        failedCount > 0
          ? `${failedCount} ${failedCount === 1 ? 'item com erro' : 'itens com erro'}`
          : pendingCount > 0
            ? `${pendingCount} ${pendingCount === 1 ? 'item pendente' : 'itens pendentes'}`
            : label
      }
    >
      {syncing && variant === 'pending' && (
        <RefreshCw className="h-3 w-3 shrink-0 animate-spin text-amber-500" aria-hidden />
      )}
      <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', dotClass)} aria-hidden />
      <span
        className={cn(
          'truncate',
          variant === 'error' && 'text-red-600 dark:text-red-400',
          variant === 'pending' && 'text-amber-600 dark:text-amber-400',
          variant === 'synced' && online && 'text-emerald-600 dark:text-emerald-400',
          variant === 'offline' && 'text-muted-foreground',
        )}
      >
        {label}
        {showCounts && variant === 'error' && failedCount > 0 && (
          <span className="ml-1 font-bold tabular-nums">({failedCount})</span>
        )}
        {showCounts && variant === 'pending' && !syncing && pendingCount > 0 && (
          <span className="ml-1 font-bold tabular-nums">({pendingCount})</span>
        )}
      </span>
    </div>
  );
}
