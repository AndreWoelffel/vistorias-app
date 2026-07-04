-- Policies do bucket fotos-vistorias para o novo layout {leilao_id}/{vistoria_id}/{tipo}_{ordem}.jpg
-- Substitui restrições antigas que permitiam só uploads em placas/*

-- SELECT (URLs públicas / listagem)
DROP POLICY IF EXISTS "fotos_vistorias_select" ON storage.objects;
CREATE POLICY "fotos_vistorias_select"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'fotos-vistorias');

-- INSERT (upload pelo app de vistoria)
DROP POLICY IF EXISTS "fotos_vistorias_insert" ON storage.objects;
CREATE POLICY "fotos_vistorias_insert"
  ON storage.objects FOR INSERT
  TO anon, authenticated
  WITH CHECK (bucket_id = 'fotos-vistorias');

-- UPDATE (upsert: true)
DROP POLICY IF EXISTS "fotos_vistorias_update" ON storage.objects;
CREATE POLICY "fotos_vistorias_update"
  ON storage.objects FOR UPDATE
  TO anon, authenticated
  USING (bucket_id = 'fotos-vistorias')
  WITH CHECK (bucket_id = 'fotos-vistorias');

-- DELETE (exclusão antes de apagar vistoria)
DROP POLICY IF EXISTS "fotos_vistorias_delete" ON storage.objects;
CREATE POLICY "fotos_vistorias_delete"
  ON storage.objects FOR DELETE
  TO anon, authenticated
  USING (bucket_id = 'fotos-vistorias');
