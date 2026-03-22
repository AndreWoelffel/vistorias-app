import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getLeilaoById, type Leilao } from "@/lib/db";
import { toast } from "@/hooks/use-toast";

/**
 * Garante que :leilaoId na rota é um número válido e existe no IndexedDB.
 */
export function useRequireValidLeilao() {
  const { leilaoId } = useParams();
  const navigate = useNavigate();
  const id = Number(leilaoId);
  const [ready, setReady] = useState(false);
  const [leilao, setLeilao] = useState<Leilao | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!leilaoId || !Number.isFinite(id) || id <= 0) {
      toast({
        title: "Selecione um leilão",
        description: "Volte à tela inicial e escolha um leilão antes de continuar.",
        variant: "destructive",
      });
      navigate("/", { replace: true });
      return;
    }

    getLeilaoById(id).then((l) => {
      if (cancelled) return;
      if (!l || l.deleted) {
        toast({
          title: "Leilão não encontrado",
          description: "Cadastre um leilão em Gerenciar Leilões ou escolha outro.",
          variant: "destructive",
        });
        navigate("/", { replace: true });
        return;
      }
      setLeilao(l);
      setReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [leilaoId, id, navigate]);

  return { leilaoId: id, leilao, ready };
}
