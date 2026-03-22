import { Cloud, CloudOff, Clock } from 'lucide-react';

interface SyncBadgeProps {
  status: 'pendente' | 'sincronizado';
}

export function SyncBadge({ status }: SyncBadgeProps) {
  if (status === 'sincronizado') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-xs font-semibold text-success">
        <Cloud className="h-3.5 w-3.5" />
        Sincronizado
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-semibold text-warning animate-pulse-glow">
      <Clock className="h-3.5 w-3.5" />
      Pendente
    </span>
  );
}
