/**
 * Timestamps da nuvem (timestamptz ISO) ↔ ms locais para last-write-wins.
 */
export function supabaseTimestampToMs(value: string | null | undefined): number {
  if (value == null || value === '') return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

export function logSyncConflict(dados: Record<string, unknown>): void {
  if (import.meta.env.DEV) {
    console.warn("[sync] conflito detectado:", dados);
  }
}
