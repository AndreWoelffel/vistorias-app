# Supabase — checklist

## 1. Variáveis de ambiente (`.env`)

- `VITE_SUPABASE_URL` — URL do projeto  
- `VITE_SUPABASE_ANON_KEY` — chave **publicável** (`sb_publishable_...`) ou **anon** JWT (Settings → API). **Nunca** use `sb_secret_` no frontend — o Supabase bloqueia no browser.

O app usa **somente** o prefixo `VITE_` (sem `NEXT_PUBLIC_*`), para não misturar com variáveis do sistema.

Após alterar o `.env`: reinicie o `npm run dev` e limpe o cache do Vite: `Remove-Item -Recurse -Force node_modules\.vite` (PowerShell) ou `rm -rf node_modules/.vite`.

## 2. Tabelas (criadas manualmente)

- **`public.leiloes`** — `id` (int8 PK), `nome` (text), `created_at` (timestamptz), **`created_by`** (text, opcional — nome de quem criou, espelha o usuário atual do app).  
  - Futuro: coluna `created_by_user_id` (uuid) referenciando `auth.users` / `profiles`.
  - **Policies**: permitir `INSERT`, `SELECT`, **`UPDATE`** e **`DELETE`** em `public.leiloes` para `anon` (ou fluxo autenticado), para **Gerenciar Leilões** criar, editar nome, listar retorno do `insert` e excluir na nuvem.  
  - Sem `SELECT` após `INSERT`, o cliente pode não receber `id` (sincronização “silenciosa”).
- **`public.vistorias`** — `id` (uuid), `leilao` (int8, **FK → leiloes.id**), `placa`, `num_vistoria`, `vistoriador`, `url_foto`, `baixado_pc`, `created_at`, **`created_by`** (text, opcional), **`external_id`** (text, opcional, **UNIQUE** via constraint `unique_external_id` — idempotência; valor = `localUuid` do app).  
  - Futuro: `created_by_user_id` (uuid).
  - Migração sugerida:  
    `ALTER TABLE public.vistorias ADD COLUMN IF NOT EXISTS external_id text;`  
    `ALTER TABLE public.vistorias ADD CONSTRAINT unique_external_id UNIQUE (external_id);`  
    (Se a constraint já existir com outro nome, ajuste ou use `CREATE UNIQUE INDEX` equivalente.)

O app cria leilões pelo app (IndexedDB + insert em `leiloes`). O `id` usado na FK de `vistorias` é sempre o **id retornado pelo Supabase** (ou obtido após sincronizar um leilão criado sólocalmente). `saveInspection` **não** envia vistoria com FK inválida (evita erro de foreign key). Antes do `INSERT`, o app consulta `external_id`; se já existir, marca a vistoria local como sincronizada sem inserir de novo. Corridas raras são cobertas pelo conflito único (`23505`).

## 3. Storage — bucket **`fotos-vistorias`**

1. Bucket **público** com esse nome exato (hífen).  
2. **Policies**: permitir **upload** para `anon` ou `authenticated`, conforme seu modelo.

Arquivos são gravados em `placas/<placa>_<timestamp>.jpg`.

## 4. Fluxo no app

1. Usuário cadastra leilões em **Gerenciar Leilões** (`/leiloes`) e escolhe um na **Home**.  
2. Vistoria: salva no **IndexedDB** com `leilaoId` local.  
3. `saveInspection` → resolve o id do leilão na nuvem (`supabaseId` ou insert tardio em `leiloes`) → upload opcional da **primeira foto** + `insert` em `vistorias` com `leilao` válido.  
4. Sucesso → `statusSync: 'sincronizado'` no registro local.
