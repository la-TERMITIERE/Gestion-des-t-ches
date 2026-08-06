-- ✨ Correctif — « new row violates row-level security policy for table "tasks" »
--    au retour / transfert d'une tâche par son DESTINATAIRE.
--
-- ════════════════════════════════════════════════════════════════════
-- Cause réelle (vérifiée sur PostgreSQL 15)
-- ════════════════════════════════════════════════════════════════════
-- Lors d'un UPDATE, PostgreSQL applique la policy **SELECT** comme contrôle
-- (WITH CHECK) sur la NOUVELLE ligne : une ligne qu'on ne pourrait plus voir
-- ne peut pas être écrite. Or `returnTask` réassigne la tâche à un tiers :
-- le destinataire qui la retourne n'est alors plus ni destinataire ni assigneur,
-- donc la nouvelle ligne échappe à `tasks_select` → l'UPDATE est refusé.
-- (Toucher au WITH CHECK de `tasks_update` n'y change rien : c'est `tasks_select`
--  qui bloque. `changeTaskRecipient` fonctionne car l'assigneur, lui, reste
--  `assigned_by_id` et garde donc la ligne visible.)
--
-- ════════════════════════════════════════════════════════════════════
-- Correctif : une RPC SECURITY DEFINER (même motif que next_id / archive_old_tasks)
-- ════════════════════════════════════════════════════════════════════
-- La fonction s'exécute avec les droits du propriétaire (contourne la RLS) APRÈS
-- avoir fait sa propre vérification d'autorisation. Les policies restent strictes.

-- 1) On restaure la policy d'origine (au cas où un correctif « with check (true) »
--    aurait été appliqué en prod : on revient à l'état sûr de 0002).
drop policy if exists tasks_update on tasks;
create policy tasks_update on tasks for update to authenticated
  using      (my_role() = 'chef' or assigned_by_id = auth.uid() or recipient_id = auth.uid())
  with check (my_role() = 'chef' or assigned_by_id = auth.uid() or recipient_id = auth.uid());

-- 2) La RPC de retour/transfert.
create or replace function return_task(
    p_task_id            text,
    p_new_recipient_id   uuid,
    p_new_recipient_name text,
    p_new_department     text,
    p_note               text)
returns text                       -- renvoie le nom de l'ancien destinataire
language plpgsql security definer set search_path = public as $fn$
declare
  prev_name text;
  cur_rid   uuid;
  cur_stat  text;
begin
  select recipient_id, recipient_name, status
    into cur_rid, prev_name, cur_stat
    from tasks where id = p_task_id;
  if not found then
    raise exception 'Tâche introuvable.';
  end if;
  -- autorisation : destinataire actuel ou Chef Admin (réplique de returnTask)
  if not (my_role() = 'chef' or cur_rid = auth.uid()) then
    raise exception 'Seul le destinataire actuel ou le Chef Admin peut retourner cette tâche.';
  end if;
  if cur_stat = 'Terminé' then
    raise exception 'Impossible de retourner une tâche terminée.';
  end if;

  update tasks set
      recipient_id   = p_new_recipient_id,
      recipient_name = p_new_recipient_name,
      department     = coalesce(p_new_department, ''),
      status         = 'À faire',
      progress       = 0,
      close_date     = null,
      comment        = '',
      chef_comment   = p_note
    where id = p_task_id;

  return prev_name;
end
$fn$;

grant execute on function return_task(text, uuid, text, text, text) to authenticated;
