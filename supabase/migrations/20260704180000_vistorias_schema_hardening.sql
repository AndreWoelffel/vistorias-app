-- Endurecimento do schema vistorias / vistorias_leiloes (alinhado ao app offline-first).
-- Rode no SQL Editor do Supabase ou via: supabase db push
--
-- ANTES: faça backup ou teste em projeto de staging.
-- Se algum passo falhar por dados duplicados, veja os SELECTs de diagnóstico no final.

-- =============================================================================
-- 1) updated_at em timestamptz (conflitos last-write-wins no app)
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'vistorias'
      AND column_name = 'updated_at'
      AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE public.vistorias
      ALTER COLUMN updated_at TYPE timestamptz
      USING updated_at AT TIME ZONE 'UTC';
  END IF;
END $$;

ALTER TABLE public.vistorias
  ALTER COLUMN updated_at SET DEFAULT now();

-- Unifica trigger com a migration 20260226120000 (substitui set_current_timestamp_updated_at se existir)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_vistorias_updated_at ON public.vistorias;
DROP TRIGGER IF EXISTS set_current_timestamp_updated_at ON public.vistorias;

CREATE TRIGGER set_vistorias_updated_at
  BEFORE UPDATE ON public.vistorias
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 2) Normalização (mesma regra do app: normPlaca / normNumVistoria)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.norm_placa(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT upper(regexp_replace(trim(COALESCE(t, '')), '\s+', '', 'g'));
$$;

CREATE OR REPLACE FUNCTION public.norm_num_vistoria(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT trim(COALESCE(t, ''));
$$;

-- =============================================================================
-- 3) UNIQUE (vistoria_id, leilao_id) em vistorias_leiloes
-- =============================================================================
DELETE FROM public.vistorias_leiloes
WHERE vistoria_id IS NULL OR leilao_id IS NULL;

DELETE FROM public.vistorias_leiloes a
USING public.vistorias_leiloes b
WHERE a.id > b.id
  AND a.vistoria_id = b.vistoria_id
  AND a.leilao_id = b.leilao_id;

CREATE UNIQUE INDEX IF NOT EXISTS vistorias_leiloes_vistoria_leilao_unique
  ON public.vistorias_leiloes (vistoria_id, leilao_id);

-- =============================================================================
-- 4) NOT NULL em FKs da tabela de vínculo
-- =============================================================================
ALTER TABLE public.vistorias_leiloes
  ALTER COLUMN vistoria_id SET NOT NULL,
  ALTER COLUMN leilao_id SET NOT NULL;

-- =============================================================================
-- 5) Duplicidade placa / num_vistoria POR leilão (reforço além do app)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.assert_vistoria_leilao_unique()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_vistoria_id uuid;
  v_leilao_id bigint;
  v_placa text;
  v_num text;
BEGIN
  IF TG_TABLE_NAME = 'vistorias_leiloes' THEN
    v_vistoria_id := NEW.vistoria_id;
    v_leilao_id := NEW.leilao_id;

    SELECT public.norm_placa(v.placa), public.norm_num_vistoria(v.num_vistoria)
    INTO v_placa, v_num
    FROM public.vistorias v
    WHERE v.id = v_vistoria_id;

    IF v_placa <> '' AND EXISTS (
      SELECT 1
      FROM public.vistorias_leiloes vl
      JOIN public.vistorias v ON v.id = vl.vistoria_id
      WHERE vl.leilao_id = v_leilao_id
        AND vl.vistoria_id IS DISTINCT FROM v_vistoria_id
        AND public.norm_placa(v.placa) = v_placa
    ) THEN
      RAISE EXCEPTION 'duplicate_placa_in_leilao'
        USING ERRCODE = '23505',
              DETAIL = format('placa=%s leilao_id=%s', v_placa, v_leilao_id);
    END IF;

    IF v_num <> '' AND EXISTS (
      SELECT 1
      FROM public.vistorias_leiloes vl
      JOIN public.vistorias v ON v.id = vl.vistoria_id
      WHERE vl.leilao_id = v_leilao_id
        AND vl.vistoria_id IS DISTINCT FROM v_vistoria_id
        AND public.norm_num_vistoria(v.num_vistoria) = v_num
    ) THEN
      RAISE EXCEPTION 'duplicate_num_in_leilao'
        USING ERRCODE = '23505',
              DETAIL = format('num_vistoria=%s leilao_id=%s', v_num, v_leilao_id);
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE em vistorias.placa / num_vistoria: revalida em cada leilão vinculado
  v_vistoria_id := NEW.id;
  v_placa := public.norm_placa(NEW.placa);
  v_num := public.norm_num_vistoria(NEW.num_vistoria);

  FOR v_leilao_id IN
    SELECT vl.leilao_id FROM public.vistorias_leiloes vl WHERE vl.vistoria_id = v_vistoria_id
  LOOP
    IF v_placa <> '' AND EXISTS (
      SELECT 1
      FROM public.vistorias_leiloes vl
      JOIN public.vistorias v ON v.id = vl.vistoria_id
      WHERE vl.leilao_id = v_leilao_id
        AND vl.vistoria_id IS DISTINCT FROM v_vistoria_id
        AND public.norm_placa(v.placa) = v_placa
    ) THEN
      RAISE EXCEPTION 'duplicate_placa_in_leilao'
        USING ERRCODE = '23505',
              DETAIL = format('placa=%s leilao_id=%s', v_placa, v_leilao_id);
    END IF;

    IF v_num <> '' AND EXISTS (
      SELECT 1
      FROM public.vistorias_leiloes vl
      JOIN public.vistorias v ON v.id = vl.vistoria_id
      WHERE vl.leilao_id = v_leilao_id
        AND vl.vistoria_id IS DISTINCT FROM v_vistoria_id
        AND public.norm_num_vistoria(v.num_vistoria) = v_num
    ) THEN
      RAISE EXCEPTION 'duplicate_num_in_leilao'
        USING ERRCODE = '23505',
              DETAIL = format('num_vistoria=%s leilao_id=%s', v_num, v_leilao_id);
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vistorias_leiloes_unique ON public.vistorias_leiloes;
CREATE TRIGGER trg_vistorias_leiloes_unique
  BEFORE INSERT OR UPDATE ON public.vistorias_leiloes
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_vistoria_leilao_unique();

DROP TRIGGER IF EXISTS trg_vistorias_placa_num_unique ON public.vistorias;
CREATE TRIGGER trg_vistorias_placa_num_unique
  AFTER UPDATE OF placa, num_vistoria ON public.vistorias
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_vistoria_leilao_unique();

-- =============================================================================
-- 6) Índices para pull histórico + checagem de duplicidade
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_vistorias_leiloes_leilao_id
  ON public.vistorias_leiloes (leilao_id);

CREATE INDEX IF NOT EXISTS idx_vistorias_created_at
  ON public.vistorias (created_at DESC);

-- =============================================================================
-- 7) RLS — DELETE (e demais) se RLS estiver ligado
--    Ajuste TO anon/authenticated conforme seu projeto.
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'vistorias' AND c.relrowsecurity
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS vistorias_select ON public.vistorias';
    EXECUTE 'DROP POLICY IF EXISTS vistorias_insert ON public.vistorias';
    EXECUTE 'DROP POLICY IF EXISTS vistorias_update ON public.vistorias';
    EXECUTE 'DROP POLICY IF EXISTS vistorias_delete ON public.vistorias';

    EXECUTE $p$
      CREATE POLICY vistorias_select ON public.vistorias
      FOR SELECT TO anon, authenticated USING (true)
    $p$;
    EXECUTE $p$
      CREATE POLICY vistorias_insert ON public.vistorias
      FOR INSERT TO anon, authenticated WITH CHECK (true)
    $p$;
    EXECUTE $p$
      CREATE POLICY vistorias_update ON public.vistorias
      FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true)
    $p$;
    EXECUTE $p$
      CREATE POLICY vistorias_delete ON public.vistorias
      FOR DELETE TO anon, authenticated USING (true)
    $p$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'vistorias_leiloes' AND c.relrowsecurity
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS vistorias_leiloes_select ON public.vistorias_leiloes';
    EXECUTE 'DROP POLICY IF EXISTS vistorias_leiloes_insert ON public.vistorias_leiloes';
    EXECUTE 'DROP POLICY IF EXISTS vistorias_leiloes_delete ON public.vistorias_leiloes';

    EXECUTE $p$
      CREATE POLICY vistorias_leiloes_select ON public.vistorias_leiloes
      FOR SELECT TO anon, authenticated USING (true)
    $p$;
    EXECUTE $p$
      CREATE POLICY vistorias_leiloes_insert ON public.vistorias_leiloes
      FOR INSERT TO anon, authenticated WITH CHECK (true)
    $p$;
    EXECUTE $p$
      CREATE POLICY vistorias_leiloes_delete ON public.vistorias_leiloes
      FOR DELETE TO anon, authenticated USING (true)
    $p$;
  END IF;
END $$;

-- =============================================================================
-- 8) Realtime — vistorias_leiloes (opcional; descomente se quiser sync ao vivo entre aparelhos)
-- =============================================================================
-- ALTER PUBLICATION supabase_realtime ADD TABLE public.vistorias_leiloes;

-- =============================================================================
-- Diagnóstico (rodar manualmente se a migration falhar)
-- =============================================================================
-- Placas duplicadas no mesmo leilão:
-- SELECT vl.leilao_id, public.norm_placa(v.placa) AS placa, count(*)
-- FROM vistorias_leiloes vl JOIN vistorias v ON v.id = vl.vistoria_id
-- GROUP BY 1, 2 HAVING count(*) > 1;
--
-- Números duplicados no mesmo leilão:
-- SELECT vl.leilao_id, public.norm_num_vistoria(v.num_vistoria) AS num, count(*)
-- FROM vistorias_leiloes vl JOIN vistorias v ON v.id = vl.vistoria_id
-- GROUP BY 1, 2 HAVING count(*) > 1;
--
-- RLS ativo?
-- SELECT relname, relrowsecurity FROM pg_class
-- WHERE relname IN ('vistorias','vistorias_leiloes','leiloes');
