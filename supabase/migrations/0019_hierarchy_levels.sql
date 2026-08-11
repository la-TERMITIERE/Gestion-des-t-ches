-- ✨ v7.1 : ÉVALUATION PAR NIVEAU HIÉRARCHIQUE + COMPARAISON DE PÉRIODES
--
--  Deux besoins, une migration :
--
--  1) « Onglets par niveaux » — chaque personne appartient à un des 6 niveaux
--     d'attribution (1 PAU · 2 GE · 3 Directeurs · 4 Responsables de pôle ·
--     5 Autres · 6 Stagiaires). Le niveau est DÉDUIT automatiquement du couple
--     (role_raw, position) côté client — mais les intitulés réels sont trop
--     irréguliers pour que la déduction soit toujours juste (« Chef Administrateur »
--     avec la fonction « Stagiaire RH ANPE », « Gérante Exécutive » déclarée
--     Directeur…). D'où cette colonne : un niveau posé à la main par le Chef ou la
--     DA-RH gagne toujours sur la déduction. NULL = « laisse deviner ».
--
--  2) « Courbe d'évolution / innovation / réflexion » par acteur — les tâches
--     sont déjà chargées côté client, mais pas les traces d'activité
--     (commentaires, idées, objectifs, rapports). Or leurs policies RLS sont
--     volontairement étroites : messages_select ne montre que les tâches
--     visibles, reports_select que les rapports adressés. Un compteur « par
--     acteur » ne peut donc PAS se calculer par simple SELECT. La fonction
--     activity_events() ci-dessous est SECURITY DEFINER et ne renvoie que des
--     COMPTEURS agrégés (jamais un contenu) : on mesure le volume d'activité
--     sans ouvrir la lecture des textes eux-mêmes.
--
--  Rejouable sans risque (cf. convention APPLY_*.sql : copier-coller dans le
--  SQL Editor, l'historique de migration n'étant pas suivi côté Supabase).

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
