/**
 * Login sem internet. Quando há sinal, a lista de usuários fica guardada no
 * aparelho com o PIN embaralhado (sha256 de id + PIN); o PIN em texto não fica.
 * Sem sinal, a tela de entrada usa essa lista e confere o PIN pelo embaralhado.
 */
import { sha256Hex } from '@/lib/sha256';
import { supabase } from '@/services/supabaseClient';
import type { AppUsuarioRole, UsuarioListItem } from '@/services/userService';

const CHAVE = 'vistoria.usuariosGuardados';

type UsuarioGuardado = UsuarioListItem & { pin: string };

type Guardados = { atualizadoEm: number; usuarios: UsuarioGuardado[] };

function embaralhar(id: string, pin: string): string {
  return sha256Hex(new TextEncoder().encode(`${id}:${pin}`));
}

function ler(): Guardados | null {
  try {
    const raw = localStorage.getItem(CHAVE);
    if (!raw) return null;
    const dados = JSON.parse(raw) as Guardados;
    return Array.isArray(dados?.usuarios) ? dados : null;
  } catch {
    return null;
  }
}

/** Espera no máximo `ms`; com sinal fraco a chamada pode ficar pendurada. */
export function comPrazo<T>(promessa: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('Sem resposta do servidor.')), ms);
    Promise.resolve(promessa).then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Atualiza a lista guardada. Falha em silêncio: a lista anterior continua valendo. */
export async function guardarUsuariosNoAparelho(): Promise<void> {
  try {
    const { data, error } = await comPrazo(
      supabase.from('usuarios').select('id, nome, role, ativo, senha'),
      10_000,
    );
    if (error || !data) return;
    const usuarios: UsuarioGuardado[] = [];
    for (const row of data as Record<string, unknown>[]) {
      const id = String(row.id ?? '').trim();
      const nome = String(row.nome ?? '').trim();
      const role = row.role === 'admin' ? 'admin' : row.role === 'vistoriador' ? 'vistoriador' : null;
      if (!id || !nome || !role) continue;
      usuarios.push({
        id,
        nome,
        role,
        ativo: row.ativo !== false,
        pin: embaralhar(id, String(row.senha ?? '')),
      });
    }
    localStorage.setItem(CHAVE, JSON.stringify({ atualizadoEm: Date.now(), usuarios } satisfies Guardados));
  } catch {
    /* fica a lista anterior */
  }
}

export function usuariosGuardados(role: AppUsuarioRole): { usuarios: UsuarioListItem[]; atualizadoEm: number } | null {
  const dados = ler();
  if (!dados) return null;
  const usuarios = dados.usuarios
    .filter((u) => u.role === role && u.ativo !== false)
    .map(({ pin: _pin, ...u }) => u)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  return { usuarios, atualizadoEm: dados.atualizadoEm };
}

/** Confere o PIN com a lista guardada. */
export function entrarSemInternet(id: string, pin: string): UsuarioListItem | null {
  const u = ler()?.usuarios.find((x) => x.id === id && x.ativo !== false);
  if (!u || u.pin !== embaralhar(id, pin)) return null;
  const { pin: _pin, ...usuario } = u;
  return usuario;
}
