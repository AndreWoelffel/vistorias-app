/**
 * MODO SIMPLES vs MODO COMPLETO
 * ─────────────────────────────
 *
 * SIMPLE_MODE = true  (atual)
 *   Login → Escolher leilão → Nova vistoria
 *   Sem dashboard, gráficos, histórico ou duplicidades.
 *
 * SIMPLE_MODE = false
 *   Restaura o fluxo completo com painel de métricas.
 *
 * Para voltar ao modo completo:
 *   1. Mude SIMPLE_MODE para false abaixo.
 *   2. Descomente as rotas marcadas "MODO COMPLETO" em App.tsx.
 *   3. Descomente as linhas marcadas "MODO COMPLETO" em Home.tsx e NewInspection.tsx.
 */
export const SIMPLE_MODE = true;

/** Rota após escolher leilão na Home (modo simples). */
export const leilaoEntryPath = (leilaoId: number) =>
  SIMPLE_MODE ? `/vistoria/${leilaoId}` : `/dashboard/${leilaoId}`;

/** Rota após salvar/cancelar vistoria. */
export const afterInspectionPath = (leilaoId: number) =>
  SIMPLE_MODE ? '/' : `/dashboard/${leilaoId}`;
