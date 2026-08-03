-- ✨ Renomme la désignation « Responsable RH » en « DA-RH » (même rôle normalisé 'rh',
--  mêmes droits — c'est juste le libellé affiché/stocké qui change).

create or replace function normalize_role(role_str text)
returns text language plpgsql immutable as $$
declare s text := lower(trim(coalesce(role_str, '')));
begin
  if position('assistant' in s) > 0
     and (position('rh' in s) > 0 or position('ressources humaines' in s) > 0)
     then return 'emp'; end if;
  if s = 'pau' or s = 'ge' then return 'chef'; end if;
  if s = 'df' then return 'dir'; end if;
  if position('da-rh' in s) > 0 or position('responsable rh' in s) > 0
     or position('ressources humaines' in s) > 0
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

-- Corrige les fiches existantes : le libellé stocké suit le nouveau nom.
update personnel set role_raw = 'DA-RH' where lower(trim(role_raw)) = 'responsable rh';
