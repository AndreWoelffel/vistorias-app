-- Fotos tipadas por vistoria (consulta por placa / número via view).
-- URL pública: gerar no cliente a partir de storage_path + bucket fotos-vistorias.
-- Exclusão de arquivos no Storage: responsabilidade do app antes do DELETE em vistorias.

-- =============================================================================
-- 1) Enum de tipos
-- =============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vistoria_foto_tipo') THEN
    CREATE TYPE public.vistoria_foto_tipo AS ENUM (
      'placa',
      'adesivo',
      'chassi',
      'motor',
      'geral'
    );
  END IF;
END $$;

-- =============================================================================
-- 2) Tabela vistorias_fotos
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.vistorias_fotos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vistoria_id      uuid NOT NULL REFERENCES public.vistorias(id) ON DELETE CASCADE,
  tipo             public.vistoria_foto_tipo NOT NULL,
  ordem            smallint NOT NULL DEFAULT 0,
  storage_path     text NOT NULL,
  arquivo_original text NOT NULL,
  mime_type        text NOT NULL DEFAULT 'image/jpeg',
  tamanho          bigint NOT NULL CHECK (tamanho >= 0),
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  sha256           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vistorias_fotos_vistoria_tipo_ordem_unique UNIQUE (vistoria_id, tipo, ordem)
);

CREATE INDEX IF NOT EXISTS idx_vistorias_fotos_vistoria_tipo
  ON public.vistorias_fotos (vistoria_id, tipo);

CREATE INDEX IF NOT EXISTS idx_vistorias_fotos_tipo
  ON public.vistorias_fotos (tipo);

CREATE INDEX IF NOT EXISTS idx_vistorias_fotos_vistoria_id
  ON public.vistorias_fotos (vistoria_id);

-- =============================================================================
-- 3) View para consulta externa (placa, número, leilão)
-- =============================================================================
CREATE OR REPLACE VIEW public.vistorias_fotos_com_leilao AS
SELECT
  vf.id,
  vf.vistoria_id,
  vf.tipo,
  vf.ordem,
  vf.storage_path,
  vf.arquivo_original,
  vf.mime_type,
  vf.tamanho,
  vf.uploaded_at,
  vf.sha256,
  vf.created_at,
  v.placa,
  v.num_vistoria,
  v.external_id AS vistoria_external_id,
  vl.leilao_id
FROM public.vistorias_fotos vf
JOIN public.vistorias v ON v.id = vf.vistoria_id
JOIN public.vistorias_leiloes vl ON vl.vistoria_id = v.id;

-- =============================================================================
-- 4) RLS (se ativo no projeto)
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'vistorias_fotos' AND c.relrowsecurity
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS vistorias_fotos_select ON public.vistorias_fotos';
    EXECUTE 'DROP POLICY IF EXISTS vistorias_fotos_insert ON public.vistorias_fotos';
    EXECUTE 'DROP POLICY IF EXISTS vistorias_fotos_update ON public.vistorias_fotos';
    EXECUTE 'DROP POLICY IF EXISTS vistorias_fotos_delete ON public.vistorias_fotos';

    EXECUTE $p$
      CREATE POLICY vistorias_fotos_select ON public.vistorias_fotos
      FOR SELECT TO anon, authenticated USING (true)
    $p$;
    EXECUTE $p$
      CREATE POLICY vistorias_fotos_insert ON public.vistorias_fotos
      FOR INSERT TO anon, authenticated WITH CHECK (true)
    $p$;
    EXECUTE $p$
      CREATE POLICY vistorias_fotos_update ON public.vistorias_fotos
      FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true)
    $p$;
    EXECUTE $p$
      CREATE POLICY vistorias_fotos_delete ON public.vistorias_fotos
      FOR DELETE TO anon, authenticated USING (true)
    $p$;
  ELSIF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'vistorias' AND c.relrowsecurity
  ) THEN
    ALTER TABLE public.vistorias_fotos ENABLE ROW LEVEL SECURITY;

    EXECUTE $p$
      CREATE POLICY vistorias_fotos_select ON public.vistorias_fotos
      FOR SELECT TO anon, authenticated USING (true)
    $p$;
    EXECUTE $p$
      CREATE POLICY vistorias_fotos_insert ON public.vistorias_fotos
      FOR INSERT TO anon, authenticated WITH CHECK (true)
    $p$;
    EXECUTE $p$
      CREATE POLICY vistorias_fotos_update ON public.vistorias_fotos
      FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true)
    $p$;
    EXECUTE $p$
      CREATE POLICY vistorias_fotos_delete ON public.vistorias_fotos
      FOR DELETE TO anon, authenticated USING (true)
    $p$;
  END IF;
END $$;
