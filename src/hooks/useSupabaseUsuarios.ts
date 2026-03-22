import { useState, useEffect, useCallback } from 'react';
import {
  listAllUsuariosAdmin,
  createUsuarioSupabase,
  type UsuarioListItem,
  type AppUsuarioRole,
} from '@/services/userService';

export type { UsuarioListItem, AppUsuarioRole };

/**
 * Usuários em `public.usuarios` (Supabase) — tela de administração.
 */
export function useSupabaseUsuarios() {
  const [usuarios, setUsuarios] = useState<UsuarioListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listAllUsuariosAdmin();
      const safe = Array.isArray(rows) ? rows : [];
      if (import.meta.env.DEV) console.log('DEBUG lista usuarios:', safe);
      setUsuarios(safe);
    } catch {
      if (import.meta.env.DEV) console.log('DEBUG lista usuarios:', []);
      setUsuarios([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createUsuario = useCallback(
    async (nome: string, senha: string, role: AppUsuarioRole) => {
      const row = await createUsuarioSupabase({ nome, senha, role });
      await refresh();
      return row;
    },
    [refresh],
  );

  return { usuarios: usuarios ?? [], loading, refresh, createUsuario };
}
