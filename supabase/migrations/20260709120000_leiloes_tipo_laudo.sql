-- Tipo de laudo por leilão (Command Center / Excel).
ALTER TABLE public.leiloes
  ADD COLUMN IF NOT EXISTS tipo_laudo text NOT NULL DEFAULT 'completo';

ALTER TABLE public.leiloes
  DROP CONSTRAINT IF EXISTS leiloes_tipo_laudo_check;

ALTER TABLE public.leiloes
  ADD CONSTRAINT leiloes_tipo_laudo_check
  CHECK (tipo_laudo IN ('completo', 'simplificado'));

COMMENT ON COLUMN public.leiloes.tipo_laudo IS
  'Modelo Excel: completo (conservados) ou simplificado (sucatas).';
