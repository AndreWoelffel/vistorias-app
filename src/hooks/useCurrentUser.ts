import { useState, useEffect, useCallback } from "react";
import { getCurrentUser, setCurrentUser as persistCurrentUserId } from "@/services/currentUserService";
import type { User } from "@/lib/db";

/**
 * Estado reativo do usuário atual (catálogo IndexedDB + localStorage).
 * Futuro: trocar implementação interna por Supabase Auth.
 */
export function useCurrentUser() {
  const [currentUser, setCurrentUserState] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const u = await getCurrentUser();
      setCurrentUserState(u);
    } catch {
      setCurrentUserState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setCurrentUser = useCallback(
    async (userId: number) => {
      persistCurrentUserId(userId);
      await refresh();
    },
    [refresh],
  );

  return {
    currentUser,
    loading,
    refresh,
    /** Define o usuário atual pelo id no IndexedDB. */
    setCurrentUser,
  };
}
