-- ✨ Objectifs : passage en ID texte (O001, OC0001…) pour coller à l'app d'origine.
--  Les tables étaient vides → on les recrée proprement (avec RLS).

drop table if exists objective_comments cascade;
drop table if exists objectives cascade;

create table objectives (
  id          text primary key,
  type        text default 'perso',     -- perso | dept
  target      text default '',
  author_name text default '',
  title       text default '',
  description text default '',
  date_start  date,
  date_end    date,
  progress    int  default 0,
  status      text default 'En cours',
  comment     text default '',
  created_at  timestamptz default now()
);

create table objective_comments (
  id           text primary key,
  objective_id text references objectives(id) on delete cascade,
  author_name  text default '',
  author_email text default '',
  body         text default '',
  created_at   timestamptz default now()
);
create index objc_obj_idx on objective_comments (objective_id);

-- Département de l'utilisateur courant
create or replace function my_dept() returns text language sql stable as $$
  select dept from personnel where id = auth.uid();
$$;

-- Peut-on voir cet objectif ? (définer → évite la récursion de policy)
create or replace function can_see_objective(p_obj_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from objectives o where o.id = p_obj_id and (
        my_role() in ('chef','rh')
     or (o.type = 'perso' and o.target = my_name())
     or (my_role() in ('dir','dept_head') and (
            (o.type = 'dept'  and lower(o.target) = lower(my_dept()))
         or (o.type = 'perso' and exists(select 1 from personnel p
               where p.name = o.target and lower(p.dept) = lower(my_dept())))
        ))
    ));
$$;

alter table objectives          enable row level security;
alter table objective_comments  enable row level security;
grant select, insert, update, delete on objectives, objective_comments to authenticated;

create policy obj_select on objectives for select to authenticated
  using (can_see_objective(id));
create policy obj_update on objectives for update to authenticated using (
  my_role() = 'chef' or author_name = my_name()
  or (type = 'perso' and target = my_name())
  or (my_role() in ('dir','dept_head') and type = 'dept' and lower(target) = lower(my_dept()))
) with check (true);
create policy obj_insert on objectives for insert to authenticated
  with check (target = my_name() or my_role() in ('chef','rh','dir','dept_head'));
create policy obj_delete on objectives for delete to authenticated using (
  my_role() = 'chef' or author_name = my_name() or (type = 'perso' and target = my_name())
);

create policy objc_select on objective_comments for select to authenticated
  using (can_see_objective(objective_id));
create policy objc_insert on objective_comments for insert to authenticated
  with check (can_see_objective(objective_id));
create policy objc_delete on objective_comments for delete to authenticated
  using (my_role() = 'chef' or author_name = my_name());
