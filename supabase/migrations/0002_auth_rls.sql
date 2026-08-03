-- ════════════════════════════════════════════════════════════════════
--  RLS — visibilité & droits (réplique de shouldShowTaskTo / canUserEditTask)
--  L'identité vient du JWT signé par l'Edge Function auth-token :
--    auth.uid() = personnel.id
-- ════════════════════════════════════════════════════════════════════

-- ── Helpers d'identité (STABLE = mis en cache par requête) ───────────
create or replace function my_role() returns text language sql stable as $$
  select role_norm from personnel where id = auth.uid();
$$;

create or replace function my_name() returns text language sql stable as $$
  select name from personnel where id = auth.uid();
$$;

create or replace function i_see_all_tasks() returns boolean language sql stable as $$
  select coalesce(
    (select role_norm in ('chef','dir','rh') or is_assistant_rh(role_raw)
       from personnel where id = auth.uid()),
    false);
$$;

-- SECURITY DEFINER → ces fonctions contournent la RLS et évitent toute récursion
-- de politique entre tasks ↔ team_members.
create or replace function i_am_team_member(p_task_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from team_members tm
                where tm.task_id = p_task_id and tm.member_id = auth.uid());
$$;

create or replace function can_see_task(p_task_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from tasks t where t.id = p_task_id and (
         i_see_all_tasks()
      or t.recipient_id   = auth.uid()
      or t.assigned_by_id = auth.uid()
      or i_am_team_member(t.id)
    ));
$$;

-- ════════════════════════════════════════════════════════════════════
--  Activation RLS + privilèges
-- ════════════════════════════════════════════════════════════════════
alter table personnel                     enable row level security;
alter table personnel_auth                enable row level security;  -- aucune policy → service role uniquement
alter table tasks                         enable row level security;
alter table team_members                  enable row level security;
alter table messages                      enable row level security;
alter table objectives                    enable row level security;
alter table objective_comments            enable row level security;
alter table attachments                   enable row level security;
alter table daily_tasks                   enable row level security;
alter table daily_log                     enable row level security;
alter table holidays                      enable row level security;
alter table salary_authorizations         enable row level security;
alter table salary_external_beneficiaries enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- ── Personnel ────────────────────────────────────────────────────────
create policy personnel_select on personnel for select to authenticated
  using (auth.uid() is not null);
create policy personnel_insert on personnel for insert to authenticated
  with check (my_role() in ('chef','rh'));
create policy personnel_update on personnel for update to authenticated
  using (my_role() in ('chef','rh')) with check (my_role() in ('chef','rh'));
create policy personnel_delete on personnel for delete to authenticated
  using (my_role() = 'chef');

-- ── Tâches : visibilité = shouldShowTaskTo ───────────────────────────
create policy tasks_select on tasks for select to authenticated using (
     i_see_all_tasks()
  or recipient_id   = auth.uid()
  or assigned_by_id = auth.uid()
  or i_am_team_member(id)
);
-- Édition = canUserEditTask (chef, assigneur ou destinataire)
create policy tasks_update on tasks for update to authenticated using (
  my_role() = 'chef' or assigned_by_id = auth.uid() or recipient_id = auth.uid()
) with check (
  my_role() = 'chef' or assigned_by_id = auth.uid() or recipient_id = auth.uid()
);
-- Création : tout le monde peut au moins créer pour soi (canCreate = true)
create policy tasks_insert on tasks for insert to authenticated
  with check (auth.uid() is not null);
create policy tasks_delete on tasks for delete to authenticated
  using (my_role() = 'chef' or assigned_by_id = auth.uid());

-- ── Membres d'équipe / Messages : selon visibilité de la tâche ───────
create policy team_select on team_members for select to authenticated
  using (can_see_task(task_id));
create policy team_write on team_members for all to authenticated
  using (my_role() = 'chef' or i_am_team_member(task_id))
  with check (my_role() = 'chef' or i_am_team_member(task_id));

create policy messages_select on messages for select to authenticated
  using (can_see_task(task_id));
create policy messages_insert on messages for insert to authenticated
  with check (can_see_task(task_id));
create policy messages_delete on messages for delete to authenticated
  using (my_role() = 'chef' or author_name = my_name());

-- ── Objectifs (visibilité simplifiée : chef/dir/rh = tout ; sinon perso) ─
create policy obj_select on objectives for select to authenticated using (
  my_role() in ('chef','rh','dir','dept_head') or (type = 'perso' and target = my_name())
);
create policy obj_write on objectives for all to authenticated
  using (my_role() in ('chef','dir','dept_head','rh') or author_name = my_name() or target = my_name())
  with check (auth.uid() is not null);
create policy objc_select on objective_comments for select to authenticated using (true);
create policy objc_write  on objective_comments for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);

-- ── Pièces jointes : selon visibilité de la tâche ────────────────────
create policy att_select on attachments for select to authenticated
  using (can_see_task(task_id));
create policy att_write on attachments for all to authenticated
  using (can_see_task(task_id)) with check (can_see_task(task_id));

-- ── Routine journalière ──────────────────────────────────────────────
create policy daily_select on daily_tasks for select to authenticated using (true);
create policy daily_write  on daily_tasks for all to authenticated
  using (my_role() in ('chef','rh','dir','dept_head') or employee_name = my_name())
  with check (auth.uid() is not null);
create policy dlog_select on daily_log for select to authenticated using (true);
create policy dlog_write  on daily_log for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);

create policy holidays_select on holidays for select to authenticated using (true);
create policy holidays_write  on holidays for all to authenticated
  using (my_role() in ('chef','rh')) with check (my_role() in ('chef','rh'));

-- ── Salaire : visible RH/DF/GE/PAU + admin ; écriture via app (vérifs métier) ─
create policy salary_select on salary_authorizations for select to authenticated using (
  my_role() = 'chef' or salary_function(
    (select role_raw from personnel where id = auth.uid()), my_role()) is not null
);
create policy salary_write on salary_authorizations for all to authenticated
  using (salary_function((select role_raw from personnel where id = auth.uid()), my_role()) is not null)
  with check (salary_function((select role_raw from personnel where id = auth.uid()), my_role()) is not null);

create policy salext_select on salary_external_beneficiaries for select to authenticated using (
  my_role() = 'chef' or salary_function(
    (select role_raw from personnel where id = auth.uid()), my_role()) is not null
);
create policy salext_write on salary_external_beneficiaries for all to authenticated
  using (salary_function((select role_raw from personnel where id = auth.uid()), my_role()) = 'rh')
  with check (salary_function((select role_raw from personnel where id = auth.uid()), my_role()) = 'rh');
