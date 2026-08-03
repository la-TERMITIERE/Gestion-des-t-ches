-- ✨ v7.0.2 : l'archivage automatique passe de 3 mois à 1 mois.
--  Les tâches « Terminé » clôturées il y a PLUS d'un mois passent en archived = true.
--  Rejouable : create or replace ne fait que redéfinir la fonction ; le job pg_cron
--  existant appelle archive_old_tasks(), il prend donc le nouveau seuil sans retouche.

create or replace function archive_old_tasks() returns void
language sql security definer set search_path = public as $$
  update tasks
     set archived = true, archived_at = now()
   where status = 'Terminé'
     and archived = false
     and close_date is not null
     and close_date < (current_date - interval '1 month');
$$;

-- Passe TOUT DE SUITE les tâches déjà clôturées depuis plus d'un mois en archives,
-- sans attendre le prochain dimanche (le job tourne « 0 3 * * 0 »).
select archive_old_tasks();
