import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardCheck, User, Shield, Eye, EyeOff, Loader2, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { toast } from '@/hooks/use-toast';
import { listUsersByRole, login as loginUsuario, type UsuarioListItem } from '@/services/userService';
import {
  comPrazo,
  entrarSemInternet,
  guardarUsuariosNoAparelho,
  usuariosGuardados,
} from '@/services/usuariosOffline';

const PRAZO_MS = 8_000;

function dataCurta(ms: number): string {
  return new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const PIN_REGEX = /^\d{4}$/;

export default function AuthPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const online = useOnlineStatus();
  const [role, setRole] = useState<'vistoriador' | 'admin' | null>(null);
  const [usuarios, setUsuarios] = useState<UsuarioListItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [semInternetDesde, setSemInternetDesde] = useState<number | null>(null);
  const [selected, setSelected] = useState<UsuarioListItem | null>(null);
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!role) {
      setUsuarios([]);
      setListError(null);
      setSelected(null);
      setPin('');
      return;
    }

    let cancelled = false;
    setListLoading(true);
    setListError(null);
    setSemInternetDesde(null);
    setSelected(null);
    setPin('');

    const usarGuardados = (motivo: string) => {
      const guardados = usuariosGuardados(role);
      if (guardados && guardados.usuarios.length > 0) {
        setUsuarios(guardados.usuarios);
        setSemInternetDesde(guardados.atualizadoEm);
        return;
      }
      setUsuarios([]);
      setListError(motivo);
    };

    void (async () => {
      try {
        if (!online) {
          if (!cancelled) usarGuardados('Sem internet e sem lista guardada. Conecte-se uma vez para carregar.');
          return;
        }
        const rows = await comPrazo(listUsersByRole(role), PRAZO_MS);
        const safe = Array.isArray(rows) ? rows : [];
        void guardarUsuariosNoAparelho();
        if (!cancelled) {
          setUsuarios(safe);
          if (safe.length === 0) {
            setListError('Nenhum usuário cadastrado com este perfil no servidor.');
          }
        }
      } catch (e) {
        if (!cancelled) {
          usarGuardados(e instanceof Error ? e.message : 'Não foi possível carregar a lista de usuários.');
        }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [role, online]);

  const handleLogin = async () => {
    if (!role || !selected) {
      toast({ title: 'Selecione um usuário', variant: 'destructive' });
      return;
    }
    if (!PIN_REGEX.test(pin)) {
      toast({ title: 'Senha inválida', description: 'Use exatamente 4 dígitos.', variant: 'destructive' });
      return;
    }

    setSubmitting(true);
    try {
      let data: { id: string; nome: string; role: string } | null;
      if (semInternetDesde != null) {
        data = entrarSemInternet(selected.id, pin);
      } else {
        try {
          data = await comPrazo(loginUsuario(selected.nome, pin), PRAZO_MS);
        } catch {
          // Sinal caiu entre a lista e o Entrar: confere com a lista guardada.
          data = entrarSemInternet(selected.id, pin);
        }
      }
      if (data == null) {
        toast({
          title: 'Acesso negado',
          description: 'Nome ou senha incorretos.',
          variant: 'destructive',
        });
        return;
      }

      if (data.role !== role) {
        toast({ title: 'Acesso negado', description: 'Perfil não confere.', variant: 'destructive' });
        return;
      }

      login({
        id: data.id,
        nome: String(data.nome).trim(),
        role: data.role === 'admin' ? 'admin' : 'vistoriador',
      });
      toast({ title: `Bem-vindo, ${data.nome}!` });
      navigate('/', { replace: true });
    } catch (e) {
      toast({
        title: 'Erro ao entrar',
        description: e instanceof Error ? e.message : 'Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (!role) {
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
            <p className="text-sm text-muted-foreground text-center">Selecione seu perfil</p>
          </div>

          <div className="space-y-3">
            <Button
              onClick={() => setRole('vistoriador')}
              className="w-full h-16 text-lg font-bold rounded-xl gap-3"
            >
              <User className="h-6 w-6" />
              Vistoriador
            </Button>
            <Button
              variant="secondary"
              onClick={() => setRole('admin')}
              className="w-full h-14 text-base font-semibold rounded-xl gap-3"
            >
              <Shield className="h-5 w-5" />
              Administrador
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6">
      <form 
        onSubmit={(e) => {
          e.preventDefault();
          void handleLogin();
        }} 
        className="w-full max-w-sm space-y-6"
      >
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary">
            {role === 'admin' ? (
              <Shield className="h-7 w-7 text-primary-foreground" />
            ) : (
              <User className="h-7 w-7 text-primary-foreground" />
            )}
          </div>
          <h2 className="text-xl font-black text-foreground">
            {role === 'admin' ? 'Administrador' : 'Vistoriador'}
          </h2>
          <p className="text-sm text-muted-foreground text-center">
            Escolha seu usuário e informe a senha de 4 dígitos
          </p>
        </div>

        <div className="card-glow rounded-xl bg-card p-5 space-y-4">
          <div>
            <label className="block text-sm font-semibold text-foreground/80 mb-2">Usuário</label>
            {listLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="text-sm">Carregando lista…</span>
              </div>
            ) : listError ? (
              <div className="py-2 space-y-2">
                {!online ? <WifiOff className="h-5 w-5 text-muted-foreground mx-auto" /> : null}
                <p className="text-sm text-destructive text-center">{listError}</p>
              </div>
            ) : (
              <>
              {semInternetDesde != null && (
                <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <WifiOff className="h-3.5 w-3.5 shrink-0" />
                  Sem internet. Lista guardada neste celular em {dataCurta(semInternetDesde)}.
                </p>
              )}
              <ul className="max-h-48 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                {(usuarios ?? []).map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(u)}
                      className={`w-full text-left px-3 py-3 text-sm font-medium transition-colors ${
                        selected?.id === u.id
                          ? 'bg-primary/15 text-primary'
                          : 'hover:bg-secondary/80 text-foreground'
                      }`}
                    >
                      {u.nome}
                    </button>
                  </li>
                ))}
              </ul>
              </>
            )}
          </div>

          <div>
            <label className="block text-sm font-semibold text-foreground/80 mb-1">Senha (4 dígitos)</label>
            <div className="relative">
              <Input
                type={showPin ? 'text' : 'password'}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                inputMode="numeric"
                maxLength={4}
                autoComplete="one-time-code"
                className="h-12 text-center text-2xl font-black tracking-[0.5em] pr-12"
              />
              <button
                type="button"
                onClick={() => setShowPin(!showPin)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              >
                {showPin ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
          </div>
        </div>

        <Button
          type="submit"
          disabled={
            submitting ||
            listLoading ||
            !!listError ||
            usuarios.length === 0 ||
            !selected ||
            !PIN_REGEX.test(pin)
          }
          className="w-full h-14 text-lg font-bold rounded-xl"
        >
          {submitting ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Entrando…
            </>
          ) : (
            'Entrar'
          )}
        </Button>

        <button
          type="button"
          onClick={() => setRole(null)}
          className="w-full text-center text-sm text-muted-foreground underline"
        >
          Voltar
        </button>
      </form>
    </div>
  );
}