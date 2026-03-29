import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardCheck, ChevronDown, LogOut, Gavel, Users } from 'lucide-react';
import { OperationalStatusStrip } from '@/components/OperationalStatusStrip';
import { PwaStatusBadge } from '@/components/PwaStatusBadge';
import { Button } from '@/components/ui/button';
import { useLeiloes } from '@/hooks/useVistorias';
import { useAuth } from '@/hooks/useAuth';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useSyncStatus } from '@/hooks/useSyncStatus';

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
  const online = useOnlineStatus();
  const { pendingCount, failedCount, syncing } = useSyncStatus();
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
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary">
            <ClipboardCheck className="h-10 w-10 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-foreground">
            Vistoria<span className="text-primary">Pro</span>
          </h1>
          <p className="text-sm text-muted-foreground text-center">
            Olá, <span className="font-bold text-foreground">{user.nome}</span>
          </p>
          <div className="flex w-full flex-col items-center gap-2 pt-1">
            <OperationalStatusStrip
              online={online}
              syncing={syncing}
              pendingCount={pendingCount}
              failedCount={failedCount}
            />
            <PwaStatusBadge />
          </div>
        </div>

        <div className="space-y-3">
          <label className="block text-sm font-semibold text-foreground/80">Leilão</label>
          <div className="relative">
            <select
              value={selectedId ?? ''}
              onChange={(e) => setSelectedId(Number(e.target.value) || null)}
              disabled={loadingLeiloes}
              className="w-full appearance-none rounded-xl border border-border bg-card px-4 py-4 pr-10 text-base font-medium text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
            >
              <option value="">{loadingLeiloes ? 'Carregando…' : 'Escolher…'}</option>
              {safeLeiloes.map((l) => (
                <option key={l.id} value={l.id}>{l.nome}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          </div>
          {!loadingLeiloes && safeLeiloes.length === 0 && (
            <p className="text-xs text-amber-600/90 dark:text-amber-400/90 text-center">
              {user?.role === "admin"
                ? "Nenhum leilão ainda. Cadastre em Gerenciar leilões."
                : "Nenhum leilão liberado. Peça ao administrador."}
            </p>
          )}
        </div>

        <Button
          onClick={handleStart}
          disabled={!selectedId || !safeLeiloes.some((l) => l.id === selectedId)}
          className="w-full h-14 min-h-14 text-lg font-bold rounded-xl disabled:opacity-40"
        >
          Abrir painel
        </Button>

        {user?.role === "admin" && (
          <>
            <Button
              type="button"
              variant="ghost"
              className="w-full h-11 gap-2 text-sm text-muted-foreground rounded-xl"
              onClick={() => navigate("/leiloes")}
            >
              <Gavel className="h-4 w-4" />
              Leilões
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full h-11 gap-2 text-sm text-muted-foreground rounded-xl"
              onClick={() => navigate("/usuarios")}
            >
              <Users className="h-4 w-4" />
              Usuários
            </Button>
          </>
        )}

        <button
          onClick={() => { logout(); navigate('/auth', { replace: true }); }}
          className="flex items-center justify-center gap-2 w-full text-sm text-muted-foreground"
        >
          <LogOut className="h-4 w-4" />
          Sair
        </button>
      </div>
    </div>
  );
}
