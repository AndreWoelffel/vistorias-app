import { ArrowLeft, Wifi, WifiOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { SyncStatusIndicator } from '@/components/SyncStatusIndicator';

interface AppHeaderProps {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
}

export function AppHeader({ title, showBack = false, onBack }: AppHeaderProps) {
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const { pendingCount, failedCount, syncing } = useSyncStatus();

  const handleBack = () => {
    if (onBack) onBack();
    else navigate(-1);
  };

  return (
    <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-border bg-card/95 px-4 py-3 backdrop-blur-sm">
      {showBack && (
        <button onClick={handleBack} className="rounded-lg p-1.5 text-foreground/70 active:bg-secondary">
          <ArrowLeft className="h-6 w-6" />
        </button>
      )}
      <h1 className="flex-1 text-lg font-bold text-foreground truncate">{title}</h1>
      <div className="flex flex-col items-end gap-0.5 min-w-0">
        <div className="flex items-center gap-1.5 shrink-0">
          {online ? (
            <Wifi className="h-4 w-4 text-accent shrink-0" />
          ) : (
            <WifiOff className="h-4 w-4 text-destructive animate-pulse shrink-0" />
          )}
          <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
            {online ? 'Online' : 'Offline'}
          </span>
        </div>
        <SyncStatusIndicator
          online={online}
          syncing={syncing}
          pendingCount={pendingCount}
          failedCount={failedCount}
          showCounts
          className="max-w-[220px] justify-end"
        />
      </div>
    </header>
  );
}
