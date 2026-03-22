/**
 * Usuário atual: prioriza sessão de login (`currentUser`); fallback catálogo IndexedDB.
 */

import { seedUsuarios, getUsers, type User } from "@/lib/db";

const CURRENT_USER_ID_KEY = "vistoria_current_user_id";
const SESSION_USER_KEY = "currentUser";

function readSessionForCreatedBy(): { displayName: string; userId: string | null } | null {
  try {
    const raw = localStorage.getItem(SESSION_USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as { nome?: string; id?: string | number };
    const nome = typeof u.nome === "string" ? u.nome.trim() : "";
    if (!nome) return null;
    if (typeof u.id === "string" && u.id.trim()) {
      return { displayName: nome, userId: u.id.trim() };
    }
    if (typeof u.id === "number" && Number.isFinite(u.id)) {
      return { displayName: nome, userId: String(Math.trunc(u.id)) };
    }
    return { displayName: nome, userId: null };
  } catch {
    return null;
  }
}

/** Persiste qual registro de `usuarios` é o “usuário atual”. */
export function setCurrentUser(userId: number): void {
  localStorage.setItem(CURRENT_USER_ID_KEY, String(userId));
}

function readStoredUserId(): number | null {
  const raw = localStorage.getItem(CURRENT_USER_ID_KEY);
  if (raw == null || raw === "") return null;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Resolve o usuário atual: seed → lista → id salvo ou primeiro admin / primeiro da lista.
 */
export async function getCurrentUser(): Promise<User | null> {
  await seedUsuarios();
  const users = await getUsers();
  if (users.length === 0) return null;

  const storedId = readStoredUserId();
  if (storedId != null) {
    const found = users.find((u) => u.id === storedId);
    if (found) return found;
  }

  const admin = users.find((u) => u.role === "admin");
  const pick = admin ?? users[0];
  setCurrentUser(pick.id);
  return pick;
}

export async function assertCanDeleteLeilao(): Promise<void> {
  const raw = localStorage.getItem(SESSION_USER_KEY);
  if (raw) {
    try {
      const u = JSON.parse(raw) as { role?: string };
      if (u.role === "admin") return;
    } catch {
      /* sessão inválida */
    }
    throw new Error("Usuário sem permissão para excluir leilão");
  }
  const u = await getCurrentUser();
  if (!u || u.role !== "admin") {
    throw new Error("Usuário sem permissão para excluir leilão");
  }
}

/**
 * Snapshot para auditoria (`created_by` no Supabase e IndexedDB).
 * `userId`: UUID da sessão Supabase ou id do catálogo local como string.
 */
export type CreatedBySnapshot = {
  displayName: string;
  userId: string | null;
};

export async function getCreatedBySnapshot(): Promise<CreatedBySnapshot> {
  const session = readSessionForCreatedBy();
  if (session) {
    return {
      displayName: session.displayName || "Desconhecido",
      userId: session.userId,
    };
  }
  const u = await getCurrentUser();
  const nome = u?.nome?.trim();
  return {
    displayName: nome && nome.length > 0 ? nome : "Desconhecido",
    userId: u?.id != null ? String(u.id) : null,
  };
}
