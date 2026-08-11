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


-- ── 0019 : niveaux hiérarchiques + compteurs d'activité (v7.1) ────
-- Ajoute personnel.hierarchy_level (correction manuelle du niveau, NULL = déduit)
-- et la RPC activity_events() qui alimente les indices Innovation / Réflexion.
-- Détails et justifications : supabase/migrations/0019_hierarchy_levels.sql
-- ── 1) Niveau hiérarchique : surcharge manuelle ──────────────────────
alter table personnel add column if not exists hierarchy_level smallint;

do $$ begin
  alter table personnel add constraint personnel_hierarchy_level_chk
    check (hierarchy_level is null or hierarchy_level between 1 and 6);
exception when duplicate_object then null;
end $$;

comment on column personnel.hierarchy_level is
  'Niveau d''attribution posé à la main (1..6). NULL = déduit de role_raw/position.';

-- Écriture : la policy personnel_update (0002) réserve déjà toute mise à jour de
-- `personnel` au Chef et à la DA-RH — rien à ajouter. Lecture : personnel_select
-- est ouvert à tout compte connecté, la colonne suit.

-- ── 2) Traces d'activité agrégées (innovation / réflexion) ───────────
--  Renvoie UNIQUEMENT (auteur, type d'événement, jour, nombre). Aucun contenu.
--  Portée : le Chef, les Directeurs et la DA-RH voient tout le monde — ce sont
--  les rôles qui disposent déjà des vues de pilotage. Toute autre personne ne
--  voit que sa propre activité, pour suivre sa courbe sans lire celle des autres.
create or replace function activity_events(p_from date, p_to date)
returns table (author_name text, kind text, event_date date, n integer)
language sql stable security definer set search_path = public as $$
  with scope as (
    select my_role() in ('chef', 'dir', 'rh') as all_people, my_name() as me
  )
  -- Réflexion : échanges écrits sur les tâches
  select m.author_name, 'message'::text, m.created_at::date, count(*)::int
    from messages m cross join scope s
   where m.created_at::date between p_from and p_to
     and (s.all_people or m.author_name = s.me)
   group by 1, 2, 3

  union all
  -- Innovation : idées déposées, pondérées ensuite par leur arbitrage
  select i.author_name,
         case i.status
           when 'Retenue'   then 'idea_kept'
           when 'À l''étude' then 'idea_study'
           when 'Écartée'   then 'idea_dropped'
           else 'idea_new'
         end,
         i.created_at::date, count(*)::int
    from innovations i cross join scope s
   where i.created_at::date between p_from and p_to
     and (s.all_people or i.author_name = s.me)
   group by 1, 2, 3

  union all
  -- Réflexion : commentaires sur les idées des autres
  select c.author_name, 'idea_comment'::text, c.created_at::date, count(*)::int
    from innovation_comments c cross join scope s
   where c.created_at::date between p_from and p_to
     and (s.all_people or c.author_name = s.me)
   group by 1, 2, 3

  union all
  -- Réflexion : objectifs posés
  select o.author_name, 'objective'::text, o.created_at::date, count(*)::int
    from objectives o cross join scope s
   where o.created_at::date between p_from and p_to
     and (s.all_people or o.author_name = s.me)
   group by 1, 2, 3

  union all
  -- Réflexion : commentaires sur les objectifs
  select oc.author_name, 'objective_comment'::text, oc.created_at::date, count(*)::int
    from objective_comments oc cross join scope s
   where oc.created_at::date between p_from and p_to
     and (s.all_people or oc.author_name = s.me)
   group by 1, 2, 3

  union all
  -- Réflexion : rapports produits (le livrable écrit le plus lourd → poids fort)
  select r.author_name, 'report'::text, r.created_at::date, count(*)::int
    from reports r cross join scope s
   where r.created_at::date between p_from and p_to
     and (s.all_people or r.author_name = s.me)
   group by 1, 2, 3;
$$;

revoke all on function activity_events(date, date) from public;
grant execute on function activity_events(date, date) to authenticated;
