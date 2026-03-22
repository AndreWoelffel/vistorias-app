import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Plus, Gavel, Trash2, RefreshCw, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AppHeader } from "@/components/AppHeader";
import { useLeiloes } from "@/hooks/useVistorias";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/use-toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { countVistorias } from "@/lib/db";
import { processQueue, subscribeSyncUi } from "@/services/syncService";
import {
  resumeLeilaoCloudDelete,
  cancelPendingCloudDelete,
} from "@/services/leilaoService";
import type { Leilao } from "@/lib/db";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function formatDate(d: Date | undefined) {
  if (!d || Number.isNaN(d.getTime())) return "—";
  return new Date(d).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type DeleteTarget = {
  id: number;
  nome: string;
  vistoriasCount: number;
};

export default function LeiloesPage() {
  const navigate = useNavigate();
  const { currentUser, loading: loadingUser } = useCurrentUser();
  const canDeleteLeiloes = currentUser?.role === "admin";
  const {
    leiloes,
    loading,
    refresh,
    createLeilao,
    updateLeilaoNome,
    deleteLeilao,
    syncLeilaoToCloud,
  } = useLeiloes();

  useEffect(() => {
    const unsub = subscribeSyncUi(() => {
      void refresh();
    });
    return unsub;
  }, [refresh]);
  const safeList = (leiloes ?? []).filter(
    (l) =>
      !l.deleted &&
      l.id != null &&
      Number.isFinite(l.id) &&
      (l.id as number) > 0,
  );

  const [vistoriaCounts, setVistoriaCounts] = useState<Record<number, number>>({});

  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    (async () => {
      const next: Record<number, number> = {};
      for (const l of leiloes ?? []) {
        if (l.id != null && Number.isFinite(l.id) && l.id > 0) {
          next[l.id] = await countVistorias(l.id);
        }
      }
      if (!cancelled) setVistoriaCounts(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, leiloes]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [nome, setNome] = useState("");
  const [saving, setSaving] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editNome, setEditNome] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [syncingId, setSyncingId] = useState<number | null>(null);

  const busy = saving || savingEdit || deleting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = nome.trim();
    if (!trimmed) {
      toast({ title: "Nome obrigatório", description: "Digite um nome para o leilão.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const { cloudOk, error } = await createLeilao(trimmed);
      if (cloudOk) {
        toast({
          title: "Leilão criado",
          description: "Sincronizado com o Supabase.",
        });
      } else {
        toast({
          title: "Salvo apenas no aparelho",
          description:
            error ??
            "Não foi possível enviar ao Supabase. Use “Sincronizar” depois ou verifique policies/RLS.",
        });
      }
      setNome("");
      setDialogOpen(false);
    } catch (err) {
      console.error(err);
      toast({
        title: "Não foi possível salvar",
        description: err instanceof Error ? err.message : "Tente novamente.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (l: Leilao) => {
    if (l.id == null) return;
    setEditId(l.id);
    setEditNome(l.nome);
    setEditOpen(true);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editId == null) return;
    const trimmed = editNome.trim();
    if (!trimmed) {
      toast({ title: "Nome obrigatório", variant: "destructive" });
      return;
    }
    setSavingEdit(true);
    try {
      const result = await updateLeilaoNome(editId, trimmed);
      if (!result.ok) {
        toast({
          title: "Não foi possível atualizar",
          description: result.error ?? "Tente novamente.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Leilão atualizado",
        description: result.cloudOk
          ? "Salvo no aparelho e no Supabase."
          : "Salvo no aparelho (após sincronizar, o nome estará na nuvem).",
      });
      setEditOpen(false);
      setEditId(null);
    } catch (err) {
      console.error(err);
      toast({
        title: "Erro",
        description: err instanceof Error ? err.message : "Tente novamente.",
        variant: "destructive",
      });
    } finally {
      setSavingEdit(false);
    }
  };

  const openDelete = async (id: number, nomeLeilao: string) => {
    const vistoriasCount = await countVistorias(id);
    setDeleteTarget({ id, nome: nomeLeilao, vistoriasCount });
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await deleteLeilao(deleteTarget.id);

      if (!result.ok && result.cloudError) {
        toast({
          title: "Não foi possível concluir",
          description: result.cloudError,
          variant: "destructive",
        });
        setDeleteTarget(null);
        return;
      }

      if (result.ok) {
        if (result.pendingCloudDelete) {
          toast({
            title: "Leilão removido da lista",
            description:
              "A exclusão na nuvem será concluída ao sincronizar. Se houver vistorias no servidor, a operação pode falhar e o leilão voltará a aparecer.",
          });
        } else {
          toast({
            title: "Leilão excluído",
            description: "Removido do aparelho.",
          });
        }
      }
      setDeleteTarget(null);
    } catch (err) {
      console.error(err);
      toast({
        title: "Erro ao excluir",
        description: err instanceof Error ? err.message : "Tente novamente.",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleSync = async (localId: number) => {
    setSyncingId(localId);
    try {
      const { ok, error } = await syncLeilaoToCloud(localId);
      if (ok) {
        await processQueue();
        toast({ title: "Sincronizado", description: "Leilão enviado ao Supabase." });
      } else {
        toast({
          title: "Falha na sincronização",
          description: error ?? "Verifique conexão e policies em public.leiloes.",
          variant: "destructive",
        });
      }
    } catch (err) {
      console.error(err);
      toast({ title: "Erro", description: "Tente novamente.", variant: "destructive" });
    } finally {
      setSyncingId(null);
    }
  };

  const isSynced = (l: (typeof safeList)[0]) => l.supabaseId != null;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader title="Leilões" showBack onBack={() => navigate("/")} />

      <div className="px-4 pt-2">
        <p className="text-xs text-muted-foreground">
          Usuário atual:{" "}
          {loadingUser ? (
            "…"
          ) : currentUser ? (
            <>
              <span className="font-semibold text-foreground">{currentUser.nome}</span> ({currentUser.role})
            </>
          ) : (
            "—"
          )}
        </p>
      </div>

      <div className="flex-1 p-4 space-y-4">
        <Button
          className="w-full h-12 gap-2 font-semibold rounded-xl"
          onClick={() => setDialogOpen(true)}
          disabled={busy}
        >
          <Plus className="h-5 w-5" />
          Novo Leilão
        </Button>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm">Carregando leilões...</p>
          </div>
        ) : safeList.length === 0 ? (
          <div className="card-glow rounded-xl bg-card p-8 text-center space-y-2">
            <Gavel className="h-10 w-10 mx-auto text-muted-foreground opacity-50" />
            <p className="text-sm font-semibold text-foreground">Nenhum leilão cadastrado</p>
            <p className="text-xs text-muted-foreground">
              Toque em &quot;Novo Leilão&quot; para criar o primeiro e evitar erros de vínculo na nuvem.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {safeList.map((l) => {
              const vid = l.id as number;
              const nVis = vistoriaCounts[vid] ?? 0;
              return (
                <li
                  key={l.id}
                  className="card-glow rounded-xl bg-card p-4 border border-border/60 flex flex-col gap-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-foreground">
                        {l.nome}
                        <span className="font-normal text-muted-foreground text-sm">
                          {" "}
                          ({nVis} {nVis === 1 ? "vistoria" : "vistorias"})
                        </span>
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        {isSynced(l) ? (
                          <Badge variant="default" className="text-[10px]">
                            Sincronizado
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">
                            Local
                          </Badge>
                        )}
                        {l.deleteBlocked ? (
                          <Badge variant="destructive" className="text-[10px]">
                            Exclusão bloqueada
                          </Badge>
                        ) : null}
                      </div>
                      {l.deleteBlocked ? (
                        <div className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground">
                          <p className="font-semibold text-destructive">
                            Este leilão não pode ser excluído pois possui vistorias na nuvem
                          </p>
                          <p className="mt-1 text-muted-foreground">
                            Remova ou reatribua as vistorias no Supabase e tente novamente, ou cancele a exclusão
                            pendente.
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              className="h-8 text-[11px]"
                              disabled={busy}
                              onClick={async () => {
                                if (l.id == null) return;
                                setSyncingId(l.id);
                                try {
                                  await resumeLeilaoCloudDelete(l.id);
                                  await refresh();
                                  toast({
                                    title: "Tentativa reenviada",
                                    description: "Sincronizando exclusão na nuvem…",
                                  });
                                } catch (e) {
                                  console.error(e);
                                  toast({
                                    title: "Erro",
                                    description: e instanceof Error ? e.message : "Tente novamente.",
                                    variant: "destructive",
                                  });
                                } finally {
                                  setSyncingId(null);
                                }
                              }}
                            >
                              Tentar excluir novamente
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-8 text-[11px]"
                              disabled={busy}
                              onClick={async () => {
                                if (l.id == null) return;
                                try {
                                  await cancelPendingCloudDelete(l.id);
                                  await refresh();
                                  toast({
                                    title: "Exclusão cancelada",
                                    description: "O leilão permanece na lista.",
                                  });
                                } catch (e) {
                                  console.error(e);
                                  toast({
                                    title: "Erro",
                                    description: e instanceof Error ? e.message : "Tente novamente.",
                                    variant: "destructive",
                                  });
                                }
                              }}
                            >
                              Cancelar exclusão
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                        <span>
                          <span className="font-semibold text-foreground/80">ID local:</span> {l.id}
                        </span>
                        {l.supabaseId != null && (
                          <span>
                            <span className="font-semibold text-foreground/80">ID nuvem:</span> {l.supabaseId}
                          </span>
                        )}
                        <span>
                          <span className="font-semibold text-foreground/80">Data:</span>{" "}
                          {formatDate(
                            l.createdAt instanceof Date
                              ? l.createdAt
                              : l.createdAt
                                ? new Date(l.createdAt as unknown as string)
                                : undefined,
                          )}
                        </span>
                        {l.createdBy && (
                          <span className="w-full sm:w-auto">
                            <span className="font-semibold text-foreground/80">Criado por:</span>{" "}
                            {l.createdBy}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1.5">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-8 gap-1 text-[11px]"
                        disabled={busy || syncingId === l.id}
                        onClick={() => openEdit(l)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Editar
                      </Button>
                      {!isSynced(l) && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="h-8 gap-1 text-[11px]"
                          disabled={busy || syncingId === l.id}
                          onClick={() => l.id != null && handleSync(l.id)}
                        >
                          {syncingId === l.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                          )}
                          Sincronizar
                        </Button>
                      )}
                      {canDeleteLeiloes ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1 text-[11px] text-destructive border-destructive/40 hover:bg-destructive/10"
                          disabled={busy}
                          onClick={() => l.id != null && openDelete(l.id, l.nome)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Excluir
                        </Button>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex w-full justify-stretch">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1 text-[11px] w-full opacity-50"
                                disabled
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Excluir
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="left">Apenas administradores podem excluir</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(o) => !busy && setDialogOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Novo leilão</DialogTitle>
              <DialogDescription>
                O nome será salvo no aparelho e enviado ao Supabase quando possível.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <label className="text-xs font-semibold text-muted-foreground">Nome</label>
              <Input
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder="Ex.: Leilão SP — Fevereiro 2026"
                className="mt-1 h-11"
                autoFocus
                disabled={saving}
              />
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)} disabled={saving}>
                Cancelar
              </Button>
              <Button type="submit" disabled={saving || !nome.trim()}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editOpen}
        onOpenChange={(o) => {
          if (savingEdit) return;
          setEditOpen(o);
          if (!o) setEditId(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleEditSubmit}>
            <DialogHeader>
              <DialogTitle>Editar leilão</DialogTitle>
              <DialogDescription>
                Altera o nome no aparelho e no Supabase quando o leilão estiver sincronizado.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <label className="text-xs font-semibold text-muted-foreground">Nome</label>
              <Input
                value={editNome}
                onChange={(e) => setEditNome(e.target.value)}
                className="mt-1 h-11"
                autoFocus
                disabled={savingEdit}
              />
            </div>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setEditOpen(false);
                  setEditId(null);
                }}
                disabled={savingEdit}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={savingEdit || !editNome.trim()}>
                {savingEdit ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget != null} onOpenChange={(o) => !o && !deleting && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir leilão?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              {deleteTarget && deleteTarget.vistoriasCount > 0 ? (
                <p>
                  Este leilão possui <strong className="text-foreground">{deleteTarget.vistoriasCount}</strong>{" "}
                  vistoria(s) neste aparelho. Deseja realmente excluir? As vistorias locais vinculadas serão
                  removidas.
                </p>
              ) : (
                <p>
                  O leilão <strong className="text-foreground">{deleteTarget?.nome}</strong> será excluído do
                  aparelho e, se estiver na nuvem, também no Supabase.
                </p>
              )}
              {deleteTarget && deleteTarget.vistoriasCount > 0 && (
                <p className="text-amber-600 dark:text-amber-400 text-sm">Esta ação não pode ser desfeita.</p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={deleting} onClick={() => confirmDelete()}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Excluir"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
