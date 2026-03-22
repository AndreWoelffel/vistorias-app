import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Linha de status PWA (instalado / iOS / disponível no navegador). */
export function PwaStatusBadge() {
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    setStandalone(isStandalone());
  }, []);

  if (standalone) {
    return (
      <Badge variant="secondary" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-800 dark:text-emerald-200">
        App instalado
      </Badge>
    );
  }

  if (isIOS()) {
    return (
      <Badge variant="outline" className="text-[10px] text-muted-foreground">
        iPhone: Safari → Compartilhar → Tela de Início
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="text-[10px] text-muted-foreground">
      Pode instalar pelo menu do navegador
    </Badge>
  );
}
