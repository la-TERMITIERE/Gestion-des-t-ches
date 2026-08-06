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

-- ── 0018 : retour / transfert d'une tâche par son destinataire ─────
-- « new row violates row-level security policy for table "tasks" » : lors d'un
-- UPDATE, Postgres applique la policy SELECT en WITH CHECK sur la NOUVELLE ligne.
-- Retourner la tâche la réassigne à un tiers → celui qui la retourne ne la voit
-- plus → refus. Correctif : une RPC SECURITY DEFINER qui contourne la RLS après
-- sa propre vérification d'autorisation (les policies restent strictes).
drop policy if exists tasks_update on tasks;   -- restaure l'état sûr de 0002
create policy tasks_update on tasks for update to authenticated
  using      (my_role() = 'chef' or assigned_by_id = auth.uid() or recipient_id = auth.uid())
  with check (my_role() = 'chef' or assigned_by_id = auth.uid() or recipient_id = auth.uid());

create or replace function return_task(
    p_task_id text, p_new_recipient_id uuid, p_new_recipient_name text,
    p_new_department text, p_note text)
returns text language plpgsql security definer set search_path = public as $fn$
declare prev_name text; cur_rid uuid; cur_stat text;
begin
  select recipient_id, recipient_name, status into cur_rid, prev_name, cur_stat
    from tasks where id = p_task_id;
  if not found then raise exception 'Tâche introuvable.'; end if;
  if not (my_role() = 'chef' or cur_rid = auth.uid()) then
    raise exception 'Seul le destinataire actuel ou le Chef Admin peut retourner cette tâche.'; end if;
  if cur_stat = 'Terminé' then raise exception 'Impossible de retourner une tâche terminée.'; end if;
  update tasks set recipient_id = p_new_recipient_id, recipient_name = p_new_recipient_name,
                   department = coalesce(p_new_department,''), status = 'À faire', progress = 0,
                   close_date = null, comment = '', chef_comment = p_note
   where id = p_task_id;
  return prev_name;
end $fn$;
grant execute on function return_task(text, uuid, text, text, text) to authenticated;
