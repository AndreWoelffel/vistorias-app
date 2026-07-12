/** Tipo de laudo Excel usado pelo GDL Command Center (por leilão). */
export type TipoLaudo = 'completo' | 'simplificado';

export function normalizeTipoLaudo(value: unknown): TipoLaudo {
  return value === 'simplificado' ? 'simplificado' : 'completo';
}

/** Rótulo curto para badges na UI. */
export function tipoLaudoBadgeLabel(tipo: TipoLaudo): string {
  return tipo === 'simplificado' ? 'Sucatas' : 'Conservados';
}

/** Rótulo do select (opção completa). */
export function tipoLaudoOptionLabel(tipo: TipoLaudo): string {
  return tipo === 'simplificado'
    ? 'Simplificado (sucatas)'
    : 'Completo (conservados)';
}

export const TIPO_LAUDO_OPTIONS: TipoLaudo[] = ['completo', 'simplificado'];
