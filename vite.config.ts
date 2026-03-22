import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => ({
  /** Somente VITE_* no client — evita importar NEXT_PUBLIC_* do SO com chave errada. */
  envPrefix: ["VITE_"],
  /** Sourcemaps para stack traces apontarem para arquivos .tsx/.ts (debug). */
  build: {
    sourcemap: mode !== "production",
  },
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
    allowedHosts: true,
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    VitePWA({
      /** Service Worker gerado pelo Workbox; precache do shell + assets estáticos. */
      strategies: "generateSW",
      registerType: "autoUpdate",
      /** Registro manual em main.tsx (virtual:pwa-register). */
      injectRegister: false,
      includeAssets: [
        "icons/favicon-32.png",
        "icons/icon-192.png",
        "icons/icon-512.png",
        "icons/icon-512-maskable.png",
        "icons/apple-touch-icon.png",
        "icons/icon.svg",
      ],
      manifest: {
        name: "VistoriaPro - Vistoria Veicular",
        short_name: "VistoriaPro",
        description:
          "Aplicativo de vistoria veicular offline-first com sincronização e leilões.",
        lang: "pt-BR",
        theme_color: "#e6a817",
        background_color: "#141820",
        display: "standalone",
        display_override: ["standalone", "minimal-ui"],
        orientation: "portrait",
        scope: "/",
        start_url: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "/icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2,webmanifest}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/~oauth/],
        runtimeCaching: [
          /** Supabase REST/Auth: nunca cachear como estático (evita dados stale e conflita com sync). */
          {
            urlPattern: /^https:\/\/[^/]+\.supabase\.co\/.*/i,
            handler: "NetworkOnly",
            options: { cacheName: "supabase-api" },
          },
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "tesseract-cdn-cache",
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      /** PWA em dev pode atrapalhar HMR; teste com `npm run build && npm run preview`. */
      devOptions: {
        enabled: false,
        navigateFallback: "/index.html",
      },
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
