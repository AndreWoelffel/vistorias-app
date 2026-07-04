/**
 * Configuração de modos do app
 * ─────────────────────────────
 *
 * SHOW_DASHBOARD_METRICS = false (atual)
 *   Hub do leilão: header + Nova vistoria + Histórico.
 *   Sem cards, gráficos Recharts nem métricas detalhadas.
 *
 * SHOW_DASHBOARD_METRICS = true
 *   Restaura painel completo com estatísticas e gráficos.
 *   (código preservado em Dashboard.tsx — basta mudar esta flag)
 */

/** Exibe cards, gráficos e métricas no painel do leilão. */
export const SHOW_DASHBOARD_METRICS = false;

/** Rota após escolher leilão na Home → hub do leilão. */
export const leilaoEntryPath = (leilaoId: number) => `/dashboard/${leilaoId}`;

/** Rota após salvar/cancelar vistoria → volta ao hub do mesmo leilão. */
export const afterInspectionPath = (leilaoId: number) => `/dashboard/${leilaoId}`;
