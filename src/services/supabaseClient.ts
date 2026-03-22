// src/services/supabaseClient.ts
// Apenas VITE_SUPABASE_* — sem fallback para NEXT_PUBLIC_* (evita pegar chave errada do SO/outro .env).
// Nunca use sb_secret_ no browser.
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

function assertNoSecretKeyInBrowser(key: string) {
  const trimmed = key.trim();
  if (trimmed.startsWith("sb_secret_")) {
    throw new Error(
      "Chave sb_secret_ (secret) não pode ser usada no navegador. Defina apenas VITE_SUPABASE_ANON_KEY com sb_publishable_... no .env (sem NEXT_PUBLIC_* com secret). Reinicie o dev server e limpe node_modules/.vite."
    );
  }
}

if (!supabaseUrl?.trim() || !supabaseAnonKey?.trim()) {
  throw new Error(
    "Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no .env (raiz do projeto). Reinicie o npm run dev após alterar."
  );
}

assertNoSecretKeyInBrowser(supabaseAnonKey);

/** Validação temporária: confira no console se o prefixo é sb_publishable_ — remover depois. */
if (import.meta.env.DEV) {
  console.log("SUPABASE KEY:", supabaseAnonKey.slice(0, 20));
}

export const supabase = createClient(supabaseUrl.trim(), supabaseAnonKey.trim());
