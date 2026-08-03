# LA TERMITIERE — Web (React + Vite + Supabase)

Réplique **pixel-perfect** de l'application Apps Script, sur un backend rapide (Supabase).
Voir [ARCHITECTURE.md](./ARCHITECTURE.md) pour les choix techniques.

> **Phase actuelle : tranche verticale.** L'UI legacy est portée telle quelle (CSS/JS
> identiques) ; seule la couche données change. Domaines déjà branchés sur Supabase :
> **bootstrap, Tâches, Personnel, mise à jour de tâche**. Les autres (objectifs,
> journalières, messages, pièces jointes, salaire, emails) sont à porter en Phase 2
> (un handler à la fois dans `src/lib/api.js`).

## Mise en route

### 1. Projet Supabase
1. Créez un projet sur https://supabase.com.
2. **SQL Editor** → exécutez dans l'ordre :
   - `supabase/migrations/0001_schema.sql`
   - `supabase/migrations/0002_auth_rls.sql`
3. **Settings → API** : notez `Project URL`, `anon key`, et le **JWT Secret**.

### 2. Edge Functions
Avec la CLI Supabase (`npm i -g supabase` puis `supabase login` et `supabase link`) :
```bash
supabase functions deploy auth-token
supabase functions deploy notify
supabase functions deploy daily-reminders
supabase secrets set APP_JWT_SECRET="<JWT Secret du projet>"
supabase secrets set BREVO_API_KEY="xkeysib-..."
supabase secrets set EMAIL_FROM="LA TERMITIERE <ton-email-verifie@gmail.com>"
supabase secrets set APP_URL="https://ton-app.netlify.app"
# (e-mails : voir EMAILS.md — vérifier l'adresse expéditrice chez Brevo)
```

### 3. Frontend
```bash
cd termitiere-web
cp .env.example .env        # renseigner VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```
Ouvrez `http://localhost:5173/?token=LE_TOKEN_D_UNE_PERSONNE`.

> `npm run port` régénère `index.html` depuis `../index.html` (à relancer si vous
> modifiez encore l'app Apps Script source).

### 4. Importer les données existantes
Voir [scripts/IMPORT.md](./scripts/IMPORT.md) (export Sheets → CSV → tables Postgres,
puis génération des tokens dans `personnel_auth`).

## Comment fonctionne le « seam »
L'UI appelle `call('getTasks', token)` ; le pont `src/legacy-bridge.js` redirige vers
`src/lib/api.js` qui interroge Supabase et **renvoie exactement la même forme d'objet**
que l'ancienne fonction Apps Script. Résultat : aucun changement visuel.

## Porter une fonction (Phase 2)
1. Repérer la fonction dans `../code.gs.js` (ex. `getObjectifs`).
2. Ajouter un handler du même nom dans `src/lib/api.js`, renvoyant la même structure.
3. La visibilité par rôle est déjà appliquée par la **RLS** — pas besoin de la refaire.
