# Deploy em produção (PWA / HTTPS)

## Build de produção (limpo)

- **Comando:** `npm run build`
- **Saída:** pasta `dist/`
- **Sourcemaps:** desligados em produção (`vite.config.ts`: `sourcemap: mode !== "production"`).
- **Plugin dev-only:** `lovable-tagger` e PWA `devOptions` não entram no bundle de produção de forma a quebrar o app.
- **Service Worker:** registrado só quando `import.meta.env.PROD` (`main.tsx`).

Variáveis são **injetidas no build**: alterar env no host exige **novo deploy** para o browser receber novos valores de `VITE_*`.

---

## Variáveis de ambiente (obrigatórias)

| Nome | Descrição |
|------|-----------|
| `VITE_SUPABASE_URL` | URL do projeto Supabase (`https://xxx.supabase.co`) |
| `VITE_SUPABASE_ANON_KEY` | Chave **anon** / publishable (`sb_publishable_...`), nunca `sb_secret_` |

Definir no painel do host **antes** do build (Build-time environment variables).

Arquivo local de referência: `.env.example` (não commitar `.env` com segredos).

---

## Comando de build e pastas

```bash
npm ci          # ou npm install
npm run build   # roda prebuild (ícones PWA) + vite build
```

- **Publicar:** conteúdo de **`dist/`** (não a raiz do repo).
- **SPA:** todas as rotas (`/auth`, `/dashboard/1`, …) devem servir `index.html` quando não houver arquivo estático correspondente (ver `vercel.json` / `netlify.toml`).

---

## Vercel

### Arquivos

- `vercel.json` — rewrite para SPA (`/(.*)` → `/index.html`). Arquivos estáticos em `dist` (assets, `sw.js`, `manifest.webmanifest`, `icons/`) são servidos pelo edge antes do rewrite.

### Painel (Project → Settings)

| Campo | Valor |
|--------|--------|
| Framework Preset | **Vite** (ou Other) |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm ci` ou `npm install` |

### Environment Variables

- `VITE_SUPABASE_URL` = URL do projeto  
- `VITE_SUPABASE_ANON_KEY` = chave anon  

Escopos: **Production** (e Preview se quiser URLs de teste).

### Deploy

- Conectar o repositório Git ou usar `vercel` CLI.
- Após merge na branch de produção, novo build aplica novas envs.

---

## Netlify

### Arquivos

- `netlify.toml` — `command`, `publish = "dist"`, redirect SPA para `index.html` com status 200.

### Painel (Site settings → Build & deploy)

| Campo | Valor |
|--------|--------|
| Build command | `npm run build` |
| Publish directory | `dist` |

### Environment variables

- Mesmas `VITE_SUPABASE_*` em **Site settings → Environment variables**.

---

## HTTPS e PWA

- Vercel e Netlify servem **HTTPS** por padrão — necessário para SW, `beforeinstallprompt` (Chrome) e boa parte dos recursos seguros.
- Após o deploy, teste em URL **https://…** (não `http://` em produção).

---

## Checklist pós-deploy

### Instalação Android (Chrome)

1. Abrir o site em HTTPS, fazer login e navegar um pouco (carregar shell + SW).
2. Menu ⋮ → **Instalar app** ou banner do app → instalar.
3. Abrir pelo ícone na tela inicial → deve abrir **standalone** (sem barra de URL do Chrome).
4. DevTools remoto (opcional): **Application → Manifest / Service Workers**.

### Instalação iPhone (Safari)

1. Abrir o site no **Safari**.
2. **Compartilhar** → **Adicionar à Tela de Início**.
3. Abrir pelo ícone → verificar título e ícone.

### Teste offline

1. Com o app já aberto ao menos uma vez (e SW ativo), ativar **modo avião** ou DevTools → Offline.
2. Recarregar ou navegar entre rotas já visitadas: o **shell** deve carregar do cache (Workbox).
3. **IndexedDB** e dados locais continuam no aparelho; API Supabase não funciona sem rede (esperado).

### Teste sync offline / online

1. **Offline:** criar ou alterar algo que vá para a fila (ex.: vistoria/leilão conforme seu fluxo) → ver indicador de **pendências** / fila.
2. **Online:** desligar modo avião → aguardar processamento da fila ou acionar sync manual se existir.
3. Confirmar no Supabase (ou segunda aba) que os dados subiram após reconexão.

### Regressão rápida

- [ ] Login com rede OK  
- [ ] Lista de leilões (nuvem ou IndexedDB)  
- [ ] Navegação direta para URL profunda (ex. `/dashboard/123`) após refresh — deve abrir (SPA)  
- [ ] Sem erros no console relacionados a env ausente (`VITE_SUPABASE_*`)

---

## SPA + fallback `index.html`

- **Vite** gera `dist/index.html` e assets em `dist/assets/`.
- O **host** deve devolver `index.html` para rotas da aplicação; `vercel.json` e `netlify.toml` deste repo configuram isso.
- O **Service Worker** (Workbox) já usa `navigateFallback: "/index.html"` para navegação offline coerente com o SPA.
