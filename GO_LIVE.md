# Mise en service v7.0

Quatre étapes. Deux ne demandent **aucun secret** et vous prennent une minute ;
les deux autres, je peux les lancer si vous me déposez les clés dans un fichier local.

---

## 1. SQL — 30 secondes, sans secret

Supabase → **SQL Editor** → **New query** → coller tout le contenu de
[`supabase/APPLY_V7.sql`](supabase/APPLY_V7.sql) → **Run**.

Ce fichier ajoute la rubrique Innovation et la lecture des liens d'accès par le
Chef / la DA-RH. Il **ne touche à aucune donnée existante** et peut être relancé
sans risque.

## 2. Les clés — pour que je fasse le reste

```powershell
cd termitiere-web
copy .secrets.local.example .secrets.local
notepad .secrets.local     # coller les 2 valeurs, enregistrer
```

| Clé | Où la prendre | Révocation |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | [Account → Tokens](https://supabase.com/dashboard/account/tokens) → *Generate new token* | Bouton **Revoke**, immédiat et sans effet de bord |
| `SUPABASE_SERVICE_ROLE_KEY` | Dashboard → Settings → API → *service_role* | Supprimer `.secrets.local` suffit (la révoquer ferait tourner le secret JWT et invaliderait aussi la clé `anon`) |

> ⚠️ **Ne collez pas ces valeurs dans la conversation** — elles y resteraient
> enregistrées. Le fichier `.secrets.local` est gitignoré et lu par les scripts
> sans jamais être affiché : seule une empreinte (longueur + 4 derniers
> caractères) est montrée, pour vérifier que la bonne clé est lue.

## 3. Déploiement + import — je m'en charge

```powershell
node scripts/go-live.mjs                     # vérifie et SIMULE, n'écrit rien
node scripts/go-live.mjs --write             # déploie notify + importe (sans supprimer)
node scripts/go-live.mjs --write --replace   # idem, l'Excel fait foi
```

**Lisez le tableau de la simulation avant d'écrire.** `--replace` est irréversible :
faites une sauvegarde (Dashboard → Database → Backups). Détail de ce que chaque
mode fait : [`scripts/IMPORT.md`](scripts/IMPORT.md).

## 4. Frontend — 10 secondes, sans secret

```powershell
npm run build
```
Puis glisser le dossier **`dist/`** sur <https://app.netlify.com/drop> (ou sur votre
site Netlify existant → *Deploys* → drag & drop).

---

## Après la mise en service

1. Supprimer `.secrets.local`.
2. Révoquer le `SUPABASE_ACCESS_TOKEN` ([même page](https://supabase.com/dashboard/account/tokens)).
3. Vérifier dans l'app : l'onglet **💡 Innovation** apparaît, et **Personnel → 🔗**
   affiche le lien existant avec le bouton « 📧 Renvoyer par email ».

Les tokens de l'Excel sont conservés à l'import : **les liens d'accès déjà
distribués continuent de fonctionner.**
