import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { OperationalStatusStrip } from '@/components/OperationalStatusStrip';

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
      <h1 className="flex-1 text-base font-bold text-foreground truncate sm:text-lg">{title}</h1>
      <OperationalStatusStrip
        online={online}
        syncing={syncing}
        pendingCount={pendingCount}
        failedCount={failedCount}
        className="shrink-0 scale-95 origin-right sm:scale-100"
      />
    </header>
  );
}
