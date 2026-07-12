/** Valor gravado quando o veículo não possui placa. */
export const PLACA_SEM_PLACA = 'SEM PLACA';

/** Chave normalizada (sem espaços) usada em comparações. */
export const PLACA_SEM_PLACA_KEY = 'SEMPLACA';

export function normalizePlacaKey(placa: string): string {
  return placa.trim().toUpperCase().replace(/\s+/g, '');
}

/** true se a placa representa veículo sem placa. */
export function isSemPlaca(placa: string | null | undefined): boolean {
  if (placa == null) return false;
  return normalizePlacaKey(placa) === PLACA_SEM_PLACA_KEY;
}
