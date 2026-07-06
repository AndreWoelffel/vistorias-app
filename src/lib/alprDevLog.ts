/** Logs de inferência ALPR — silenciados em produção. */
export function alprDevLog(...args: unknown[]): void {
  if (import.meta.env.DEV) {
    console.log(...args);
  }
}
