# PWA — instalação e testes

## Build e preview local

```bash
npm run build
npm run preview
```

Abra o URL mostrado (ex.: `http://localhost:4173`). O `prebuild` gera PNGs mínimos em `public/icons/` se necessário; substitua por ícones finais (192 / 512 / apple-touch).

## Testar PWA (Chrome)

1. Abra DevTools → **Application** → **Manifest** e **Service Workers**.
2. Verifique **Installability** / “Add to Home screen”.
3. Use **Lighthouse** → categoria **PWA** (opcional).

## Android (Chrome)

1. Acesse o site em HTTPS (produção ou túnel ngrok).
2. Menu ⋮ → **Instalar app** ou use o banner “Instalar aplicativo” quando aparecer.
3. Confirme o atalho na tela inicial; abra em **modo standalone** (sem barra de endereço).

## iPhone (Safari)

1. Abra o site no **Safari** (não há `beforeinstallprompt` no iOS).
2. Toque em **Compartilhar** → **Adicionar à Tela de Início**.
3. O app abre em tela cheia (comportamento depende da versão do iOS).

## Offline

- O Workbox faz precache do shell e dos assets do build; **Supabase** está em **NetworkOnly** (não vira cache estático).
- **IndexedDB** e a **fila de sync** continuam no cliente; sem rede, a nuvem não sincroniza até voltar online.

## Desenvolvimento

- `devOptions.enabled: false` — o SW não ativa no `npm run dev` para não atrapalhar o HMR. Use `build` + `preview` para validar SW.

## Checklist rápido offline (após primeiro carregamento com rede)

| Área | O que verificar |
|------|------------------|
| **Login** | Sessão já em localStorage / fluxo offline conforme implementado; PIN pode exigir rede se a lista vier do servidor. |
| **Home** | Shell carrega do cache; lista de leilões vem do IndexedDB se Supabase falhar. |
| **Leilões** | Seleção usa dados locais; `OfflineNotice` indica modo offline. |
| **Sync** | `SyncStatusIndicator` + fila local; `processQueue` não spamma console em produção. |

## Supabase e cache

- Em `vite.config.ts`, `runtimeCaching` usa **NetworkOnly** para `https://*.supabase.co/*` — respostas da API **não** são cacheadas como arquivos estáticos.

### Android (checklist)

1. `npm run build && npm run preview` ou HTTPS em produção.
2. Instalar app → abrir standalone → DevTools → Application → SW ativo.
3. Offline (DevTools → Network → Offline) → navegar entre rotas já visitadas → app responde.

### iPhone (checklist)

1. Safari → site em HTTPS.
2. Compartilhar → Adicionar à Tela de Início.
3. Abrir pelo ícone → testar fluxo principal; offline após visita prévia.
