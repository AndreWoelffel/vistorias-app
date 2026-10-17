/**
 * Versão nova do app instalado. O service worker novo fica esperando e só entra
 * quando o vistoriador toca em Atualizar na tela inicial: uma atualização nunca
 * recarrega a tela no meio de uma vistoria.
 */
import { useSyncExternalStore } from 'react';

type Aplicar = (recarregar?: boolean) => Promise<void>;

let aplicar: Aplicar | null = null;
let pronta = false;
const ouvintes = new Set<() => void>();

export function marcarAtualizacaoPronta(fn: Aplicar): void {
  aplicar = fn;
  pronta = true;
  ouvintes.forEach((cb) => cb());
}

export function aplicarAtualizacao(): void {
  void aplicar?.(true);
}

export function useAtualizacaoPronta(): boolean {
  return useSyncExternalStore(
    (cb) => {
      ouvintes.add(cb);
      return () => ouvintes.delete(cb);
    },
    () => pronta,
  );
}

export const VERSAO_APP = __APP_VERSION__;
