-- Desativação lógica de usuários (login só se ativo = true).
ALTER TABLE public.usuarios
  ADD COLUMN IF NOT EXISTS ativo boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.usuarios.ativo IS 'false = usuário desativado; não pode fazer login.';
