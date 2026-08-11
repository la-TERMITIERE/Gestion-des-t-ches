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

-- ── 0020 : salaire ouvert à tous + paramétrage des notifications (v7.2) ──
-- Détails et justifications : supabase/migrations/0020_salary_open_and_notify.sql

-- ── 1) Visibilité et écriture des demandes ──────────────────────────
--  Lecture : les acteurs du circuit + le Chef voient tout ; chacun voit sa ligne.
drop policy if exists salary_select on salary_authorizations;
create policy salary_select on salary_authorizations for select to authenticated using (
     my_role() = 'chef'
  or salary_function((select role_raw from personnel where id = auth.uid()), my_role()) is not null
  or person = my_name()
);

--  L'ancienne policy `salary_write` couvrait insert + update + delete d'un bloc,
--  pour les seules fonctions salaire. On la découpe : l'ouverture ne concerne que
--  la CRÉATION, et uniquement pour soi-même.
drop policy if exists salary_write on salary_authorizations;

create policy salary_insert on salary_authorizations for insert to authenticated
  with check (
       salary_function((select role_raw from personnel where id = auth.uid()), my_role()) is not null
    or (
      -- Demande pour soi : le bénéficiaire, le demandeur et l'identité connectée
      -- doivent coïncider, et la demande doit entrer au tout début du circuit.
      -- Sans le contrôle sur `status`, on pourrait s'auto-délivrer un « Autorisé ».
      person = my_name() and requested_by = my_name() and status = 'Demandé'
    )
  );

--  Faire AVANCER une demande reste au circuit (DF → GE → PAU) : un employé ne
--  peut pas modifier la sienne, seulement la créer puis la suivre.
create policy salary_update on salary_authorizations for update to authenticated
  using      (salary_function((select role_raw from personnel where id = auth.uid()), my_role()) is not null)
  with check (salary_function((select role_raw from personnel where id = auth.uid()), my_role()) is not null);

create policy salary_delete on salary_authorizations for delete to authenticated
  using (my_role() = 'chef');

--  Garde-fou d'étape : la RLS autorise la ligne entière, elle ne sait pas dire
--  « ce champ-là, à cette étape-là ». On vérifie donc en trigger que chaque
--  transition est faite par la bonne fonction, au bon moment. api.js applique
--  déjà ces règles, mais côté navigateur elles sont contournables.
create or replace function salary_guard_transition()
returns trigger language plpgsql security definer set search_path = public as $$
declare fn text := salary_function((select role_raw from personnel where id = auth.uid()), my_role());
begin
  -- `is distinct from` et non `<>` : pour quelqu'un sans fonction salaire, fn vaut
  -- NULL, et `NULL <> 'df'` vaut NULL — donc la branche ne se déclencherait pas et
  -- le garde-fou laisserait justement passer celui qu'il doit arrêter.
  if new.status is distinct from old.status then
    if    old.status = 'Demandé'  and new.status = 'Validé'    and fn is distinct from 'df'  then
      raise exception 'Seul le DF peut valider une demande de versement.';
    elsif old.status = 'Validé'   and new.status = 'Approuvé'  and fn is distinct from 'ge'  then
      raise exception 'Seule la GE peut approuver une demande de versement.';
    elsif old.status = 'Approuvé' and new.status = 'Autorisé'  and fn is distinct from 'pau' then
      raise exception 'Seule la PAU peut autoriser un versement.';
    elsif new.status = 'Rejeté' and fn is null then
      raise exception 'Seuls les acteurs du circuit peuvent rejeter une demande.';
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists salary_guard_transition_trg on salary_authorizations;
create trigger salary_guard_transition_trg
  before update on salary_authorizations
  for each row execute function salary_guard_transition();

-- ── 2) Paramétrage : qui est prévenu ────────────────────────────────
--  Une ligne par personne à prévenir. Deux moments distincts, parce qu'ils ne
--  concernent pas le même monde : `on_request` sert à informer largement qu'une
--  demande vient d'être initiée, `on_decision` à ne suivre que les issues.
create table if not exists salary_notify_recipients (
  person_id   uuid primary key references personnel(id) on delete cascade,
  person_name text default '',
  on_request  boolean default true,
  on_decision boolean default false,
  added_by    text default '',
  created_at  timestamptz default now()
);

alter table salary_notify_recipients enable row level security;
grant select, insert, update, delete on salary_notify_recipients to authenticated;

-- Le réglage est une décision d'organisation : Chef et DA-RH le lisent et l'écrivent.
-- L'Edge Function `notify` tourne avec la clé service et n'est donc pas soumise à
-- cette policy — c'est elle qui lira la liste au moment d'envoyer les e-mails.
drop policy if exists salnotify_select on salary_notify_recipients;
create policy salnotify_select on salary_notify_recipients for select to authenticated
  using (my_role() in ('chef', 'rh'));
drop policy if exists salnotify_write on salary_notify_recipients;
create policy salnotify_write on salary_notify_recipients for all to authenticated
  using (my_role() in ('chef', 'rh')) with check (my_role() in ('chef', 'rh'));
