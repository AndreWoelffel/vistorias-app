-- Referência do schema esperado pelo app (você já criou manualmente no Table Editor).
-- Não execute este script se as tabelas já existem com outra definição.

-- Tabela public.leiloes (referência)
--   id int8 PK (identity/serial), nome text NOT NULL, created_at timestamptz default now()
--   updated_at timestamptz NOT NULL default now()  -- trigger BEFORE UPDATE atualiza (ver migrations/)
--   created_by text NULL  -- nome exibido (rastreabilidade); futuro: created_by_user_id uuid NULL
--   Policies: permitir INSERT/SELECT para anon (ou authenticated), conforme seu modelo.

-- Tabela public.vistorias (referência — nomes usados pelo inspectionService.ts)
--   id uuid PK default gen_random_uuid()
--   leilao int8 → FK para leiloes(id)  (não renomear para leilao_id sem migrar o app)
--   placa text
--   num_vistoria text
--   vistoriador text
--   url_foto text
--   baixado_pc bool
--   created_at timestamptz default now()
--   updated_at timestamptz NOT NULL default now()  -- trigger BEFORE UPDATE
--   created_by text NULL  -- nome exibido; futuro: created_by_user_id uuid NULL → auth.users
--   external_id text NULL  -- idempotência: copia de Vistoria.localUuid (crypto.randomUUID)
--   CONSTRAINT unique_external_id UNIQUE (external_id)  -- ou: ALTER TABLE ... ADD CONSTRAINT unique_external_id UNIQUE (external_id);
--   Ex.: ALTER TABLE public.vistorias ADD COLUMN IF NOT EXISTS external_id text;
--        ALTER TABLE public.vistorias ADD CONSTRAINT unique_external_id UNIQUE (external_id);
--   (Em PG, vários NULL ainda são permitidos em UNIQUE; linhas com external_id preenchido são únicas.)

-- Storage: bucket público "fotos-vistorias" (upload em placas/<arquivo>.jpg)

-- Tabela public.usuarios (login VistoriaPro — ver migrations/)
--   id uuid PK default gen_random_uuid() (ou bigint em versões antigas)
--   nome text UNIQUE NOT NULL, senha text NOT NULL (PIN 4 dígitos no app)
--   role text CHECK (role IN ('vistoriador','admin'))
