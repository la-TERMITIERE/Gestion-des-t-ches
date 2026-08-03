-- ══════════════════════════════════════════════════════════════════
--  LA TERMITIERE — SQL en attente. À coller dans Supabase → SQL Editor → Run.
--  Rejouable sans risque, ne touche à aucune donnée sauf pour archiver.
-- ══════════════════════════════════════════════════════════════════

-- ── 0016 : tâches d'équipe créables par un non-Chef (assigneur) ────
create or replace function i_assigned_task(p_task_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tasks t where t.id = p_task_id and t.assigned_by_id = auth.uid());
$$;

drop policy if exists team_write on team_members;
create policy team_write on team_members for all to authenticated
  using      (my_role() = 'chef' or i_assigned_task(task_id) or i_am_team_member(task_id))
  with check (my_role() = 'chef' or i_assigned_task(task_id) or i_am_team_member(task_id));

-- ── 0016 : lecture des rapports sans récursion (durcissement) ──────
create or replace function i_am_report_recipient(p_report_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from report_recipients rr where rr.report_id = p_report_id and rr.viewer_id = auth.uid());
$$;

drop policy if exists reports_select on reports;
create policy reports_select on reports for select to authenticated
  using (my_role() = 'chef' or author_id = auth.uid() or i_am_report_recipient(id));

-- ── 0017 : archivage automatique à 1 mois (au lieu de 3) ──────────
create or replace function archive_old_tasks() returns void
language sql security definer set search_path = public as $$
  update tasks set archived = true, archived_at = now()
   where status = 'Terminé' and archived = false and close_date is not null
     and close_date < (current_date - interval '1 month');
$$;
select archive_old_tasks();   -- archive tout de suite l'existant
