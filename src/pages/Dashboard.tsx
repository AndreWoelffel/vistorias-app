import { useNavigate } from 'react-router-dom';
import { Plus, History, ClipboardList, CalendarDays, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppHeader } from '@/components/AppHeader';
import { useTodayCount, useTotalCount } from '@/hooks/useVistorias';
import { useRequireValidLeilao } from '@/hooks/useLeilaoRoute';

export default function Dashboard() {
  const { leilaoId: id, ready } = useRequireValidLeilao();
  const navigate = useNavigate();
  const todayCount = useTodayCount(ready ? id : null);
  const totalCount = useTotalCount(ready ? id : null);

  if (!ready) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AppHeader title="Dashboard" showBack onBack={() => navigate('/')} />
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Dashboard" showBack />

      <div className="flex-1 p-4 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-2 gap-3">
          <div className="card-glow rounded-xl bg-card p-5">
            <div className="flex items-center gap-2 text-muted-foreground mb-2">
              <CalendarDays className="h-4 w-4" />
              <span className="text-xs font-semibold uppercase tracking-wider">Hoje</span>
            </div>
            <p className="text-4xl font-black text-primary">{todayCount}</p>
            <p className="text-xs text-muted-foreground mt-1">vistorias</p>
          </div>
          <div className="card-glow rounded-xl bg-card p-5">
            <div className="flex items-center gap-2 text-muted-foreground mb-2">
              <ClipboardList className="h-4 w-4" />
              <span className="text-xs font-semibold uppercase tracking-wider">Total</span>
            </div>
            <p className="text-4xl font-black text-foreground">{totalCount}</p>
            <p className="text-xs text-muted-foreground mt-1">vistorias</p>
          </div>
        </div>

        {/* Actions */}
        <div className="space-y-3">
          <Button
            onClick={() => navigate(`/vistoria/${id}`)}
            className="w-full h-16 text-lg font-bold rounded-xl gap-3"
          >
            <Plus className="h-6 w-6" />
            Nova Vistoria
          </Button>
          <Button
            variant="secondary"
            onClick={() => navigate(`/historico/${id}`)}
            className="w-full h-14 text-base font-semibold rounded-xl gap-3"
          >
            <History className="h-5 w-5" />
            Histórico
          </Button>
        </div>
      </div>
    </div>
  );
}
