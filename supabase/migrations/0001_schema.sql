-- ════════════════════════════════════════════════════════════════════
--  LA TERMITIERE — Schéma Postgres (Supabase)
--  Réplique du modèle Google Sheets, indexé et typé.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ── Normalisation des rôles (réplique de normalizeRole() en JS) ──────
create or replace function normalize_role(role_str text)
returns text language plpgsql immutable as $$
declare s text := lower(trim(coalesce(role_str, '')));
begin
  -- Assistante RH = droits d'un employé (visibilité globale gérée à part)
  if position('assistant' in s) > 0
     and (position('rh' in s) > 0 or position('ressources humaines' in s) > 0)
     then return 'emp'; end if;
  -- Dénominations du circuit salaire : PAU/GE = admin, DF = directeur
  if s = 'pau' or s = 'ge' then return 'chef'; end if;
  if s = 'df' then return 'dir'; end if;
  if position('responsable rh' in s) > 0 or position('ressources humaines' in s) > 0
     then return 'rh'; end if;
  if (position('chef' in s) > 0 and position('directeur' in s) > 0)
     or position('directeur général' in s) > 0 or s = 'dg' or position('pdg' in s) > 0
     or position('chef administrateur' in s) > 0 or position('administrateur' in s) > 0
     then return 'chef'; end if;
  if position('chef de département' in s) > 0 or position('chef de departement' in s) > 0
     or position('chef de division' in s) > 0 then return 'dept_head'; end if;
  if position('directeur' in s) > 0 then return 'dir'; end if;
  if s = 'rh' then return 'rh'; end if;
  return 'emp';
end; $$;

-- Fonction « salaire » dans le workflow d'autorisation (rh/df/ge/pau)
create or replace function salary_function(role_raw text, role_norm text)
returns text language sql immutable as $$
  select case
    when lower(trim(coalesce(role_raw, ''))) = 'pau' then 'pau'
    when lower(trim(coalesce(role_raw, ''))) = 'ge'  then 'ge'
    when lower(trim(coalesce(role_raw, ''))) = 'df'  then 'df'
    when role_norm = 'rh' and position('assistant' in lower(coalesce(role_raw, ''))) = 0 then 'rh'
    else null
  end;
$$;

create or replace function is_assistant_rh(role_raw text)
returns boolean language sql immutable as $$
  select position('assistant' in lower(coalesce(role_raw, ''))) > 0
     and (position('rh' in lower(coalesce(role_raw, ''))) > 0
          or position('ressources humaines' in lower(coalesce(role_raw, ''))) > 0);
$$;

-- ── Personnel ────────────────────────────────────────────────────────
create table personnel (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text unique not null,
  dept       text default '',
  position   text default '',
  role_raw   text default '',
  role_norm  text generated always as (normalize_role(role_raw)) stored,
  status     text default 'Actif',
  start_date date,
  created_at timestamptz default now()
);
create index personnel_name_idx on personnel (lower(name));
create index personnel_role_idx on personnel (role_norm);

-- Secrets d'accès séparés (jamais exposés au navigateur ; lus par l'Edge Function)
create table personnel_auth (
  person_id uuid primary key references personnel(id) on delete cascade,
  token     text unique not null
);

-- ── Tâches ───────────────────────────────────────────────────────────
create table tasks (
  id               text primary key,             -- conserve les ID actuels
  description      text default '',
  category         text default '',
  recipient_id     uuid references personnel(id),
  recipient_name   text default '',
  assigned_by_id   uuid references personnel(id),
  assigned_by_name text default '',
  priority         text default 'Moyenne',
  status           text default 'À faire',
  progress         int  default 0,
  date_start       date,
  date_limit       date,
  close_date       date,
  comment          text default '',
  chef_note        text default '',
  chef_comment     text default '',
  group_id         text default '',
  report_required  boolean default false,
  report_link      text default '',
  expected_result  text default '',
  archived         boolean default false,
  archived_at      timestamptz,
  created_at       timestamptz default now()
);
create index tasks_recipient_idx on tasks (recipient_id);
create index tasks_assigner_idx  on tasks (assigned_by_id);
create index tasks_status_idx    on tasks (status);
create index tasks_limit_idx     on tasks (date_limit);
create index tasks_group_idx     on tasks (group_id);
create index tasks_archived_idx  on tasks (archived);

-- ── Membres d'équipe ─────────────────────────────────────────────────
create table team_members (
  id           uuid primary key default gen_random_uuid(),
  group_id     text,
  task_id      text references tasks(id) on delete cascade,
  member_id    uuid references personnel(id),
  member_name  text default '',
  member_email text default '',
  is_leader    boolean default false,
  sub_status   text default 'À faire',
  report_link  text default '',
  updated_at   timestamptz default now()
);
create index team_task_idx   on team_members (task_id);
create index team_group_idx  on team_members (group_id);
create index team_member_idx on team_members (member_id);

-- ── Messages (chat de tâche) ─────────────────────────────────────────
create table messages (
  id          uuid primary key default gen_random_uuid(),
  task_id     text references tasks(id) on delete cascade,
  author_name text default '',
  body        text default '',
  created_at  timestamptz default now()
);
create index messages_task_idx on messages (task_id);

-- ── Objectifs ────────────────────────────────────────────────────────
create table objectives (
  id          bigint generated always as identity primary key,
  type        text default 'perso',   -- perso | dept
  target      text default '',
  title       text default '',
  description text default '',
  date_start  date,
  date_end    date,
  progress    int  default 0,
  status      text default 'En cours',
  author_name text default '',
  comment     text default '',
  created_at  timestamptz default now()
);

create table objective_comments (
  id           uuid primary key default gen_random_uuid(),
  objective_id bigint references objectives(id) on delete cascade,
  author_name  text default '',
  body         text default '',
  created_at   timestamptz default now()
);

-- ── Pièces jointes (fichiers dans Supabase Storage) ──────────────────
create table attachments (
  id           uuid primary key default gen_random_uuid(),
  task_id      text references tasks(id) on delete cascade,
  name         text default '',
  storage_path text default '',
  url          text default '',
  mime_type    text default '',
  size         bigint default 0,
  uploaded_by  text default '',
  created_at   timestamptz default now()
);
create index attachments_task_idx on attachments (task_id);

-- ── Routine journalière ──────────────────────────────────────────────
create table daily_tasks (
  id            uuid primary key default gen_random_uuid(),
  label         text default '',
  employee_id   uuid references personnel(id),
  employee_name text default '',
  active        boolean default true,
  created_at    timestamptz default now()
);
create index daily_emp_idx on daily_tasks (employee_id);

create table daily_log (
  id            uuid primary key default gen_random_uuid(),
  daily_task_id uuid references daily_tasks(id) on delete cascade,
  employee_name text default '',
  log_date      date not null,
  done          boolean default false,
  checked_at    timestamptz default now(),
  unique (daily_task_id, log_date)
);
create index daily_log_date_idx on daily_log (log_date);

-- ── Jours fériés ─────────────────────────────────────────────────────
create table holidays (
  holiday_date date primary key,
  label        text default ''
);

-- ── Autorisation de versement de salaire ─────────────────────────────
create table salary_authorizations (
  id            text primary key,
  person        text not null,
  periode       text default '',
  montant       text default '',
  status        text default 'Demandé',   -- Demandé/Validé/Approuvé/Autorisé/Rejeté
  requested_by  text, requested_at  timestamptz,
  validated_by  text, validated_at  timestamptz,
  approved_by   text, approved_at   timestamptz,
  authorized_by text, authorized_at timestamptz,
  rejected_by   text, rejected_at   timestamptz,
  reject_reason text default '',
  note          text default '',
  created_at    timestamptz default now()
);
create index salary_person_idx on salary_authorizations (person);

create table salary_external_beneficiaries (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  structure  text default '',
  email      text default '',
  note       text default '',
  added_by   text default '',
  active     boolean default true,
  created_at timestamptz default now()
);
