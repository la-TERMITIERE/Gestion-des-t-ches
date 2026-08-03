-- ✨ Routine journalière : ID texte (D001…) + champs description/ordre/note,
--  pour coller au modèle Apps Script. Tables vides → recréées avec RLS.

drop table if exists daily_log cascade;
drop table if exists daily_tasks cascade;

create table daily_tasks (
  id            text primary key,        -- D001, D002…
  employee_name text default '',
  employee_id   uuid references personnel(id),
  label         text default '',
  description   text default '',
  sort_order    int  default 0,
  active        boolean default true,
  author_name   text default '',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index daily_emp_idx on daily_tasks (employee_name);

create table daily_log (
  id            text primary key,        -- "D001@2026-06-29"
  daily_task_id text references daily_tasks(id) on delete cascade,
  employee_name text default '',
  log_date      date not null,
  done          boolean default false,
  note          text default '',
  checked_at    timestamptz default now(),
  unique (daily_task_id, log_date)
);
create index daily_log_date_idx on daily_log (log_date);
create index daily_log_emp_idx  on daily_log (employee_name);

-- Périmètre de gestion d'une routine (self / chef-rh / dir-dept_head même dépt)
create or replace function can_manage_daily(p_employee text)
returns boolean language sql stable security definer set search_path = public as $$
  select
       p_employee = my_name()
    or my_role() in ('chef','rh')
    or (my_role() in ('dir','dept_head')
        and exists(select 1 from personnel p
                   where p.name = p_employee and lower(p.dept) = lower(my_dept())));
$$;

alter table daily_tasks enable row level security;
alter table daily_log   enable row level security;
grant select, insert, update, delete on daily_tasks, daily_log to authenticated;

create policy daily_select on daily_tasks for select to authenticated
  using (can_manage_daily(employee_name));
create policy daily_write on daily_tasks for all to authenticated
  using (can_manage_daily(employee_name)) with check (can_manage_daily(employee_name));

create policy dlog_select on daily_log for select to authenticated
  using (can_manage_daily(employee_name));
create policy dlog_write on daily_log for all to authenticated
  using (can_manage_daily(employee_name)) with check (can_manage_daily(employee_name));
