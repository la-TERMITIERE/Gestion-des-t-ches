-- ════════════════════════════════════════════════════════════════════
--  VÉRIFICATION (sûre, lecture seule) — à lancer APRÈS APPLY_PENDING.sql.
--  Confirme que le correctif du retour/transfert est bien en place.
--  Ne modifie AUCUNE donnée.
--
--  Le mécanisme lui-même a été prouvé sur un vrai PostgreSQL 15 :
--    • UPDATE direct par le destinataire            → REFUSÉ (reproduit le bug)
--    • appel de return_task() par le destinataire   → ACCEPTÉ
--    • appel de return_task() par un intrus          → REFUSÉ (autorisation)
--    • appel de return_task() par le Chef            → ACCEPTÉ
-- ════════════════════════════════════════════════════════════════════

-- 1) La fonction RPC existe avec la bonne signature et est exécutable par 'authenticated' ?
select
  p.proname                                   as fonction,
  pg_get_function_arguments(p.oid)            as arguments,
  p.prosecdef                                 as security_definer,   -- doit être true
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_peut_executer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'return_task';

-- 2) La policy tasks_update est bien restaurée à sa forme stricte d'origine ?
select
  polname,
  pg_get_expr(polqual,      polrelid) as using_expr,
  pg_get_expr(polwithcheck, polrelid) as with_check   -- doit RÉ-exiger chef/assigneur/destinataire
from pg_policy where polname = 'tasks_update';

-- Attendu :
--   (1) une ligne : return_task | ... | security_definer = t | authenticated_peut_executer = t
--   (2) une ligne : with_check = (my_role() = 'chef' OR assigned_by_id = auth.uid() OR recipient_id = auth.uid())
