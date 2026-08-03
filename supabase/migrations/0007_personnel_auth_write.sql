-- ✨ Permet à la RH / au Chef de CRÉER ou RÉGÉNÉRER les liens d'accès (tokens).
--  Aucune policy SELECT → les tokens restent illisibles côté navigateur.
grant insert, update, delete on personnel_auth to authenticated;

create policy pauth_insert on personnel_auth for insert to authenticated
  with check (my_role() in ('chef','rh'));
create policy pauth_update on personnel_auth for update to authenticated
  using (my_role() in ('chef','rh')) with check (my_role() in ('chef','rh'));
create policy pauth_delete on personnel_auth for delete to authenticated
  using (my_role() in ('chef','rh'));
