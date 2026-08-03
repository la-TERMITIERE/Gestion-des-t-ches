-- ✨ Parité avec le bundle Apps Script (getAllTasksRaw_) :
--  champs supplémentaires lus par l'UI legacy.
alter table tasks add column if not exists date_assigned    date;
alter table tasks add column if not exists department       text default '';
alter table tasks add column if not exists assigned_by_role text default '';
