-- ✨ Onglet « Rapports » : chacun dépose un rapport (tout format de fichier) et choisit
-- explicitement qui peut le voir. Ni public, ni basé sur les rôles — juste la liste de
-- destinataires cochée au dépôt (+ Chef, en supervision).

create table reports (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text default '',
  author_id   uuid references personnel(id),
  author_name text default '',
  file_name   text default '',
  file_path   text default '',   -- chemin dans le bucket Storage "reports"
  mime_type   text default '',
  size        bigint default 0,
  created_at  timestamptz default now()
);
create index reports_author_idx on reports (author_id);

create table report_recipients (
  id        uuid primary key default gen_random_uuid(),
  report_id uuid references reports(id) on delete cascade,
  viewer_id uuid references personnel(id),
  unique (report_id, viewer_id)
);
create index report_recipients_report_idx on report_recipients (report_id);
create index report_recipients_viewer_idx on report_recipients (viewer_id);

alter table reports           enable row level security;
alter table report_recipients enable row level security;

grant select, insert, update, delete on reports, report_recipients to authenticated;

-- SECURITY DEFINER pour éviter toute récursion reports ↔ report_recipients.
create or replace function can_see_report(p_report_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from reports r where r.id = p_report_id and (
         my_role() = 'chef'
      or r.author_id = auth.uid()
      or exists (select 1 from report_recipients rr where rr.report_id = r.id and rr.viewer_id = auth.uid())
    )
  );
$$;

create policy reports_select on reports for select to authenticated
  using (can_see_report(id));
create policy reports_insert on reports for insert to authenticated
  with check (author_id = auth.uid());
-- Nécessaire pour que l'auteur puisse renseigner file_path juste après l'upload Storage.
create policy reports_update on reports for update to authenticated
  using (author_id = auth.uid() or my_role() = 'chef')
  with check (author_id = auth.uid() or my_role() = 'chef');
create policy reports_delete on reports for delete to authenticated
  using (my_role() = 'chef' or author_id = auth.uid());

create policy report_recipients_select on report_recipients for select to authenticated
  using (can_see_report(report_id));
create policy report_recipients_insert on report_recipients for insert to authenticated
  with check (exists (select 1 from reports r where r.id = report_id and r.author_id = auth.uid()));
create policy report_recipients_delete on report_recipients for delete to authenticated
  using (my_role() = 'chef' or exists (select 1 from reports r where r.id = report_id and r.author_id = auth.uid()));

-- ── Storage : bucket PRIVÉ (contrairement à "attachments") — la confidentialité
--   par destinataire n'a de sens que si le fichier n'est pas accessible par simple URL.
insert into storage.buckets (id, name, public)
values ('reports', 'reports', false)
on conflict (id) do nothing;

create or replace function can_see_report_path(p_path text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from reports r where r.file_path = p_path and (
         my_role() = 'chef'
      or r.author_id = auth.uid()
      or exists (select 1 from report_recipients rr where rr.report_id = r.id and rr.viewer_id = auth.uid())
    )
  );
$$;

create policy "reports_storage_read" on storage.objects for select to authenticated
  using (bucket_id = 'reports' and can_see_report_path(name));
create policy "reports_storage_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'reports');
create policy "reports_storage_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'reports' and (my_role() = 'chef' or owner = auth.uid()));
