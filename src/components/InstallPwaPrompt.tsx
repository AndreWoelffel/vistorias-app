import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Share2, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STORAGE_DISMISS = "pwa-install-prompt-dismissed-at";
const DISMISS_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mq = window.matchMedia("(display-mode: standalone)");
  if (mq.matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function InstallPwaPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const ios = useMemo(() => isIOS(), []);
  const standalone = typeof window !== "undefined" && isStandalone();
  const canShowChromeInstall = !!deferred && !standalone;

  useEffect(() => {
    const dismissedAt = localStorage.getItem(STORAGE_DISMISS);
    if (dismissedAt) {
      const t = Number(dismissedAt);
      if (Number.isFinite(t) && Date.now() - t < DISMISS_MS) {
        setDismissed(true);
      }
    }
  }, []);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  const handleInstall = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }, [deferred]);

  const handleDismiss = useCallback(() => {
    localStorage.setItem(STORAGE_DISMISS, String(Date.now()));
    setDismissed(true);
  }, []);

  if (dismissed) return null;

  if (standalone) return null;

  // Android/Chrome: botão nativo
  if (canShowChromeInstall) {
    return (
      <div
        className={cn(
          "fixed bottom-4 left-4 right-4 z-[90] mx-auto flex max-w-md flex-col gap-2 rounded-xl border border-border bg-card p-4 shadow-lg md:left-auto md:right-4 md:mx-0",
        )}
        role="status"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15">
              <Smartphone className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Instalar aplicativo</p>
              <p className="text-xs text-muted-foreground">
                Abra em tela cheia e use offline após o primeiro carregamento.
              </p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={handleDismiss} aria-label="Fechar">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <Button type="button" className="w-full gap-2" onClick={handleInstall}>
          <Download className="h-4 w-4" />
          Instalar aplicativo
        </Button>
      </div>
    );
  }

  // iPhone / Safari: instrução (não há beforeinstallprompt)
  if (ios) {
    return (
      <div
        className={cn(
          "fixed bottom-4 left-4 right-4 z-[90] mx-auto max-w-md rounded-xl border border-border bg-card p-4 shadow-lg md:left-auto md:right-4 md:mx-0",
        )}
        role="status"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15">
              <Share2 className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Adicionar à Tela de Início</p>
              <p className="text-xs text-muted-foreground">
                No Safari: toque em <strong className="text-foreground">Compartilhar</strong>{" "}
                <span className="whitespace-nowrap">(□↑)</span> e depois em{" "}
                <strong className="text-foreground">Adicionar à Tela de Início</strong>.
              </p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={handleDismiss} aria-label="Fechar">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  return null;
}

/** Hook para exibir estado de instalação em outros componentes (ex.: header). */
export function usePwaInstallStatus() {
  const [standalone, setStandalone] = useState(() =>
    typeof window !== "undefined" ? isStandalone() : false,
  );

  useEffect(() => {
    setStandalone(isStandalone());
  }, []);

  return {
    isInstalled: standalone,
    isIOS: isIOS(),
  };
}
