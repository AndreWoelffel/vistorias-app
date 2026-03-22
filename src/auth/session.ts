/**
 * Extensão futura: mapear sessão Supabase Auth → papel da aplicação.
 * Permissões de leilão usam `currentUser` em `src/services/currentUserService.ts`.
 */

import type { AuthUser } from "@/auth/types";

export type AppUserRole = "admin" | "user";

export function mapAuthUserToAppRole(user: AuthUser | null): AppUserRole | null {
  if (!user) return null;
  return user.role === "admin" ? "admin" : "user";
}
