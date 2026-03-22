import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Plus, Users, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { AppHeader } from '@/components/AppHeader';
import { useAuth } from '@/hooks/useAuth';
import { useSupabaseUsuarios, type AppUsuarioRole } from '@/hooks/useSupabaseUsuarios';
import { toast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const PIN_REGEX = /^\d{4}$/;

export default function UsuariosPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { usuarios, loading, createUsuario, refresh } = useSupabaseUsuarios();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [nome, setNome] = useState('');
  const [senha, setSenha] = useState('');
  const [role, setRole] = useState<AppUsuarioRole>('vistoriador');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user && user.role !== 'admin') {
      navigate('/', { replace: true });
    }
  }, [user, navigate]);

  if (!user || user.role !== 'admin') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 bg-background">
        <ShieldAlert className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Acesso restrito a administradores.</p>
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const safeList = (usuarios ?? []).filter((u) => u.id != null && String(u.id).trim().length > 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = nome.trim();
    if (!trimmed) {
      toast({ title: 'Nome obrigatório', variant: 'destructive' });
      return;
    }
    if (!PIN_REGEX.test(senha)) {
      toast({
        title: 'Senha inválida',
        description: 'Use exatamente 4 dígitos numéricos.',
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);
    try {
      await createUsuario(trimmed, senha, role);
      toast({ title: 'Usuário criado', description: 'Registro salvo no Supabase.' });
      setNome('');
      setSenha('');
      setRole('vistoriador');
      setDialogOpen(false);
    } catch (err) {
      console.error(err);
      toast({
        title: 'Erro ao salvar',
        description: err instanceof Error ? err.message : 'Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Usuários" showBack onBack={() => navigate('/')} />

      <div className="flex-1 p-4 space-y-4">
        <div className="rounded-xl border border-border/60 bg-card/50 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            Logado como <span className="font-semibold text-foreground">{user.nome}</span>{' '}
            <Badge variant="default" className="text-[10px] ml-1">
              admin
            </Badge>
          </p>
          <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
            Usuários cadastrados aqui podem entrar no app com nome e senha de 4 dígitos. O nome deve ser único.
          </p>
        </div>

        <Button
          className="w-full h-12 gap-2 font-semibold rounded-xl"
          onClick={() => setDialogOpen(true)}
          disabled={saving}
        >
          <Plus className="h-5 w-5" />
          Novo usuário
        </Button>

        <Button
          type="button"
          variant="outline"
          className="w-full h-10 text-sm"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Atualizar lista'}
        </Button>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm">Carregando usuários…</p>
          </div>
        ) : safeList.length === 0 ? (
          <div className="card-glow rounded-xl bg-card p-8 text-center space-y-2">
            <Users className="h-10 w-10 mx-auto text-muted-foreground opacity-50" />
            <p className="text-sm font-semibold text-foreground">Nenhum usuário no Supabase</p>
            <p className="text-xs text-muted-foreground">Crie o primeiro usuário ou verifique conexão/policies.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {safeList.map((u) => (
              <li
                key={u.id}
                className="card-glow rounded-xl bg-card p-4 border border-border/60 flex flex-col gap-1"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-foreground truncate">{u.nome}</p>
                  <Badge variant={u.role === 'admin' ? 'default' : 'secondary'} className="text-[10px] shrink-0">
                    {u.role}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">ID: {u.id}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(o) => !saving && setDialogOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={(e) => void handleSubmit(e)}>
            <DialogHeader>
              <DialogTitle>Novo usuário</DialogTitle>
              <DialogDescription>
                Os dados serão gravados em <code className="text-foreground">public.usuarios</code> no Supabase.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4 space-y-4">
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Nome (único)</label>
                <Input
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  className="mt-1 h-11"
                  placeholder="Nome para login"
                  autoFocus
                  disabled={saving}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Senha (4 dígitos)</label>
                <Input
                  value={senha}
                  onChange={(e) => setSenha(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className="mt-1 h-11 text-center text-lg font-mono tracking-widest"
                  placeholder="••••"
                  inputMode="numeric"
                  maxLength={4}
                  autoComplete="new-password"
                  disabled={saving}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Papel</label>
                <Select
                  value={role}
                  onValueChange={(v) => setRole(v as AppUsuarioRole)}
                  disabled={saving}
                >
                  <SelectTrigger className="mt-1 h-11">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vistoriador">Vistoriador</SelectItem>
                    <SelectItem value="admin">Administrador</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)} disabled={saving}>
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={saving || !nome.trim() || !PIN_REGEX.test(senha)}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Salvar'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
