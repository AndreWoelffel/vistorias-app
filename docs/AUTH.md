# Usuários e permissões (modo simples)

## Catálogo (`User` no IndexedDB)

- Tipo: `{ id, nome, role: "admin" | "user" }`.
- API em `src/lib/db.ts`: `getUsers()`, `addUser()`, `getUsuarioById()`, `seedUsuarios()`, etc.

## Usuário atual

- **Persistência:** `localStorage` (`vistoria_current_user_id`) aponta para o `id` no IndexedDB.
- **Serviço:** `src/services/currentUserService.ts` — `getCurrentUser()`, `setCurrentUser(id)`, `assertCanDeleteLeilao()`.
- **Hook:** `useCurrentUser()` — estado reativo + `refresh` + `setCurrentUser(id)`.
- Se não houver id salvo ou o id for inválido, escolhe o **primeiro admin** ou o **primeiro usuário** da lista.

## Exclusão de leilões

- UI: `LeiloesPage` usa `currentUser.role === "admin"` e botão desabilitado + tooltip para não-admin.
- **Servidor de verdade no código:** `deleteLeilao()` em `leilaoService.ts` chama `assertCanDeleteLeilao()` no início.

## Login PIN (`useAuth`)

- Continua existindo para fluxo de vistoria (nome no app). **Não** define permissão de excluir leilão; isso é só o **usuário atual** do catálogo.

## Futuro: Supabase Auth

1. Substituir `currentUserService` por sessão `supabase.auth.getUser()` + tabela `profiles` (`role`).
2. Manter `assertCanDeleteLeilao()` como função única de checagem, mudando só a implementação interna.
