import { useState, useEffect, useCallback } from 'react';
import {
  getAllLeiloes,
  getVistoriasByLeilao,
  getVistoriaById,
  countVistoriasToday,
  countVistorias,
  mergeLeiloesFromCloudRows,
  type Leilao,
  type Vistoria,
} from '@/lib/db';
import {
  createLeilao as createLeilaoApi,
  updateLeilaoNome as updateLeilaoNomeApi,
  deleteLeilao as deleteLeilaoApi,
  syncLeilaoToCloud as syncLeilaoToCloudApi,
} from '@/services/leilaoService';
import { supabase } from '@/services/supabaseClient';
import { supabaseTimestampToMs } from '@/services/syncConflict';
import { ensureRealtimeStarted, subscribeRealtimeUi } from '@/services/realtimeService';

export { addVistoria, updateVistoria, deleteVistoria, getVistoriaById } from '@/lib/db';

type SupabaseLeilaoRow = {
  id: number;
  nome: string;
  created_at?: string | null;
  updated_at?: string | null;
  created_by?: string | null;
};

function mapSupabaseRowToLeilao(row: SupabaseLeilaoRow): Leilao & { id: number } {
  const id = Number(row.id);
  const updatedAt = row.updated_at != null ? supabaseTimestampToMs(row.updated_at) : undefined;
  return {
    id,
    nome: String(row.nome ?? '').trim() || '(sem nome)',
    supabaseId: id,
    createdAt: row.created_at ? new Date(row.created_at) : undefined,
    updatedAt: updatedAt !== undefined && updatedAt > 0 ? updatedAt : undefined,
    createdBy: row.created_by ?? null,
  };
}

/** Lista para UI: nuvem + pendentes locais (sem apagar id local das vistorias). */
function buildMergedLeiloesList(
  cloudMapped: (Leilao & { id: number })[],
  localAll: Leilao[],
): Leilao[] {
  const cloud = Array.isArray(cloudMapped) ? cloudMapped : [];
  const locals = Array.isArray(localAll) ? localAll : [];
  const activeLocal = locals.filter((l) => !l.deleted);
  const result: Leilao[] = [];
  const seen = new Set<number>();

  for (const c of cloud) {
    const tomb = locals.find(
      (l) => l.deleted && (l.supabaseId === c.id || l.id === c.id),
    );
    if (tomb) continue;

    const local = activeLocal.find((l) => l.supabaseId === c.id || l.id === c.id);
    if (local?.id != null) {
      result.push({
        ...local,
        nome: c.nome,
        supabaseId: c.id,
        createdBy: c.createdBy ?? local.createdBy,
        updatedAt: c.updatedAt ?? local.updatedAt,
      });
      seen.add(local.id);
    } else {
      result.push(c);
      seen.add(c.id);
    }
  }

  for (const l of activeLocal) {
    if (l.supabaseId == null && l.id != null && !seen.has(l.id)) {
      result.push(l as Leilao & { id: number });
      seen.add(l.id);
    }
  }

  result.sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
  return result;
}

export function useLeiloes() {
  const [leiloes, setLeiloes] = useState<Leilao[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const { data, error } = await supabase
        .from('leiloes')
        .select('*')
        .order('nome', { ascending: true });

      const rows = (data ?? []) as SupabaseLeilaoRow[];

      if (!error) {
        const mapped = rows
          .filter((r) => r.id != null && Number.isFinite(Number(r.id)))
          .map(mapSupabaseRowToLeilao);
        await mergeLeiloesFromCloudRows(mapped);
        const localAll = await getAllLeiloes();
        const merged = buildMergedLeiloesList(mapped, localAll);
        const out = (Array.isArray(merged) ? merged : []).filter((l) => !l.deleted);
        if (import.meta.env.DEV) console.log('DEBUG lista leiloes:', out);
        setLeiloes(out);
        return;
      }

      if (import.meta.env.DEV) {
        console.warn("Leilões: Supabase indisponível, usando IndexedDB", error);
      }
      const local = await getAllLeiloes();
      const list = Array.isArray(local) ? [...local] : [];
      list.sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
      const offlineList = list.filter((l) => !l.deleted);
      if (import.meta.env.DEV) console.log('DEBUG lista leiloes:', offlineList);
      setLeiloes(offlineList);
    } catch (e) {
      if (import.meta.env.DEV) {
        console.warn("Leilões: erro de rede, usando IndexedDB", e);
      }
      try {
        const local = await getAllLeiloes();
        const list = Array.isArray(local) ? [...local] : [];
        list.sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
        const errList = list.filter((l) => !l.deleted);
        if (import.meta.env.DEV) console.log('DEBUG lista leiloes:', errList);
        setLeiloes(errList);
      } catch {
        if (import.meta.env.DEV) console.log('DEBUG lista leiloes:', []);
        setLeiloes([]);
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    ensureRealtimeStarted();
    return subscribeRealtimeUi(() => {
      void refresh({ silent: true });
    });
  }, [refresh]);

  const createLeilao = useCallback(
    async (nome: string) => {
      const result = await createLeilaoApi(nome);
      await refresh();
      return result;
    },
    [refresh],
  );

  const updateLeilaoNome = useCallback(
    async (localId: number, nome: string) => {
      const result = await updateLeilaoNomeApi(localId, nome);
      if (result.ok) await refresh();
      return result;
    },
    [refresh],
  );

  const deleteLeilao = useCallback(
    async (localId: number) => {
      const result = await deleteLeilaoApi(localId);
      if (result.ok) await refresh();
      return result;
    },
    [refresh],
  );

  const syncLeilaoToCloud = useCallback(
    async (localId: number) => {
      const result = await syncLeilaoToCloudApi(localId);
      await refresh();
      return result;
    },
    [refresh],
  );

  return {
    leiloes: leiloes ?? [],
    loading,
    refresh,
    createLeilao,
    updateLeilaoNome,
    deleteLeilao,
    syncLeilaoToCloud,
  };
}

export function useVistorias(leilaoId: number | null) {
  const [vistorias, setVistorias] = useState<Vistoria[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!leilaoId) {
      setVistorias([]);
      setLoading(false);
      return;
    }
    if (!opts?.silent) setLoading(true);
    try {
      const online = typeof navigator === 'undefined' || navigator.onLine;
      if (online) {
        const { fetchAndMergeVistoriasFromCloudForLeilao } = await import(
          '@/services/inspectionService'
        );
        const merged = await fetchAndMergeVistoriasFromCloudForLeilao(leilaoId);
        if (!merged.ok && import.meta.env.DEV) {
          console.warn(
            'Vistorias: nuvem indisponível ou leilão sem id no servidor — usando IndexedDB',
          );
        }
      }

      const data = await getVistoriasByLeilao(leilaoId);
      const safe = Array.isArray(data) ? data : [];
      if (import.meta.env.DEV) console.log('DEBUG lista vistorias:', safe);
      setVistorias(safe);
    } catch (e) {
      if (import.meta.env.DEV) {
        console.warn('Vistorias: erro ao carregar, tentando só IndexedDB', e);
      }
      try {
        const data = await getVistoriasByLeilao(leilaoId);
        const safe = Array.isArray(data) ? data : [];
        setVistorias(safe);
      } catch {
        if (import.meta.env.DEV) console.log('DEBUG lista vistorias:', []);
        setVistorias([]);
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [leilaoId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    ensureRealtimeStarted();
    return subscribeRealtimeUi(() => {
      void refresh({ silent: true });
    });
  }, [refresh]);

  return { vistorias: vistorias ?? [], loading, refresh };
}

export function useTodayCount(leilaoId: number | null) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!leilaoId) return;
    countVistoriasToday(leilaoId).then(setCount);
  }, [leilaoId]);

  return count;
}

export function useTotalCount(leilaoId: number | null) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!leilaoId) return;
    countVistorias(leilaoId).then(setCount);
  }, [leilaoId]);

  return count;
}

export function useVistoriador() {
  const [vistoriador, setVistoriador] = useState(() =>
    localStorage.getItem('vistoriador') || ''
  );

  const save = useCallback((name: string) => {
    setVistoriador(name);
    localStorage.setItem('vistoriador', name);
  }, []);

  return { vistoriador, setVistoriador: save };
}
