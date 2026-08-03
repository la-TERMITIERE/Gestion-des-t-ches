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
