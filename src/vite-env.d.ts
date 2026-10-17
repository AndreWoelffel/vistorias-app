/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** "1.0.0 · 17/10/2026", definido no vite.config a partir do package.json. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
