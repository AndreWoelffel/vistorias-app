-- Leilão encerrado + índices para o volume do leilão de fim de ano.
-- Aplicar no SQL Editor do Supabase. Pode rodar de novo sem efeito colateral.

-- Leilão encerrado some da lista do celular; continua no Operador para laudos.
ALTER TABLE public.leiloes
  ADD COLUMN IF NOT EXISTS encerrado boolean NOT NULL DEFAULT false;

-- Fila do RPA e contagens por status no Operador.
CREATE INDEX IF NOT EXISTS idx_vistorias_status
  ON public.vistorias (status);

-- Gatilho de placa repetida no leilão (assert_vistoria_leilao_unique).
CREATE INDEX IF NOT EXISTS idx_vistorias_norm_placa
  ON public.vistorias (public.norm_placa(placa));

CREATE INDEX IF NOT EXISTS idx_vistorias_norm_num
  ON public.vistorias (public.norm_num_vistoria(num_vistoria));

-- Laudos Prontos ordena por updated_at.
CREATE INDEX IF NOT EXISTS idx_vistorias_updated_at
  ON public.vistorias (updated_at DESC);
