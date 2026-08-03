-- ══════════════════════════════════════════════════════════════════
--  LA TERMITIERE — v7.0 : à coller tel quel dans Supabase → SQL Editor → Run.
--
--  Regroupe les migrations 0014 (lecture des liens d'accès par le Chef/DA-RH)
--  et 0015 (rubrique Innovation). Rejouable sans risque : on peut le relancer
--  sans rien casser ni perdre de données.
--
--  Ne touche à aucune donnée existante — ne fait qu'ajouter tables et règles.
-- ══════════════════════════════════════════════════════════════════

-- ✨ v7.0 : la RH / le Chef peuvent RELIRE les liens d'accès existants.
--
--  Contexte : 0007 accordait insert/update/delete sans aucun SELECT, pour que les
--  tokens ne soient jamais lisibles côté navigateur. Effet de bord : la RH ne pouvait
--  plus retrouver le lien d'une personne qui l'a perdu — le seul bouton disponible
--  régénérait le token, ce qui invalidait l'ancien lien encore en circulation.
--
--  Compromis retenu : la lecture est ouverte aux DEUX seuls rôles qui gèrent déjà le
--  personnel (chef, rh) et qui pouvaient de toute façon réécrire ces tokens. Elle
--  reste fermée à tous les autres, y compris à l'Assistante RH — normalize_role() la
--  classe 'emp', elle ne passe donc pas le filtre ci-dessous.
--  Rejouable sans risque : ces migrations s'appliquent par copier-coller dans le
--  SQL Editor (l'historique de migration n'est pas suivi côté Supabase), donc un
--  double passage doit rester inoffensif.
grant select on personnel_auth to authenticated;

drop policy if exists pauth_select on personnel_auth;
create policy pauth_select on personnel_auth for select to authenticated
  using (my_role() in ('chef', 'rh'));


-- ══════════════════════════════════════════════════════════════════

-- ✨ v7.0 : rubrique « Innovation » — la boîte à idées de l'entreprise.
--
--  Choix produit (validé) : contrairement aux Rapports (0013), qui sont confidentiels
--  et adressés à une liste de destinataires, une idée est VISIBLE PAR TOUT LE MONDE —
--  c'est le but : que les idées circulent et se commentent. La RLS est donc simple,
--  et il n'y a ni destinataires ni bucket privé.
--
--  Le statut est le seul point de contrôle : seul le Chef le fait avancer.

create table if not exists innovations (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text default '',
  category    text default '',
  author_id   uuid references personnel(id),
  author_name text default '',
  -- Nouvelle → À l'étude → Retenue | Écartée. Texte (pas enum) par cohérence avec
  -- les autres modules, qui stockent tous leurs statuts en clair.
  status      text default 'Nouvelle',
  chef_note   text default '',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists innovations_author_idx on innovations (author_id);
create index if not exists innovations_created_idx on innovations (created_at desc);

create table if not exists innovation_comments (
  id            uuid primary key default gen_random_uuid(),
  innovation_id uuid references innovations(id) on delete cascade,
  author_id     uuid references personnel(id),
  author_name   text default '',
  text          text not null,
  created_at    timestamptz default now()
);
create index if not exists innovation_comments_inno_idx on innovation_comments (innovation_id, created_at);

alter table innovations         enable row level security;
alter table innovation_comments enable row level security;

grant select, insert, update, delete on innovations, innovation_comments to authenticated;

-- ── Idées ────────────────────────────────────────────────────────────
-- Lecture : tout le personnel connecté.
drop policy if exists innovations_select on innovations;
create policy innovations_select on innovations for select to authenticated
  using (true);
drop policy if exists innovations_insert on innovations;
create policy innovations_insert on innovations for insert to authenticated
  with check (author_id = auth.uid());
-- L'auteur corrige son idée ; le Chef en fait avancer le statut. Le WITH CHECK
-- empêche de changer d'auteur au passage.
drop policy if exists innovations_update on innovations;
create policy innovations_update on innovations for update to authenticated
  using (author_id = auth.uid() or my_role() = 'chef')
  with check (author_id = auth.uid() or my_role() = 'chef');
drop policy if exists innovations_delete on innovations;
create policy innovations_delete on innovations for delete to authenticated
  using (author_id = auth.uid() or my_role() = 'chef');

-- L'arbitrage (statut + avis) est réservé au Chef. La RLS ne sait pas restreindre
-- une COLONNE — innovations_update laisse l'auteur modifier sa ligne, donc aussi son
-- statut. Comme le JWT vit dans le navigateur, une règle qui n'existerait que dans
-- api.js serait contournable : on la pose donc ici, au plus près de la donnée.
create or replace function innovations_guard_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.status is distinct from old.status or new.chef_note is distinct from old.chef_note)
     and my_role() <> 'chef' then
    raise exception 'Seul le Chef peut arbitrer une idée (statut / avis).';
  end if;
  return new;
end; $$;

drop trigger if exists innovations_guard_status_trg on innovations;
create trigger innovations_guard_status_trg
  before update on innovations
  for each row execute function innovations_guard_status();

-- ── Commentaires ─────────────────────────────────────────────────────
drop policy if exists innovation_comments_select on innovation_comments;
create policy innovation_comments_select on innovation_comments for select to authenticated
  using (true);
drop policy if exists innovation_comments_insert on innovation_comments;
create policy innovation_comments_insert on innovation_comments for insert to authenticated
  with check (author_id = auth.uid());
drop policy if exists innovation_comments_delete on innovation_comments;
create policy innovation_comments_delete on innovation_comments for delete to authenticated
  using (author_id = auth.uid() or my_role() = 'chef');
