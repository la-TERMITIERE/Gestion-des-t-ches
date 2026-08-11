-- ✨ v7.2 : SALAIRE — ouverture à tout le personnel + paramétrage des notifications
--
--  1) Chacun peut demander une autorisation de versement POUR LUI-MÊME, et ne voit
--     que SA propre ligne. Jusqu'ici l'onglet était réservé à RH/DF/GE/PAU/Chef et
--     seule la DA-RH pouvait initier.
--
--     ⚠ Point sensible : les montants de salaire ne doivent pas devenir visibles de
--     tous au passage. La restriction est donc posée ICI, dans la RLS — pas dans
--     l'UI. Le JWT vit dans le navigateur : une règle qui n'existerait que dans
--     api.js se contournerait avec le client Supabase et n'importe quel lien
--     d'accès. `person = my_name()` est la seule barrière qui tienne.
--
--  2) Un paramétrage dit QUI est prévenu par e-mail quand une demande est initiée
--     (et, au choix, quand elle est tranchée). La liste se règle depuis l'onglet,
--     sans toucher au code — c'était la demande.
--
--  Rejouable sans risque.

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
