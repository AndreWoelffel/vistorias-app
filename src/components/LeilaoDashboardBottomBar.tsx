import { useNavigate } from "react-router-dom";
import { Plus, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  leilaoId: number;
  className?: string;
};

/** Barra fixa inferior: Nova Vistoria + Histórico (libera área útil do dashboard). */
export function LeilaoDashboardBottomBar({ leilaoId, className }: Props) {
  const navigate = useNavigate();
  return (
    <div
      className={cn(
        "fixed bottom-0 left-0 right-0 z-50 border-t border-border/80 bg-card/95 backdrop-blur-md px-3 pt-2 shadow-[0_-4px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_-4px_24px_rgba(0,0,0,0.35)]",
        "pb-[max(0.5rem,env(safe-area-inset-bottom))]",
        className,
      )}
    >
      <div className="mx-auto flex max-w-lg gap-2 pb-2">
        <Button
          type="button"
          className="h-12 flex-1 gap-2 rounded-xl text-base font-bold"
          onClick={() => navigate(`/vistoria/${leilaoId}`)}
        >
          <Plus className="h-5 w-5 shrink-0" />
          Nova Vistoria
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="h-12 flex-1 gap-2 rounded-xl text-base font-semibold"
          onClick={() => navigate(`/historico/${leilaoId}`)}
        >
          <History className="h-5 w-5 shrink-0" />
          Histórico
        </Button>
      </div>
    </div>
  );
}
