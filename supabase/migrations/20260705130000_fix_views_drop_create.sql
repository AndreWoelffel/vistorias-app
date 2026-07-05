-- Corrige erro 42P16 "cannot drop columns from view" ao recriar views.
-- Rode este arquivo se a catch-up 20260705120000 falhou na seção de views.
-- Idempotente.

DROP VIEW IF EXISTS public.vistorias_fotos_com_leilao CASCADE;
DROP VIEW IF EXISTS public.vistorias_com_leilao CASCADE;

CREATE VIEW public.vistorias_com_leilao AS
SELECT
  v.*,
  vl.leilao_id,
  vl.leilao_id AS leilao
FROM public.vistorias v
INNER JOIN public.vistorias_leiloes vl ON vl.vistoria_id = v.id;

CREATE VIEW public.vistorias_fotos_com_leilao AS
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

GRANT SELECT ON public.vistorias_com_leilao TO anon, authenticated;
GRANT SELECT ON public.vistorias_fotos_com_leilao TO anon, authenticated;
