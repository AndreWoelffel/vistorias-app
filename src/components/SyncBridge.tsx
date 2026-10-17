import { useEffect } from 'react';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { processQueue } from '@/services/syncService';
import { ensureRealtimeStarted, stopRealtimeSync } from '@/services/realtimeService';
import { guardarModelosNoAparelho } from '@/lib/modelosOffline';
import { VERSAO_APP } from '@/lib/pwaUpdate';

/** Com sinal fraco o evento `online` quase nunca dispara; a fila é conferida sozinha. */
const INTERVALO_FILA_MS = 30_000;

/** Ao voltar online, ao reabrir o app e a cada 30 s, drena a fila de sincronização. */
export function SyncBridge() {
  const online = useOnlineStatus();

  useEffect(() => {
    ensureRealtimeStarted();
    return () => stopRealtimeSync();
  }, []);

  useEffect(() => {
    // Sem isso o Android pode apagar o banco local quando falta espaço,
    // levando vistorias que ainda não subiram.
    void navigator.storage?.persist?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!online) return;
    void processQueue();
    if (import.meta.env.PROD) void guardarModelosNoAparelho(VERSAO_APP);
  }, [online]);

  useEffect(() => {
    const tentar = () => {
      if (document.visibilityState === 'visible') void processQueue();
    };
    const id = window.setInterval(tentar, INTERVALO_FILA_MS);
    document.addEventListener('visibilitychange', tentar);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tentar);
    };
  }, []);

  return null;
}
