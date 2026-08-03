-- ✨ Pièces jointes : bucket Storage public (équivalent du dossier Drive partagé).
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', true)
on conflict (id) do nothing;

-- Lecture publique via URL (comme « lecture par lien » de Drive) ;
-- dépôt / suppression réservés aux utilisateurs authentifiés.
create policy "attach_read"   on storage.objects for select using (bucket_id = 'attachments');
create policy "attach_insert" on storage.objects for insert to authenticated with check (bucket_id = 'attachments');
create policy "attach_delete" on storage.objects for delete to authenticated using (bucket_id = 'attachments');
