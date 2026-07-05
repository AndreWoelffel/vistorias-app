import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

type Props = {
  className?: string;
  hint?: string;
};

/** Barra com o usuário logado (sessão Supabase / localStorage). */
export function SessionUserBar({ className, hint }: Props) {
  const { user } = useAuth();
  if (!user) return null;

  return (
    <div className={cn('rounded-xl border border-border/60 bg-card/50 px-3 py-2', className)}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <span>Logado como</span>
        <span className="font-semibold text-foreground">{user.nome}</span>
        <Badge variant={user.role === 'admin' ? 'default' : 'secondary'} className="text-[10px]">
          {user.role}
        </Badge>
      </div>
      {hint ? <p className="text-[11px] text-muted-foreground mt-1 leading-snug">{hint}</p> : null}
    </div>
  );
}
