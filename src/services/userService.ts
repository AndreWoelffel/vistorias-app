import { supabase } from '@/services/supabaseClient';

export type AppUsuarioRole = 'vistoriador' | 'admin';

/** Linha em `public.usuarios` (Supabase). `id` = UUID (string no client). */
export type SupabaseUsuarioRow = {
  id: string;
  nome: string;
  senha: string;
  role: AppUsuarioRole;
  created_at?: string | null;
};

export type UsuarioListItem = Pick<SupabaseUsuarioRow, 'id' | 'nome' | 'role'>;

function normalizeUsuarioId(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function rowToUsuarioListItem(row: Record<string, unknown>): UsuarioListItem | null {
  const id = normalizeUsuarioId(row.id);
  const nome = String(row.nome ?? '').trim();
  const role = row.role === 'admin' || row.role === 'vistoriador' ? row.role : null;
  if (!id || !nome || !role) return null;
  return { id, nome, role };
}

function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505';
}

const PIN_4 = /^\d{4}$/;

/**
 * Lista todos os usuários (tela de admin — sem senha).
 */
export async function listAllUsuariosAdmin(): Promise<UsuarioListItem[]> {
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome, role')
    .order('nome', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  const rows = data ?? [];
  const list: UsuarioListItem[] = [];
  for (const row of rows) {
    const item = rowToUsuarioListItem(row as Record<string, unknown>);
    if (item) list.push(item);
  }
  return list;
}

/**
 * Cria usuário na nuvem. Valida senha de 4 dígitos; nome único no banco.
 */
export async function createUsuarioSupabase(params: {
  nome: string;
  senha: string;
  role: AppUsuarioRole;
}): Promise<UsuarioListItem> {
  const trimmed = params.nome.trim();
  if (!trimmed) {
    throw new Error('Informe o nome.');
  }
  if (!PIN_4.test(params.senha)) {
    throw new Error('A senha deve ter exatamente 4 dígitos numéricos.');
  }

  const { data, error } = await supabase
    .from('usuarios')
    .insert({
      nome: trimmed,
      senha: params.senha,
      role: params.role,
    })
    .select('id, nome, role')
    .maybeSingle();

  if (error) {
    if (isUniqueViolation(error)) {
      throw new Error('Já existe um usuário com este nome.');
    }
    throw new Error(error.message);
  }

  if (data == null) {
    throw new Error('Não foi possível criar o usuário.');
  }

  const item = rowToUsuarioListItem(data as Record<string, unknown>);
  if (!item) {
    throw new Error('Resposta inválida ao criar usuário.');
  }
  return item;
}

/**
 * Lista usuários cadastrados com o papel escolhido na tela de login.
 */
export async function listUsersByRole(role: AppUsuarioRole): Promise<UsuarioListItem[]> {
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome, role')
    .eq('role', role)
    .order('nome', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  const rows = data ?? [];
  const list: UsuarioListItem[] = [];
  for (const row of rows) {
    const item = rowToUsuarioListItem(row as Record<string, unknown>);
    if (item) list.push(item);
  }
  return list;
}

/**
 * Autentica por nome + senha (PIN 4 dígitos no app).
 * Retorna o registro ou `null` se credenciais inválidas.
 */
export async function login(nomeLogin: string, senha: string): Promise<SupabaseUsuarioRow | null> {
  const { data, error } = await supabase
    .from('usuarios')
    .select('*')
    .eq('nome', nomeLogin.trim())
    .eq('senha', senha)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const rows = data != null ? [data] : [];
  const rowRaw = rows[0];
  if (rowRaw == null) {
    return null;
  }

  const row = rowRaw as Record<string, unknown>;
  const id = normalizeUsuarioId(row.id);
  if (!id) {
    console.error('Usuário inválido');
    return null;
  }

  const nomeUsuario = String(row.nome ?? '').trim();
  const role = row.role === 'admin' || row.role === 'vistoriador' ? row.role : null;
  if (!nomeUsuario || !role) {
    console.error('Usuário inválido');
    return null;
  }

  return {
    id,
    nome: nomeUsuario,
    senha: String(row.senha ?? ''),
    role,
    created_at: row.created_at != null ? String(row.created_at) : null,
  };
}
