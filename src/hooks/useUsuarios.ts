import { useState, useEffect, useCallback } from "react";
import {
  getUsers,
  seedUsuarios,
  addUser,
  deleteUsuario as deleteUsuarioDb,
  type User,
  type UserRole,
} from "@/lib/db";

export type { User, UserRole };

export function useUsuarios() {
  const [usuarios, setUsuarios] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await seedUsuarios();
      const data = await getUsers();
      setUsuarios(Array.isArray(data) ? data : []);
    } catch {
      setUsuarios([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createUsuario = useCallback(
    async (nome: string, role: UserRole) => {
      const trimmed = nome.trim();
      if (!trimmed) throw new Error("Informe o nome.");
      await addUser({ nome: trimmed, role });
      await refresh();
    },
    [refresh],
  );

  const deleteUsuario = useCallback(
    async (id: number) => {
      await deleteUsuarioDb(id);
      await refresh();
    },
    [refresh],
  );

  return { usuarios: usuarios ?? [], loading, refresh, createUsuario, deleteUsuario };
}
