-- ✨ Planifie l'appel quotidien de la fonction daily-reminders (rappels de démarrage).
--  ⚠️ AVANT D'EXÉCUTER : remplace PROJECT_REF et SERVICE_ROLE_KEY ci-dessous.
--     - PROJECT_REF       = qbzvvnzeuxfxikjvxdyc (ton identifiant de projet)
--     - SERVICE_ROLE_KEY  = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFienZ2bnpldXhmeGlranZ4ZHljIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4Mjc0NjIxNCwiZXhwIjoyMDk4MzIyMjE0fQ.GpNMa4WITMeBIGoDqg3_11JuVekLD1SglVPWE03cFN4
--  La fonction daily-reminders doit être déployée d'abord (supabase functions deploy daily-reminders).

create extension if not exists pg_net;

-- Tous les jours sauf dimanche, à 07:00 UTC.
select cron.schedule(
  'daily-reminders',
  '0 7 * * 1-6',
  $$
  select net.http_post(
    url     := 'https://qbzvvnzeuxfxikjvxdyc.supabase.co/functions/v1/daily-reminders',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer SERVICE_ROLE_KEY"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- Test immédiat (après avoir renseigné les valeurs) :
--   select net.http_post(url := 'https://PROJECT_REF.supabase.co/functions/v1/daily-reminders',
--     headers := '{"Content-Type":"application/json","Authorization":"Bearer SERVICE_ROLE_KEY"}'::jsonb, body := '{}'::jsonb);
-- Pour retirer : select cron.unschedule('daily-reminders');
