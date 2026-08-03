-- ✨ v7.0.1 — deux blocages RLS constatés en production. Rejouable sans risque.
--
-- ════════════════════════════════════════════════════════════════════
-- 1) « new row violates row-level security policy for table "reports" »
-- ════════════════════════════════════════════════════════════════════
-- L'INSERT passait : c'est le RETURNING (`.select()` après insert) qui échouait.
-- Postgres applique aussi la policy SELECT aux lignes renvoyées, et celle de 0013
-- déléguait à `can_see_report(id)` — une fonction **stable** qui relit `reports`.
-- Une fonction stable travaille sur l'instantané pris AVANT la commande en cours :
-- la ligne qu'on vient d'insérer y est donc invisible, la policy renvoie faux, et
-- l'insertion entière est rejetée.
--
-- Correctif : tester `author_id` directement sur la ligne (pas de relecture de la
-- table), et ne déléguer à une fonction SECURITY DEFINER que la partie
-- « destinataires », qui interroge une AUTRE table — ce qui préserve la protection
-- contre la récursion reports ↔ report_recipients qui motivait 0013.

create or replace function i_am_report_recipient(p_report_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from report_recipients rr
    where rr.report_id = p_report_id and rr.viewer_id = auth.uid()
  );
$$;

drop policy if exists reports_select on reports;
create policy reports_select on reports for select to authenticated
  using (
       my_role() = 'chef'          -- supervision
    or author_id = auth.uid()      -- l'auteur : lu sur la ligne elle-même
    or i_am_report_recipient(id)   -- destinataire explicitement coché
  );

-- ════════════════════════════════════════════════════════════════════
-- 2) Tâches d'équipe : erreur affichée alors que la tâche est créée
-- ════════════════════════════════════════════════════════════════════
-- `team_write` exigeait `i_am_team_member(task_id)` pour écrire dans team_members.
-- Or les lignes insérées SONT la composition de l'équipe : au moment de l'INSERT,
-- personne n'est encore membre → la condition est fausse pour tout le monde sauf
-- le Chef. Comme api.js crée la tâche PUIS les membres en deux requêtes, la tâche
-- restait créée pendant que l'erreur s'affichait ; un second essai la dupliquait.
--
-- Correctif : celui qui a assigné la tâche peut en composer l'équipe.

create or replace function i_assigned_task(p_task_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from tasks t
    where t.id = p_task_id and t.assigned_by_id = auth.uid()
  );
$$;

drop policy if exists team_write on team_members;
create policy team_write on team_members for all to authenticated
  using       (my_role() = 'chef' or i_assigned_task(task_id) or i_am_team_member(task_id))
  with check  (my_role() = 'chef' or i_assigned_task(task_id) or i_am_team_member(task_id));
