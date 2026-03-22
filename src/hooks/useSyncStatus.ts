import { useState, useEffect, useCallback } from 'react';
import {
  getSyncQueueCounts,
  subscribeSyncUi,
  isSyncProcessing,
} from '@/services/syncService';

export function useSyncStatus() {
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    setSyncing(isSyncProcessing());
    try {
      const { pending, failed } = await getSyncQueueCounts();
      setPendingCount(pending);
      setFailedCount(failed);
    } catch {
      setPendingCount(0);
      setFailedCount(0);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsub = subscribeSyncUi(() => {
      setSyncing(isSyncProcessing());
      void getSyncQueueCounts()
        .then(({ pending, failed }) => {
          setPendingCount(pending);
          setFailedCount(failed);
        })
        .catch(() => {
          setPendingCount(0);
          setFailedCount(0);
        });
    });
    const id = window.setInterval(() => void refresh(), 4000);
    return () => {
      unsub();
      window.clearInterval(id);
    };
  }, [refresh]);

  return { pendingCount, failedCount, syncing, refresh };
}
