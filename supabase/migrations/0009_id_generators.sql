-- ✨ Génération d'ID côté base (SECURITY DEFINER → voit TOUTES les lignes, RLS
--  contournée) : élimine les collisions « duplicate key » quand l'utilisateur ne
--  voit qu'un sous-ensemble des lignes (RLS) ou en cas de concurrence.

-- ID « <prefix>### » libre pour une table à colonne id texte (tasks, objectives, daily_tasks…)
create or replace function next_id(p_table text, p_prefix text, p_pad int)
returns text language plpgsql security definer set search_path = public as $$
declare mx int; n int; cand text; ex boolean;
begin
  execute format('select coalesce(max((substring(id from %L))::int), 0) from %I', '(\d+)', p_table) into mx;
  n := mx + 1;
  loop
    cand := p_prefix || lpad(n::text, p_pad, '0');
    execute format('select exists(select 1 from %I where id = $1)', p_table) into ex using cand;
    exit when not ex;
    n := n + 1;
  end loop;
  return cand;
end; $$;

-- ID de groupe « G### » libre (cherche dans tasks ET team_members)
create or replace function next_group_id()
returns text language plpgsql security definer set search_path = public as $$
declare mx int; n int; cand text;
begin
  select coalesce(max((substring(coalesce(group_id,'') from '(\d+)'))::int), 0) into mx
    from (select group_id from tasks union all select group_id from team_members) s;
  n := mx + 1;
  loop
    cand := 'G' || lpad(n::text, 3, '0');
    exit when not exists(select 1 from tasks where group_id = cand)
          and not exists(select 1 from team_members where group_id = cand);
    n := n + 1;
  end loop;
  return cand;
end; $$;

grant execute on function next_id(text, text, int) to authenticated;
grant execute on function next_group_id() to authenticated;
