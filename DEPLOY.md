# Mettre l'application en ligne

L'app est un site statique (Vite). Deux chemins : **A) glisser-déposer** (le plus simple,
sans git) ou **B) via git** (redéploiement automatique à chaque modif).

> ⚠️ Les variables `VITE_*` sont **intégrées au build**. La clé `anon` est publique par
> conception (c'est la RLS qui protège les données), donc l'intégrer au build est normal.

---

## Option A — Netlify Drop (recommandé pour démarrer, aucun compte technique)

1. Vérifie que `termitiere-web/.env` contient bien **ton** URL et ta clé anon
   (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
2. Construis le site :
   ```powershell
   npm run build
   ```
   → un dossier **`dist/`** est créé.
3. Va sur **https://app.netlify.com/drop** (crée un compte gratuit si besoin).
4. **Glisse-dépose le dossier `dist`** sur la page.
5. Netlify te donne une URL publique du type `https://xxxx.netlify.app`. **C'est ton app en ligne.** 🎉

### Mettre à jour plus tard
Refais `npm run build`, puis dans Netlify → ton site → **Deploys** → glisse à nouveau le
dossier `dist` (ou « Drag and drop »).

---

## Option B — Déploiement git (redéploiement auto)

1. Mets `termitiere-web/` dans un dépôt GitHub.
2. Sur **Vercel** (vercel.com) ou **Netlify** : *New project* → importe le dépôt.
   - Build command : `npm run build` · Output : `dist` (déjà dans `vercel.json` / `netlify.toml`).
3. **Variables d'environnement** (dans le dashboard du host) :
   - `VITE_SUPABASE_URL` = `https://qbzvvnzeuxfxikjvxdyc.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = ta clé anon
4. Deploy. À chaque `git push`, le site se reconstruit tout seul.

---

## Après la mise en ligne

### 1. Régénérer les liens d'accès vers la prod
Les liens envoyés aux collègues doivent pointer vers l'URL publique, pas localhost.
Relance l'importeur en précisant l'URL (il ré-affiche les liens) :
```powershell
$env:SUPABASE_URL="https://qbzvvnzeuxfxikjvxdyc.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="...service_role..."
$env:APP_URL="https://xxxx.netlify.app"
node scripts/import.mjs ./termitiere-export.json
```
> Les liens **internes** générés par l'app (bouton « lien d'accès » du Personnel) utilisent
> automatiquement l'URL où l'app est ouverte — donc déjà corrects en prod.

### 2. CORS / Edge Functions
Rien à faire : `auth-token` et `send-email` renvoient `Access-Control-Allow-Origin: *`,
donc elles fonctionnent depuis n'importe quelle URL.

### 3. (Optionnel) Nom de domaine personnalisé
Netlify/Vercel → *Domain settings* → ajoute ton domaine (ex. `taches.mon-entreprise.com`).
