# E-mails de notification (Brevo)

Les notifications (tâche assignée, terminée, appréciation, renvoi, circuit salaire,
bienvenue / lien d'accès) sont envoyées par l'Edge Function **`notify`**. Les rappels de
démarrage par **`daily-reminders`**. L'envoi passe par **Brevo** (ex-Sendinblue).

## Pourquoi Brevo (et pas de domaine à acheter)
Contrairement à Resend, Brevo permet d'envoyer en vérifiant **une seule adresse**
(la tienne) au lieu d'un domaine entier — exactement l'esprit de ton ancien envoi « en ton
nom ». Palier gratuit : **300 e-mails/jour**.

## Configuration (≈ 5 min)
1. Crée un compte sur **https://www.brevo.com** (gratuit).
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender** : mets ton nom + **ton
   adresse e-mail** (ex. ton Gmail). Brevo t'envoie un mail de confirmation → clique le lien.
   ✅ Ton adresse est maintenant « expéditeur vérifié » (aucun domaine requis).
3. **SMTP & API → API Keys → Generate a new API key** → copie la clé.
4. Renseigne les secrets des Edge Functions :
   ```bash
   supabase secrets set BREVO_API_KEY="xkeysib-..."
   supabase secrets set EMAIL_FROM="LA TERMITIERE <ton-adresse-verifiee@gmail.com>"
   supabase secrets set APP_URL="https://ton-app.netlify.app"
   ```
   ⚠️ L'adresse dans `EMAIL_FROM` **doit** être celle vérifiée à l'étape 2.

## Déploiement des fonctions
```bash
supabase functions deploy notify
supabase functions deploy daily-reminders
```
`APP_URL` sert à construire les **liens profonds** des e-mails (vers la bonne tâche / le bon onglet).

## Rappels & archivage automatiques
- `0010_cron_archive.sql` : archive les tâches Terminé > 3 mois (dimanche 03:00). Pur SQL, rien à configurer.
- `0011_cron_reminders.sql` : appelle `daily-reminders` chaque jour (sauf dimanche, 07:00 UTC).
  **Renseigne `PROJECT_REF` et `SERVICE_ROLE_KEY`** dans le fichier avant de l'exécuter.

## Tester
- Crée une tâche pour quelqu'un (avec une vraie adresse) → il doit recevoir l'e-mail.
- Si rien n'arrive : Supabase → Edge Functions → `notify` → **Logs** (souvent : adresse
  expéditeur non vérifiée chez Brevo, ou `BREVO_API_KEY` manquante).

## Architecture (pourquoi côté serveur)
Le navigateur n'a **pas** le droit de lire les tokens (sécurité). C'est donc l'Edge Function
`notify` (clé service) qui résout l'e-mail **et** le token du destinataire pour bâtir un lien
profond correct. Le frontend appelle `notify` en « tire-et-oublie » après chaque action :
l'e-mail ne ralentit ni ne bloque jamais l'interface.
