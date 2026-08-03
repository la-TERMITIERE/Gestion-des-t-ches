# LA TERMITIERE — Migration vers Supabase + React/Vite

Réplique **1:1** de l'application Google Apps Script existante, avec un backend rapide
(Supabase / Postgres) et un frontend moderne (React + Vite).

## Décisions verrouillées

| Sujet | Choix | Raison |
|---|---|---|
| Frontend | **React + Vite** (SPA) | App à token, pas de SSR/SEO → simplicité + rapidité max |
| Style | **CSS existant réutilisé tel quel** | Garantie pixel-perfect. **Pas** de réécriture Tailwind |
| Base de données | **Supabase Postgres + RLS** | Indexé, rapide, sécurité par politiques |
| Authentification | **Lien à token conservé** (`?token=…`) | Migration transparente, aucune nouvelle UX de login |
| Fichiers | **Supabase Storage** | Remplace Google Drive |
| E-mails | **Edge Function + Resend** | Remplace `MailApp`, templates HTML réutilisés |
| Tâches planifiées | **pg_cron + Edge Functions** | Remplace les triggers (archivage, rappels) |
| Hébergement | **Vercel / Netlify / Cloudflare Pages** | Statique, gratuit |

## Principe directeur du pixel-perfect : le « seam » `call()`

Le frontend actuel passe **tous** ses appels serveur par une seule fonction :

```js
function call(fnName) { /* google.script.run[fnName](...) */ }
```

On **réutilise l'UI existante quasi verbatim** et on remplace uniquement le corps de
`call()` pour qu'il tape Supabase au lieu de `google.script.run`. Chaque fonction
serveur de `code.gs.js` (`getTasks`, `updateTask`, `getSalaryAuthorizations`, …) a un
équivalent dans `src/lib/api.js` qui renvoie **exactement la même forme d'objet**.
→ Le rendu HTML/CSS ne change pas, donc l'UI reste identique au pixel près.

Refactorisation en composants React idiomatiques = **plus tard**, de façon incrémentale,
sans bloquer la mise en production.

## Authentification (token → JWT → RLS)

1. L'utilisateur ouvre `https://app…/?token=XXXX`.
2. Le front appelle l'Edge Function **`auth-token`** avec ce token.
3. `auth-token` retrouve la personne (table `personnel`, `status != inactif`) et **signe
   un JWT** (HS256, secret JWT du projet) avec `sub = personnel.id`, `role='authenticated'`.
4. Le client Supabase est créé avec ce JWT (`accessToken`) → toutes les requêtes
   portent l'identité, et **RLS** applique la visibilité/les droits côté base.

Le token reste l'unique secret partagé (comme aujourd'hui) ; le JWT est juste sa
traduction courte-durée pour Postgres. `auth.uid()` = `personnel.id`.

## Modèle de données (Sheets → Postgres)

| Feuille | Table | Points clés |
|---|---|---|
| 👥 Personnel | `personnel` | `email` unique, `role_raw`, `role_norm` (colonne générée via `normalize_role`), `token` unique, `status` |
| 📋 Tâches | `tasks` | FK `recipient_id`, `assigned_by_id` ; `report_required`, `report_link`, `expected_result`, `group_id` ; index statut/échéance/dest. ; `archived bool` |
| 👥 Membres Équipes | `team_members` | FK `task_id`, `group_id`, `member_id` ; `is_leader`, `sub_status`, `report_link` |
| 💬 Messages | `messages` | FK `task_id` ; Realtime |
| 🎯 Objectifs | `objectives` | `type` (perso/dept), `target`, dates, `progress`, `author` |
| 💭 Commentaires Objectifs | `objective_comments` | FK `objective_id` |
| 📎 Pièces jointes | `attachments` | FK `task_id` ; fichier dans Storage (`bucket attachments`) |
| 🔁 Tâches journalières | `daily_tasks` | `label`, `employee_id`, `active` |
| ✅ Suivi journalier | `daily_log` | upsert (`daily_task_id`, `log_date`) ; index `log_date` |
| 📅 Jours fériés | `holidays` | `holiday_date` PK |
| 💰 Autorisations Salaire | `salary_authorizations` | workflow Demandé→Validé→Approuvé→Autorisé/Rejeté |
| 💰 Bénéficiaires externes | `salary_external_beneficiaries` | `active` |
| 🗄️ Archives | **flag `archived`** | Plus de tables d'archive séparées |

### Rôles
`normalize_role(role_raw)` reproduit la logique JS : `chef`, `dir`, `dept_head`, `rh`,
`emp` + dénominations **PAU/GE→chef**, **DF→dir**, **Assistante RH→emp** (avec
`sees_all_tasks`). La fonction « salaire » (rh/df/ge/pau) est dérivée de `role_raw`.

## Correspondance des fonctionnalités

| Apps Script | Cible Supabase |
|---|---|
| `google.script.run` | requêtes `supabase-js` + RPC Postgres (via `src/lib/api.js`) |
| `shouldShowTaskTo` / `canUserEditTask` | **policies RLS** sur `tasks` |
| `MailApp.sendEmail` | Edge Function `send-email` (Resend) appelée après mutation |
| Triggers (archivage, rappels) | `pg_cron` → Edge Functions planifiées |
| Drive (pièces jointes) | Supabase Storage |
| Couche cache maison | **inutile** (Postgres indexé) |
| Chat des tâches | Supabase Realtime |

## Plan de migration

- **Phase 0** — Provisionner Supabase, appliquer le schéma + RLS, déployer `auth-token`.
- **Phase 1 (tranche verticale, EN COURS)** — Scaffold Vite, auth token→JWT, onglet
  **Tâches** de bout en bout en réutilisant l'UI existante.
- **Phase 2** — Porter chaque fonction de `code.gs.js` dans `api.js` (parité des champs),
  domaine par domaine (personnel, objectifs, journalières, salaire, archives).
- **Phase 3** — E-mails (Resend), Storage (pièces jointes), cron (archivage/rappels).
- **Phase 4** — Import des données depuis Sheets, run en parallèle, recette 1:1, bascule.

## Mise en route (résumé — voir README.md)

1. Créer un projet sur supabase.com, récupérer URL + clé anon + JWT secret.
2. Appliquer `supabase/migrations/*.sql`.
3. Déployer les Edge Functions `auth-token` et `send-email`.
4. `cp .env.example .env` et renseigner les clés.
5. `npm install && npm run dev`.
6. Importer les données existantes (`scripts/`).
