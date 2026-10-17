import { useEffect } from 'react';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { supabase } from '@/services/supabaseClient';

const STORAGE_KEY = 'currentUser';
const INTERVALO_MS = 10 * 60_000;

type Sessao = { id: string; nome: string; role: string };

function lerSessao(): Sessao | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Sessao) : null;
  } catch {
    return null;
  }
}

/**
 * A sessão do celular não expira, para funcionar sem sinal. Quando há sinal, confere
 * se o usuário ainda está ativo: desativado sai do app, e mudança de papel vale na hora.
 * As vistorias guardadas continuam na fila e sobem mesmo depois de sair.
 */
async function conferirSessao(): Promise<void> {
  const sessao = lerSessao();
  if (!sessao?.id) return;
  const { data, error } = await supabase
    .from('usuarios')
    .select('ativo, role')
    .eq('id', sessao.id)
    .maybeSingle();
  if (error) return;

  const row = data as { ativo?: boolean | null; role?: string | null } | null;
  if (!row || row.ativo === false) {
    localStorage.removeItem(STORAGE_KEY);
    window.location.href = '/auth';
    return;
  }
  const role = row.role === 'admin' ? 'admin' : 'vistoriador';
  if (role !== sessao.role) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...sessao, role }));
    window.location.reload();
  }
}

export function SessaoGuard() {
  const online = useOnlineStatus();

  useEffect(() => {
    if (!online) return;
    void conferirSessao();
    const id = window.setInterval(() => void conferirSessao(), INTERVALO_MS);
    return () => window.clearInterval(id);
  }, [online]);

  return null;
}
