import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardCheck, ChevronDown, LogOut, Gavel, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLeiloes } from '@/hooks/useVistorias';
import { useAuth } from '@/hooks/useAuth';

export default function Home() {
  const { leiloes, loading: loadingLeiloes } = useLeiloes();
  const safeLeiloes = (leiloes ?? []).filter(
    (l) =>
      !l.deleted &&
      l.id != null &&
      Number.isFinite(l.id) &&
      (l.id as number) > 0,
  );
  const { user, logout } = useAuth();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const navigate = useNavigate();

  if (!user) {
    navigate('/auth', { replace: true });
    return null;
  }

  const handleStart = () => {
    if (!selectedId || !Number.isFinite(selectedId) || selectedId <= 0) {
      return;
    }
    const exists = safeLeiloes.some((l) => l.id === selectedId);
    if (!exists) {
      return;
    }
    navigate(`/dashboard/${selectedId}`);
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm space-y-10">
        
        {/* Cabeçalho Limpo */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary shadow-lg shadow-primary/20">
            <ClipboardCheck className="h-10 w-10 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-foreground">
            Vistoria<span className="text-primary">Pro</span>
          </h1>
          <p className="text-sm text-muted-foreground text-center">
            Olá, <span className="font-bold text-foreground">{user.nome}</span>
          </p>
        </div>

        {/* Formulário Central */}
        <form 
          onSubmit={(e) => {
            e.preventDefault();
            handleStart();
          }} 
          className="space-y-6"
        >
          <div className="space-y-3">
            <label className="block text-sm font-semibold text-foreground/80">
              Selecione o Leilão
            </label>
            <div className="relative">
              <select
                value={selectedId ?? ''}
                onChange={(e) => setSelectedId(Number(e.target.value) || null)}
                disabled={loadingLeiloes}
                className="w-full appearance-none rounded-xl border border-border/80 bg-card px-4 py-4 pr-10 text-base font-medium text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 transition-all"
              >
                <option value="">{loadingLeiloes ? 'Carregando…' : 'Escolher…'}</option>
                {safeLeiloes.map((l) => (
                  <option key={l.id} value={l.id}>{l.nome}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
            </div>
            
            {!loadingLeiloes && safeLeiloes.length === 0 && (
              <p className="text-xs text-amber-600/90 dark:text-amber-400/90 text-center mt-2">
                {user?.role === "admin"
                  ? "Nenhum leilão ainda. Cadastre em Gerenciar leilões."
                  : "Nenhum leilão liberado. Peça ao administrador."}
              </p>
            )}
          </div>

          <Button
            type="submit"
            disabled={!selectedId || !safeLeiloes.some((l) => l.id === selectedId)}
            className="w-full h-14 min-h-14 text-lg font-bold rounded-xl disabled:opacity-40 shadow-lg"
          >
            Abrir painel
          </Button>
        </form>

        {/* Botões Secundários com Borda Sutil */}
        <div className="space-y-3 pt-4 border-t border-border/40">
          {user?.role === "admin" && (
            <div className="grid grid-cols-2 gap-3">
              <Button
                type="button"
                variant="outline"
                className="w-full h-12 gap-2 text-sm font-medium text-foreground/80 border-border/50 hover:bg-secondary/50 rounded-xl transition-all"
                onClick={() => navigate("/leiloes")}
              >
                <Gavel className="h-4 w-4" />
                Leilões
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full h-12 gap-2 text-sm font-medium text-foreground/80 border-border/50 hover:bg-secondary/50 rounded-xl transition-all"
                onClick={() => navigate("/usuarios")}
              >
                <Users className="h-4 w-4" />
                Usuários
              </Button>
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            onClick={() => { logout(); navigate('/auth', { replace: true }); }}
            className="w-full h-12 gap-2 text-sm font-medium text-muted-foreground border-border/50 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 rounded-xl transition-all"
          >
            <LogOut className="h-4 w-4" />
            Sair da conta
          </Button>
        </div>

      </div>
    </div>
  );
}