import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { syncLeilaoFromCloud } from '@/services/syncService';

/**
 * Sincroniza automaticamente ao entrar na tela (cada navegação = location.key novo).
 * Silencioso: não exibe toast; use onSynced para atualizar a UI local.
 */
export function useAutoSyncLeilaoOnEnter(
  leilaoId: number | null,
  enabled: boolean,
  onSynced?: () => void | Promise<void>,
): void {
  const location = useLocation();
  const online = useOnlineStatus();

  useEffect(() => {
    if (!enabled || leilaoId == null || !online) return;
    let cancelled = false;
    void (async () => {
      const result = await syncLeilaoFromCloud(leilaoId);
      if (cancelled || !result.ok) return;
      await onSynced?.();
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, leilaoId, location.key, online, onSynced]);
}
