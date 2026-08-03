# Import des données : Excel / Google Sheets → Supabase

Deux sources possibles, **un seul importeur**. Le format pivot est toujours
`termitiere-export.json`.

- **Voie A — depuis le fichier Excel** (celui que l'équipe utilise, à la racine du dépôt).
  À privilégier : pas besoin d'accéder à l'éditeur Apps Script.
- **Voie B — depuis Apps Script** (`exportAllData`). Utile si le Google Sheet est plus
  à jour que le fichier Excel téléchargé.

Les deux produisent le **même JSON** : le convertisseur Excel réplique volontairement
les parseurs de `code.gs.js` (mêmes lignes d'en-tête, mêmes colonnes, mêmes règles).

---

## Voie A — Convertir l'Excel

Depuis `termitiere-web/` :
```powershell
node scripts/xlsx-to-json.mjs "../Gestion_des_tâches_la_termitière (2).xlsx"
```
Cela écrit `termitiere-export.json` et affiche le nombre de lignes par module.
Lecture seule : aucune base n'est touchée.

## Voie B — Exporter depuis Apps Script
1. Ouvre le projet **Apps Script**, sélectionne la fonction **`exportAllData`** → **Exécuter**.
2. **Exécution → Journaux** : l'URL du `termitiere-export.json` créé dans ton Drive.
3. Télécharge-le dans `termitiere-web/`.

---

## Étape 2 — Simuler l'import (ne modifie RIEN)

Récupère ta clé **service_role** : Supabase → Settings → API → *Project API keys* →
**`service_role`** (secrète — usage local uniquement, jamais dans le frontend).

```powershell
$env:SUPABASE_URL="https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="...ta clé service_role..."
node scripts/import.mjs ./termitiere-export.json
```

**La simulation est le mode par défaut.** Elle affiche, table par table, ce qui serait
créé / mis à jour / supprimé / gardé. **Lis ce tableau avant d'écrire.**

## Étape 3 — Écrire

```powershell
# Ajout + mise à jour, sans rien supprimer :
node scripts/import.mjs ./termitiere-export.json --write

# Remplacement : le fichier fait foi, ce qui n'y est plus est supprimé.
node scripts/import.mjs ./termitiere-export.json --write --replace
```

> ⚠️ `--replace` est **irréversible**. Fais d'abord une sauvegarde :
> Supabase → Database → Backups.

---

## Ce que `--replace` fait exactement

| Table | Comportement |
|---|---|
| `personnel` | **Jamais supprimé** — son id est référencé par les tâches, rapports et idées. Les personnes absentes du fichier passent **Inactif**. |
| `personnel_auth` | Les tokens des personnes absentes sont **supprimés** (l'accès est coupé, comme le fait « Désactiver » dans l'app). |
| `tasks`, `objectives`, `daily_tasks`, `daily_log`, `holidays`, `salary_authorizations` | Appariées par id / date : ce qui n'est plus dans le fichier est supprimé. |
| `team_members`, `messages`, `salary_external_beneficiaries` | Pas de clé d'appariement (id généré) → la table est **vidée puis réinsérée**. C'est le seul moyen d'éviter les doublons : sans `--replace`, relancer l'import les duplique (le script prévient). |
| `reports`, `innovations`, `attachments` | **Jamais touchées** — elles n'existent pas dans l'Excel. |

## Prérequis

Lance l'import **après** avoir exécuté toutes les migrations SQL (`0001` → `0015`) :
certaines tables (objectifs, journalières) ont été recréées en id texte.

## Ce qui est importé
- ✅ **personnel** (+ tokens), **tâches**, **membres d'équipe**, **messages**
- ✅ **objectifs** (+ commentaires), **routine journalière** (définitions + journal de coches)
- ✅ **jours fériés**, **autorisations salaire**, **bénéficiaires externes**

Les **pièces jointes** et **rapports** (fichiers) ne sont pas migrés : ils vivent dans
Google Drive côté Apps Script et dans Supabase Storage côté plateforme. Les tâches
gardent en revanche leur `reportLink` vers Drive.

## Après l'import
Le script affiche la **liste des liens d'accès** par personne. Les tokens de l'Excel
sont conservés : **les liens déjà distribués continuent de fonctionner**. Pour en
renvoyer un, l'onglet **Personnel** → 🔗 → « 📧 Renvoyer par email ».
