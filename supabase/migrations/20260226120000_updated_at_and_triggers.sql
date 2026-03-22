-- updated_at + trigger (last-write-wins no app; coluna usada na resolução de conflitos)
-- Execute no SQL Editor do Supabase ou via CLI se usar migrações.

ALTER TABLE public.leiloes
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.leiloes
SET updated_at = COALESCE(created_at, now())
WHERE updated_at IS NULL;

ALTER TABLE public.leiloes
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE public.vistorias
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.vistorias
SET updated_at = COALESCE(created_at, now())
WHERE updated_at IS NULL;

ALTER TABLE public.vistorias
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_leiloes_updated_at ON public.leiloes;
CREATE TRIGGER set_leiloes_updated_at
  BEFORE UPDATE ON public.leiloes
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS set_vistorias_updated_at ON public.vistorias;
CREATE TRIGGER set_vistorias_updated_at
  BEFORE UPDATE ON public.vistorias
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at();
