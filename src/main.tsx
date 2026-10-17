import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.tsx";
import "./index.css";
import { DebugErrorBoundary } from "@/components/DebugErrorBoundary";
import { marcarAtualizacaoPronta } from "@/lib/pwaUpdate";

/** O app fica aberto o dia todo no pátio; confere versão nova de tempos em tempos. */
const INTERVALO_CONFERIR_VERSAO_MS = 30 * 60_000;

/** SW apenas em build de produção; em `npm run dev` não registra (evita conflito com HMR). */
if (import.meta.env.PROD) {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      marcarAtualizacaoPronta(updateSW);
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      window.setInterval(() => {
        if (navigator.onLine) void registration.update().catch(() => undefined);
      }, INTERVALO_CONFERIR_VERSAO_MS);
    },
    onRegisterError() {
      /* falha silenciosa — app continua sem offline precache */
    },
  });
}

createRoot(document.getElementById("root")!).render(
  <DebugErrorBoundary>
    <App />
  </DebugErrorBoundary>,
);
