import { useEffect } from 'react';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { processQueue } from '@/services/syncService';
import { ensureRealtimeStarted, stopRealtimeSync } from '@/services/realtimeService';

/** Ao voltar online, drena a fila de sincronização. */
export function SyncBridge() {
  const online = useOnlineStatus();

  useEffect(() => {
    ensureRealtimeStarted();
    return () => stopRealtimeSync();
  }, []);

  useEffect(() => {
    if (!online) return;
    void processQueue();
  }, [online]);

  return null;
}
