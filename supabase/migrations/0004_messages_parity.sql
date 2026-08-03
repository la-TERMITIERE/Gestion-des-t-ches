-- ✨ Parité chat : un message appartient à une tâche ET (pour les tâches d'équipe)
--  à un groupe → visible par toute l'équipe. + email de l'auteur (affiché).
alter table messages add column if not exists group_id     text default '';
alter table messages add column if not exists author_email text default '';
create index if not exists messages_group_idx on messages (group_id);
