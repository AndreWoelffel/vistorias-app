/** Sessão após login em `public.usuarios` (Supabase). Não armazenar senha/PIN. */
export interface AuthUser {
  /** PK em `public.usuarios` (UUID). */
  id: string;
  nome: string;
  role: 'vistoriador' | 'admin';
}
