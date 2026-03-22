import { useEffect } from 'react';
import { toast } from '@/hooks/use-toast';
import { onSyncStart, onSyncSuccess, onSyncError } from '@/services/syncService';

/**
 * Toasts do ciclo de sincronização (montar uma vez na árvore raiz).
 */
export function SyncNotifications() {
  useEffect(() => {
    const unsubStart = onSyncStart(() => {
      toast({
        title: 'Sincronizando dados…',
        description: 'Enviando alterações para a nuvem.',
      });
    });

    const unsubSuccess = onSyncSuccess(() => {
      toast({
        title: 'Sincronização concluída',
        description: 'Os dados estão alinhados com o servidor.',
      });
    });

    const unsubError = onSyncError((detail) => {
      const n = detail.failed;
      toast({
        title: `Erro ao sincronizar ${n} ${n === 1 ? 'item' : 'itens'}`,
        description:
          detail.remainingFailed > 0
            ? `${detail.remainingFailed} ${detail.remainingFailed === 1 ? 'item permanece' : 'itens permanecem'} com falha na fila.`
            : undefined,
        variant: 'destructive',
      });
    });

    return () => {
      unsubStart();
      unsubSuccess();
      unsubError();
    };
  }, []);

  return null;
}
