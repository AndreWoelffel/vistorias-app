-- Usuários do app (login por nome + senha PIN 4 dígitos).
-- Ajuste policies (RLS) conforme seu modelo de segurança.

-- PK: o app aceita `id` como string (UUID recomendado). Exemplo com uuid:
CREATE TABLE IF NOT EXISTS public.usuarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  senha text NOT NULL,
  role text NOT NULL CHECK (role IN ('vistoriador', 'admin')),
  created_at timestamptz DEFAULT now(),
  UNIQUE (nome)
);

-- Se você já criou com bigint, não recrie a tabela; o client normaliza id para string.

-- RLS (exemplo mínimo para o app com chave anon — ajuste em produção):
-- ALTER TABLE public.usuarios ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "usuarios_select" ON public.usuarios FOR SELECT TO anon USING (true);
-- CREATE POLICY "usuarios_insert" ON public.usuarios FOR INSERT TO anon WITH CHECK (true);
-- (Em produção prefira auth + políticas por role ou Edge Function.)

COMMENT ON TABLE public.usuarios IS 'Login VistoriaPro: nome + senha (4 dígitos), role vistoriador|admin';

-- Exemplo (ajuste nome/senha):
-- INSERT INTO public.usuarios (nome, senha, role) VALUES ('Administrador', '1234', 'admin');
-- INSERT INTO public.usuarios (nome, senha, role) VALUES ('João Silva', '5678', 'vistoriador');
