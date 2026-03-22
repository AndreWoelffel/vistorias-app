-- Habilita Realtime nas tabelas usadas pelo app (rode se ainda não estiverem na publication).
-- No Dashboard: Database → Replication → marcar leiloes e vistorias (mais simples).

alter publication supabase_realtime add table public.leiloes;
alter publication supabase_realtime add table public.vistorias;
