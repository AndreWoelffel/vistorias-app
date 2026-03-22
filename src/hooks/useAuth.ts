import { useState, useCallback } from 'react';
import type { AuthUser } from '@/auth/types';

export type { AuthUser } from '@/auth/types';

const STORAGE_KEY = 'currentUser';
const LEGACY_STORAGE_KEY = 'vistoria_auth_user';

/** Aceita UUID (string) ou legado numérico no JSON. */
function parseId(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    return s.length > 0 ? s : null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(Math.trunc(raw));
  }
  return null;
}

function parseStoredUser(raw: string): AuthUser | null {
  try {
    const u = JSON.parse(raw) as Record<string, unknown>;
    const nome = typeof u.nome === 'string' ? u.nome.trim() : '';
    const role = u.role;
    if (!nome || (role !== 'admin' && role !== 'vistoriador')) {
      return null;
    }
    const id = parseId(u.id);
    if (!id) {
      return null;
    }
    return {
      id,
      nome,
      role,
    };
  } catch {
    return null;
  }
}

function readInitialUser(): AuthUser | null {
  try {
    const primary = localStorage.getItem(STORAGE_KEY);
    if (primary) {
      const parsed = parseStoredUser(primary);
      if (parsed) return parsed;
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const parsed = parseStoredUser(legacy);
      if (parsed) return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(() => readInitialUser());

  const login = useCallback((userData: AuthUser) => {
    if (!userData || !userData.id || !String(userData.id).trim()) {
      console.error('Usuário inválido');
      return;
    }
    const session: AuthUser = {
      id: String(userData.id).trim(),
      nome: userData.nome,
      role: userData.role,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    setUser(session);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.removeItem('vistoria_current_user_id');
    setUser(null);
  }, []);

  return { user, login, logout, isAuthenticated: !!user };
}
