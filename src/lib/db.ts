import { openDB, type IDBPDatabase } from 'idb';

export interface Leilao {
  id?: number;
  nome: string;
  createdAt?: Date;
  /** Id em public.leiloes no Supabase (FK em vistorias). null = ainda não existe na nuvem */
  supabaseId?: number | null;
  /** Quem criou o registro (nome); espelha coluna `created_by` no Supabase. */
  createdBy?: string | null;
  /** Futuro: UUID de auth.users / profiles; hoje string do id local do catálogo. */
  createdByUserId?: string | null;
  /** Exclusão lógica até confirmar delete na nuvem (offline-first). */
  deleted?: boolean;
  /** Exclusão na nuvem bloqueada por FK (há vistorias no servidor). */
  deleteBlocked?: boolean;
  /** Epoch ms — espelha `updated_at` do Supabase; last-write-wins na sync. */
  updatedAt?: number;
}

export type SyncQueueType = 'create' | 'update' | 'delete';

export type SyncQueueEntity = 'leilao' | 'vistoria';

export type SyncQueueItemStatus = 'pending' | 'failed';

export interface SyncQueueItem {
  id?: number;
  type: SyncQueueType;
  entity: SyncQueueEntity;
  payload: unknown;
  createdAt: number;
  retries: number;
  /** Estado persistente: `failed` após esgotar retries (ver `syncService.MAX_SYNC_RETRIES`). */
  status?: SyncQueueItemStatus;
  /** Legado: preferir `status === 'failed'`. */
  failed?: boolean;
  /** Epoch ms: só processar quando Date.now() >= isto (backoff). */
  nextAttemptAfter?: number;
  lastError?: string;
  /** Pausa retries (ex.: delete de leilão bloqueado por FK na nuvem). */
  retryPaused?: boolean;
}

/** Estados de sincronização da vistoria local (legado: `pendente` tratado como `pendente_sync`). */
export type VistoriaStatusSync =
  | 'rascunho'
  | 'pendente_sync'
  | 'sincronizado'
  | 'erro_sync'
  | 'conflito_duplicidade'
  /** Duplicidade local (ou a corrigir): não sincroniza até o usuário ajustar. */
  | 'aguardando_ajuste';

export interface Vistoria {
  id?: number;
  leilaoId: number;
  placa: string;
  numeroVistoria: string;
  vistoriador: string;
  fotos: Blob[];
  statusSync: VistoriaStatusSync | 'pendente' | 'sincronizado';
  createdAt: Date;
  /** UUID estável (gerado no app) → coluna `external_id` (text) no Supabase. */
  localUuid?: string;
  /** Quem criou (nome); espelha `created_by` em public.vistorias. */
  createdBy?: string | null;
  /** Futuro: UUID de auth; hoje id local do usuário catálogo como string. */
  createdByUserId?: string | null;
  /** Epoch ms — espelha `updated_at` do Supabase; last-write-wins na sync. */
  updatedAt?: number;
  /** PK UUID em `public.vistorias` (Realtime DELETE / rastreio). */
  cloudVistoriaId?: string;
  /** Mensagem curta para UI (erro de sync, duplicidade, etc.). */
  syncMessage?: string;
  /** Upload da foto ao Storage falhou (vistoria pode ter seguido sem URL). */
  fotoUploadFailed?: boolean;
}

/** Normaliza legado `pendente` → `pendente_sync` para lógica e UI. */
export function normalizeVistoriaStatusSync(
  s: Vistoria['statusSync'] | undefined,
): VistoriaStatusSync | 'sincronizado' {
  if (s === 'pendente') return 'pendente_sync';
  if (s === 'sincronizado') return 'sincronizado';
  if (
    s === 'rascunho' ||
    s === 'pendente_sync' ||
    s === 'erro_sync' ||
    s === 'conflito_duplicidade' ||
    s === 'aguardando_ajuste'
  ) {
    return s;
  }
  return 'pendente_sync';
}

/** Bloqueia envio à nuvem até correção (duplicidade local ou rejeição na sync). */
export function isVistoriaSyncBlockedByDuplicate(
  s: Vistoria['statusSync'] | undefined,
): boolean {
  const n = normalizeVistoriaStatusSync(s);
  return n === 'aguardando_ajuste' || n === 'conflito_duplicidade';
}

/** Catálogo local de usuários (futuro: alinhar a Supabase Auth / profiles). */
export type UserRole = 'admin' | 'user';

export type UsuarioRole = UserRole;

/** Registro com id garantido (uso na UI / permissões). */
export type User = {
  id: number;
  nome: string;
  role: UserRole;
};

/** Registro bruto no IndexedDB (id após persistência). */
export interface Usuario {
  id?: number;
  nome: string;
  role: UserRole;
}

function toUser(row: Usuario): User | null {
  if (row.id == null || !Number.isFinite(row.id)) return null;
  return { id: row.id, nome: row.nome, role: row.role };
}

let dbPromise: Promise<IDBPDatabase<any>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB('VistoriaDB', 11, {
      async upgrade(db, oldVersion, _newVersion, transaction) {
        /** v5: remove leilões antigos (ex.: seed/mock) e recria store — fonte de verdade passa a ser Supabase + cache local. */
        if (oldVersion > 0 && oldVersion < 5 && db.objectStoreNames.contains('leiloes')) {
          db.deleteObjectStore('leiloes');
        }
        if (!db.objectStoreNames.contains('leiloes')) {
          db.createObjectStore('leiloes', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('vistorias')) {
          const store = db.createObjectStore('vistorias', { keyPath: 'id', autoIncrement: true });
          store.createIndex('leilaoId', 'leilaoId');
          store.createIndex('placa', 'placa');
        }
        if (!db.objectStoreNames.contains('usuarios')) {
          db.createObjectStore('usuarios', { keyPath: 'id', autoIncrement: true });
        }
        /** v6: fila de sincronização offline-first */
        if (!db.objectStoreNames.contains('syncQueue')) {
          db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
        }
        /** v7/v8: vistorias usam localUuid; fila com failed/nextAttemptAfter — sem mudança de store. */
        /** v9: Leilao.updatedAt / Vistoria.updatedAt (ms) para conflitos com Supabase — só metadado no objeto. */
        /** v10: Vistoria.cloudVistoriaId — metadado no objeto (sem mudança de store). */
        /** v11: statusSync estendido; migrar `pendente` → `pendente_sync`. */
        if (oldVersion < 11 && db.objectStoreNames.contains('vistorias')) {
          const store = transaction.objectStore('vistorias');
          let cursor = await store.openCursor();
          while (cursor) {
            const v = cursor.value as Vistoria;
            if (v.statusSync === 'pendente') {
              await cursor.update({ ...v, statusSync: 'pendente_sync' } as Vistoria);
            }
            cursor = await cursor.continue();
          }
        }
      },
    });
  }
  return dbPromise;
}

export async function getAllLeiloes(): Promise<Leilao[]> {
  const db = await getDB();
  const rows = await db.getAll('leiloes');
  return Array.isArray(rows) ? rows : [];
}

export async function getLeilaoById(id: number): Promise<Leilao | undefined> {
  const db = await getDB();
  return db.get('leiloes', id) as Promise<Leilao | undefined>;
}

export async function addLeilao(row: Omit<Leilao, 'id'>): Promise<number> {
  const db = await getDB();
  const payload = {
    ...row,
    createdAt: row.createdAt ?? new Date(),
  };
  return db.add('leiloes', payload as any) as Promise<number>;
}

/** Grava leilão com id explícito (ex.: id retornado pelo Supabase). */
export async function putLeilao(row: Leilao & { id: number }): Promise<void> {
  const db = await getDB();
  await db.put('leiloes', row as any);
}

/** Substitui todos os leilões locais (ex.: após fetch do Supabase). */
export async function replaceAllLeiloes(rows: (Leilao & { id: number })[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('leiloes', 'readwrite');
  await tx.store.clear();
  for (const row of rows) {
    const payload = {
      ...row,
      createdAt: row.createdAt ?? new Date(),
    };
    await tx.store.put(payload as any);
  }
  await tx.done;
}

/**
 * Mescla um leilão vindo do Supabase sem apagar o id local (vistorias continuam com o mesmo leilaoId).
 */
export async function mergeLeilaoFromCloud(cloud: Leilao & { id: number }): Promise<void> {
  const db = await getDB();
  const all = await db.getAll('leiloes');
  const list = (Array.isArray(all) ? all : []) as Leilao[];
  const match = list.find((l) => l.supabaseId === cloud.id || l.id === cloud.id);
  if (match?.id != null) {
    const existing = (await db.get('leiloes', match.id)) as Leilao | undefined;
    if (!existing) return;
    if (existing.deleted) return;
    await db.put('leiloes', {
      ...existing,
      nome: cloud.nome,
      supabaseId: cloud.id,
      createdBy: cloud.createdBy ?? existing.createdBy,
      createdByUserId: cloud.createdByUserId ?? existing.createdByUserId,
      createdAt: cloud.createdAt ?? existing.createdAt ?? new Date(),
      updatedAt: cloud.updatedAt ?? existing.updatedAt,
      deleteBlocked: existing.deleteBlocked,
      id: match.id,
    } as any);
    return;
  }
  await db.put('leiloes', {
    ...cloud,
    supabaseId: cloud.id,
    createdAt: cloud.createdAt ?? new Date(),
    updatedAt: cloud.updatedAt,
  } as any);
}

export async function mergeLeiloesFromCloudRows(rows: (Leilao & { id: number })[]): Promise<void> {
  for (const row of rows) {
    await mergeLeilaoFromCloud(row);
  }
}

// --- Fila de sincronização ---

export async function addToQueue(
  item: Pick<SyncQueueItem, 'type' | 'entity' | 'payload'>,
): Promise<number> {
  const db = await getDB();
  const row: Omit<SyncQueueItem, 'id'> = {
    type: item.type,
    entity: item.entity,
    payload: item.payload,
    createdAt: Date.now(),
    retries: 0,
    status: 'pending',
  };
  return db.add('syncQueue', row as any) as Promise<number>;
}

export async function getQueue(): Promise<SyncQueueItem[]> {
  const db = await getDB();
  const rows = await db.getAll('syncQueue');
  const list = (Array.isArray(rows) ? rows : []) as SyncQueueItem[];
  return list.sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeFromQueue(id: number): Promise<void> {
  const db = await getDB();
  await db.delete('syncQueue', id);
}

export async function setSyncQueueItemRetryPaused(id: number, paused: boolean): Promise<void> {
  const db = await getDB();
  const row = (await db.get('syncQueue', id)) as SyncQueueItem | undefined;
  if (!row) return;
  await db.put('syncQueue', { ...row, retryPaused: paused } as any);
}

/** Remove da fila todas as operações `leilao/delete` para o id local. */
export async function removeLeilaoDeleteFromQueue(localLeilaoId: number): Promise<void> {
  const items = await getQueue();
  const db = await getDB();
  const tx = db.transaction('syncQueue', 'readwrite');
  for (const item of items) {
    if (item.id == null) continue;
    if (item.entity !== 'leilao' || item.type !== 'delete') continue;
    const p = item.payload as { localId?: number };
    if (p.localId === localLeilaoId) await tx.store.delete(item.id);
  }
  await tx.done;
}

/**
 * Registra falha na fila: incrementa retries e define `status: 'failed'` se esgotou tentativas.
 * O atraso entre tentativas é aplicado em `syncService` (linear: retries × 1s, máx. 5s).
 */
export async function applyQueueFailure(
  id: number,
  opts: {
    maxRetries: number;
    errorMessage?: string;
  },
): Promise<{ retries: number; permanentFailure: boolean }> {
  const db = await getDB();
  const row = (await db.get('syncQueue', id)) as SyncQueueItem | undefined;
  if (!row) return { retries: 0, permanentFailure: true };

  const retries = (row.retries ?? 0) + 1;
  const permanentFailure = retries >= opts.maxRetries;
  const status: SyncQueueItemStatus = permanentFailure ? 'failed' : 'pending';
  const lastError =
    opts.errorMessage != null && opts.errorMessage !== ''
      ? String(opts.errorMessage).slice(0, 500)
      : row.lastError;

  await db.put('syncQueue', {
    ...row,
    retries,
    status,
    failed: undefined,
    nextAttemptAfter: undefined,
    lastError,
  } as any);

  return { retries, permanentFailure };
}

/** Remove itens da fila ligados a um leilão (ex.: exclusão local antes de sync). */
/** Remove apenas itens `leilao/create` para um localId (após sync manual ou fila). */
export async function removeLeilaoCreateFromQueue(localId: number): Promise<void> {
  const items = await getQueue();
  const db = await getDB();
  const tx = db.transaction('syncQueue', 'readwrite');
  for (const item of items) {
    if (item.id == null) continue;
    if (item.entity !== 'leilao' || item.type !== 'create') continue;
    const p = item.payload as { localId?: number };
    if (p.localId === localId) await tx.store.delete(item.id);
  }
  await tx.done;
}

/** Evita vários `vistoria/update` pendentes para o mesmo registro local. */
export async function removeVistoriaUpdateFromQueue(localVistoriaId: number): Promise<void> {
  const items = await getQueue();
  const db = await getDB();
  const tx = db.transaction('syncQueue', 'readwrite');
  for (const item of items) {
    if (item.id == null) continue;
    if (item.entity !== 'vistoria' || item.type !== 'update') continue;
    const p = item.payload as { localVistoriaId?: number };
    if (p.localVistoriaId === localVistoriaId) await tx.store.delete(item.id);
  }
  await tx.done;
}

/** Remove `vistoria/create` pendentes para evitar duplicar após correção de conflito. */
export async function removeVistoriaCreateFromQueue(localVistoriaId: number): Promise<void> {
  const items = await getQueue();
  const db = await getDB();
  const tx = db.transaction('syncQueue', 'readwrite');
  for (const item of items) {
    if (item.id == null) continue;
    if (item.entity !== 'vistoria' || item.type !== 'create') continue;
    const p = item.payload as { localVistoriaId?: number };
    if (p.localVistoriaId === localVistoriaId) await tx.store.delete(item.id);
  }
  await tx.done;
}

export async function removeQueueItemsForLeilao(leilaoLocalId: number): Promise<void> {
  const items = await getQueue();
  const toDelete: number[] = [];
  for (const item of items) {
    if (item.id == null) continue;
    if (item.entity === 'leilao') {
      const p = item.payload as { localId?: number };
      if (p.localId === leilaoLocalId) toDelete.push(item.id);
    } else if (item.entity === 'vistoria') {
      const p = item.payload as { localVistoriaId?: number };
      if (p.localVistoriaId == null) continue;
      const v = await getVistoriaById(p.localVistoriaId);
      if (v?.leilaoId === leilaoLocalId) toDelete.push(item.id);
    }
  }
  const db = await getDB();
  const tx = db.transaction('syncQueue', 'readwrite');
  for (const qid of toDelete) await tx.store.delete(qid);
  await tx.done;
}

export async function updateLeilao(id: number, patch: Partial<Omit<Leilao, 'id'>>): Promise<void> {
  const db = await getDB();
  const existing = await db.get('leiloes', id);
  if (!existing) throw new Error('Leilão não encontrado');
  await db.put('leiloes', { ...existing, ...patch, id } as any);
}

export async function deleteLeilaoFromDb(id: number): Promise<void> {
  const db = await getDB();
  await db.delete('leiloes', id);
}

/** Remove todas as vistorias locais vinculadas ao leilão (antes de excluir o leilão). */
export async function deleteVistoriasByLeilao(leilaoId: number): Promise<void> {
  const db = await getDB();
  const all = await db.getAllFromIndex('vistorias', 'leilaoId', leilaoId);
  const list = (Array.isArray(all) ? all : []) as { id?: number }[];
  const tx = db.transaction('vistorias', 'readwrite');
  const store = tx.store;
  for (const v of list) {
    if (v.id != null) store.delete(v.id);
  }
  await tx.done;
}

export async function getVistoriasByLeilao(leilaoId: number): Promise<Vistoria[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex('vistorias', 'leilaoId', leilaoId);
  const list = (Array.isArray(all) ? all : []) as Vistoria[];
  return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getVistoriaById(id: number): Promise<Vistoria | undefined> {
  const db = await getDB();
  return db.get('vistorias', id) as Promise<Vistoria | undefined>;
}

export async function countVistoriasToday(leilaoId: number): Promise<number> {
  const all = await getVistoriasByLeilao(leilaoId);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return all.filter((v) => new Date(v.createdAt) >= today).length;
}

export async function countVistorias(leilaoId: number): Promise<number> {
  const all = await getVistoriasByLeilao(leilaoId);
  return all.length;
}

export async function addVistoria(data: Omit<Vistoria, 'id'>): Promise<number> {
  const db = await getDB();
  return db.add('vistorias', data as any) as Promise<number>;
}

export async function updateVistoria(id: number, data: Partial<Omit<Vistoria, 'id'>>): Promise<void> {
  const db = await getDB();
  const existing = await db.get('vistorias', id);
  if (!existing) throw new Error('Vistoria não encontrada');
  const updated = { ...existing, ...data };
  await db.put('vistorias', updated);
}

export async function deleteVistoria(id: number): Promise<void> {
  const db = await getDB();
  await db.delete('vistorias', id);
}

function readVistoriaStableUuid(v: Vistoria): string | undefined {
  const u = v.localUuid?.trim();
  if (u) return u;
  const legacy = (v as { externalId?: string }).externalId?.trim();
  return legacy || undefined;
}

/** Id local do leilão cujo `supabaseId` (ou id numérico alinhado à nuvem) corresponde ao FK da vistoria. */
export async function resolveLocalLeilaoIdForCloudFk(cloudLeilaoId: number): Promise<number | undefined> {
  if (!Number.isFinite(cloudLeilaoId)) return undefined;
  const all = await getAllLeiloes();
  const bySupa = all.find((l) => l.supabaseId === cloudLeilaoId && l.id != null);
  if (bySupa?.id != null) return bySupa.id;
  const byId = all.find((l) => l.id === cloudLeilaoId);
  if (byId?.id != null) return byId.id;
  return undefined;
}

export async function findVistoriaIdByExternalId(externalId: string): Promise<number | undefined> {
  const ext = externalId.trim();
  if (!ext) return undefined;
  const db = await getDB();
  const rows = await db.getAll('vistorias');
  const list = (Array.isArray(rows) ? rows : []) as Vistoria[];
  for (const v of list) {
    const u = readVistoriaStableUuid(v);
    if (u === ext && v.id != null) return v.id;
  }
  return undefined;
}

export async function findVistoriaIdByCloudId(cloudVistoriaId: string): Promise<number | undefined> {
  const id = cloudVistoriaId.trim();
  if (!id) return undefined;
  const db = await getDB();
  const rows = await db.getAll('vistorias');
  const list = (Array.isArray(rows) ? rows : []) as Vistoria[];
  for (const v of list) {
    if (v.cloudVistoriaId === id && v.id != null) return v.id;
  }
  return undefined;
}

// --- Usuários (catálogo local) ---

export async function getAllUsuarios(): Promise<Usuario[]> {
  const db = await getDB();
  const rows = await db.getAll('usuarios');
  return Array.isArray(rows) ? (rows as Usuario[]) : [];
}

/** Lista usuários com `id` definido (API simples). */
export async function getUsers(): Promise<User[]> {
  const rows = await getAllUsuarios();
  return (Array.isArray(rows) ? rows : []).map(toUser).filter((u): u is User => u != null);
}

export async function getUsuarioById(id: number): Promise<Usuario | undefined> {
  const db = await getDB();
  return db.get('usuarios', id) as Promise<Usuario | undefined>;
}

/** Garante pelo menos um registro de exemplo (admin). */
export async function seedUsuarios(): Promise<void> {
  const db = await getDB();
  const count = await db.count('usuarios');
  if (count === 0) {
    await db.add('usuarios', { nome: 'Administrador', role: 'admin' } as Omit<Usuario, 'id'>);
  }
}

export async function addUsuario(row: Omit<Usuario, 'id'>): Promise<number> {
  const db = await getDB();
  return db.add('usuarios', row as any) as Promise<number>;
}

/** Alias de `addUsuario` (API pedida). */
export async function addUser(row: Omit<User, 'id'>): Promise<number> {
  return addUsuario(row);
}

export async function updateUsuario(id: number, patch: Partial<Omit<Usuario, 'id'>>): Promise<void> {
  const db = await getDB();
  const existing = await db.get('usuarios', id);
  if (!existing) throw new Error('Usuário não encontrado');
  await db.put('usuarios', { ...existing, ...patch, id } as any);
}

export async function deleteUsuario(id: number): Promise<void> {
  const db = await getDB();
  await db.delete('usuarios', id);
}
