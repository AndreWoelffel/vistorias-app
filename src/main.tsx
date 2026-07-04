import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.tsx";
import "./index.css";
import { DebugErrorBoundary } from "@/components/DebugErrorBoundary";

/** SW apenas em build de produção; em `npm run dev` não registra (evita conflito com HMR). */
if (import.meta.env.PROD) {
  registerSW({
    immediate: true,
    onRegistered() {
      /* opcional: telemetria; evitar console em produção */
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
