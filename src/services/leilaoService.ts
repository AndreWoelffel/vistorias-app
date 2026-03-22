// src/services/leilaoService.ts
import { supabase } from "./supabaseClient";
import {
  addLeilao,
  getLeilaoById,
  getAllLeiloes,
  getQueue,
  updateLeilao,
  deleteLeilaoFromDb,
  deleteVistoriasByLeilao,
  addToQueue,
  removeQueueItemsForLeilao,
  removeLeilaoCreateFromQueue,
  setSyncQueueItemRetryPaused,
  removeLeilaoDeleteFromQueue,
  type Leilao,
} from "@/lib/db";
import { assertCanDeleteLeilao, getCreatedBySnapshot } from "@/services/currentUserService";
import { supabaseTimestampToMs } from "@/services/syncConflict";

export type CreateLeilaoResult = {
  leilao: Leilao;
  cloudOk: boolean;
  error?: string;
};

export type UpdateLeilaoResult = {
  ok: boolean;
  cloudOk?: boolean;
  error?: string;
};

export type DeleteLeilaoResult = {
  ok: boolean;
  /** Exclusão na nuvem será feita pela fila (soft delete local). */
  pendingCloudDelete?: boolean;
  cloudError?: string;
};

export type SyncLeilaoResult = {
  ok: boolean;
  error?: string;
};

async function triggerProcessQueue(): Promise<void> {
  const { processQueue } = await import("@/services/syncService");
  await processQueue();
}

/** Reutiliza item `delete` pausado ou enfileira novo. */
async function ensureLeilaoDeleteQueued(localId: number): Promise<void> {
  const items = await getQueue();
  const pendingDeletes = items.filter(
    (i) =>
      i.entity === "leilao" &&
      i.type === "delete" &&
      (i.payload as { localId?: number }).localId === localId,
  );
  if (pendingDeletes.length > 0) {
    for (const d of pendingDeletes) {
      if (d.id != null && d.retryPaused) {
        await setSyncQueueItemRetryPaused(d.id, false);
      }
    }
    return;
  }
  await addToQueue({
    type: "delete",
    entity: "leilao",
    payload: { localId },
  });
}

/**
 * Após corrigir vistorias na nuvem: volta a marcar exclusão pendente e retoma a fila.
 */
export async function resumeLeilaoCloudDelete(localId: number): Promise<void> {
  const leilao = await getLeilaoById(localId);
  if (!leilao) return;
  await updateLeilao(localId, { deleteBlocked: false, deleted: true });
  await ensureLeilaoDeleteQueued(localId);
  await triggerProcessQueue();
}

/** Cancela exclusão pendente na nuvem (remove da fila e restaura leilão na lista). */
export async function cancelPendingCloudDelete(localId: number): Promise<void> {
  await removeLeilaoDeleteFromQueue(localId);
  await updateLeilao(localId, { deleted: false, deleteBlocked: false });
}

function normalizeNome(nome: string) {
  return nome.trim().toLowerCase().replace(/\s+/g, " ");
}

async function findDuplicateNome(trimmed: string, excludeId?: number): Promise<Leilao | undefined> {
  const n = normalizeNome(trimmed);
  const all = await getAllLeiloes();
  return all.find(
    (l) =>
      !l.deleted &&
      l.id !== excludeId &&
      normalizeNome(l.nome) === n,
  );
}

/**
 * Offline-first: grava no IndexedDB, enfileira sync e tenta enviar na hora.
 */
export async function updateLeilaoNome(localId: number, nome: string): Promise<UpdateLeilaoResult> {
  const trimmed = nome.trim();
  if (!trimmed) {
    throw new Error("Informe o nome do leilão.");
  }

  const leilao = await getLeilaoById(localId);
  if (!leilao || leilao.deleted) {
    throw new Error("Leilão não encontrado.");
  }

  const dup = await findDuplicateNome(trimmed, localId);
  if (dup) {
    throw new Error("Já existe um leilão com este nome.");
  }

  await updateLeilao(localId, { nome: trimmed, updatedAt: Date.now() });

  if (leilao.supabaseId != null) {
    await addToQueue({
      type: "update",
      entity: "leilao",
      payload: { localId },
    });
  }

  await triggerProcessQueue();

  const fresh = await getLeilaoById(localId);
  const cloudOk = fresh?.supabaseId != null;
  return { ok: true, cloudOk };
}

export async function createLeilao(nome: string): Promise<CreateLeilaoResult> {
  const trimmed = nome.trim();
  if (!trimmed) {
    throw new Error("Informe o nome do leilão.");
  }

  const dup = await findDuplicateNome(trimmed);
  if (dup) {
    throw new Error("Já existe um leilão com este nome.");
  }

  const createdSnap = await getCreatedBySnapshot();

  const nowMs = Date.now();
  const localKey = await addLeilao({
    nome: trimmed,
    createdAt: new Date(),
    supabaseId: null,
    createdBy: createdSnap.displayName,
    createdByUserId: createdSnap.userId != null ? String(createdSnap.userId) : null,
    updatedAt: nowMs,
  });

  await addToQueue({
    type: "create",
    entity: "leilao",
    payload: { localId: localKey },
  });

  await triggerProcessQueue();

  const leilao = await getLeilaoById(localKey);
  if (!leilao) {
    throw new Error("Erro ao salvar leilão localmente.");
  }

  const cloudOk = leilao.supabaseId != null;
  return {
    leilao,
    cloudOk,
    error: cloudOk ? undefined : "Pendente de sincronização (offline ou Supabase indisponível).",
  };
}

/**
 * Sincroniza um leilão sem id na nuvem (botão manual ou fila).
 */
export async function syncLeilaoToCloud(localId: number): Promise<SyncLeilaoResult> {
  const leilao = await getLeilaoById(localId);
  if (!leilao || leilao.deleted) {
    return { ok: false, error: "Leilão não encontrado." };
  }
  if (leilao.supabaseId != null) {
    await removeLeilaoCreateFromQueue(localId);
    return { ok: true };
  }

  const snap = await getCreatedBySnapshot();
  const createdBy = leilao.createdBy?.trim() || snap.displayName;

  const { data, error } = await supabase
    .from("leiloes")
    .insert({
      nome: leilao.nome.trim(),
      created_by: createdBy,
    })
    .select("id, nome, created_at, updated_at")
    .maybeSingle();

  if (error) {
    console.error("Erro ao sincronizar leilão:", error);
    return { ok: false, error: error.message };
  }

  if (data == null || data.id == null) {
    return { ok: false, error: "Resposta do Supabase sem id." };
  }

  const sid = Number(data.id);
  const row = data as { updated_at?: string | null };
  const updatedAt = supabaseTimestampToMs(row.updated_at);
  await updateLeilao(localId, {
    supabaseId: sid,
    createdBy,
    createdByUserId: leilao.createdByUserId ?? (snap.userId != null ? String(snap.userId) : null),
    updatedAt: updatedAt > 0 ? updatedAt : Date.now(),
  });
  await removeLeilaoCreateFromQueue(localId);
  return { ok: true };
}

/**
 * Sem supabaseId: remove local + fila.
 * Com supabaseId: marca `deleted`, enfileira delete na nuvem.
 */
export async function deleteLeilao(localId: number): Promise<DeleteLeilaoResult> {
  await assertCanDeleteLeilao();

  const leilao = await getLeilaoById(localId);
  if (!leilao || leilao.deleted) {
    throw new Error("Leilão não encontrado.");
  }

  if (leilao.supabaseId == null) {
    await removeQueueItemsForLeilao(localId);
    await deleteVistoriasByLeilao(localId);
    await deleteLeilaoFromDb(localId);
    return { ok: true };
  }

  await updateLeilao(localId, { deleted: true, deleteBlocked: false });
  await ensureLeilaoDeleteQueued(localId);

  await triggerProcessQueue();

  return { ok: true, pendingCloudDelete: true };
}
