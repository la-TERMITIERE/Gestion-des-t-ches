-- ✨ Archivage automatique (équivalent du trigger Apps Script « runArchiveOldTasks »).
--  Les tâches Terminé clôturées il y a plus de 3 mois passent en archived = true.
--  Pur SQL + pg_cron : aucun secret, s'exécute tout seul.

create extension if not exists pg_cron;

create or replace function archive_old_tasks() returns void
language sql security definer set search_path = public as $$
  update tasks
     set archived = true, archived_at = now()
   where status = 'Terminé'
     and archived = false
     and close_date is not null
     and close_date < (current_date - interval '3 months');
$$;

-- Tous les dimanches à 03:00 (heure du serveur Supabase, UTC).
select cron.schedule('archive-old-tasks', '0 3 * * 0', $$ select archive_old_tasks(); $$);

-- Pour exécuter manuellement une fois : select archive_old_tasks();
-- Pour voir les jobs : select * from cron.job;  -- pour supprimer : select cron.unschedule('archive-old-tasks');
