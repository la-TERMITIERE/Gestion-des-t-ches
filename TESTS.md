# Checklist de validation en réel

À faire après import des vraies données + déploiement. Coche chaque ligne ; si un point
échoue, ouvre la **Console (F12)** et note l'erreur.

## Pré-requis
- [ ] Toutes les migrations `0001` → `0011` exécutées (SQL Editor).
- [ ] Edge Functions déployées : `auth-token`, `notify`, `daily-reminders` (+ secrets).
- [ ] Données importées (`node scripts/import.mjs …`).
- [ ] App ouverte avec un **vrai** lien : `…/?token=<token d'une personne>`.

## Connexion & visibilité
- [ ] Connexion en tant qu'**admin** → voit toutes les tâches.
- [ ] Connexion en tant qu'**employé** → ne voit que ses tâches (pas celles des autres).
- [ ] Le nom et le rôle affichés en haut sont corrects.

## Tâches
- [ ] La liste affiche les bonnes tâches (statut, échéance, priorité, destinataire).
- [ ] **Créer** une tâche simple → apparaît, le destinataire reçoit un e-mail.
- [ ] **Créer** une tâche d'équipe (chef + membres) → chacun la voit.
- [ ] Changer **statut / avancement / commentaire** → enregistré.
- [ ] Marquer **Terminé** → l'assigneur reçoit l'e-mail « terminée ».
- [ ] **Réassigner** / **retourner** / **renvoyer pour correction** → e-mail au bon destinataire.
- [ ] **Chat** d'une tâche : poster / voir / supprimer un message.
- [ ] **Pièce jointe** : ajouter un PDF/photo → visible et téléchargeable ; supprimer.
- [ ] **Supprimer** une tâche (chef/assigneur).

## Objectifs
- [ ] Liste visible selon le rôle ; **créer / modifier / supprimer** un objectif.
- [ ] **Commenter** un objectif.

## Routine journalière
- [ ] Cocher / décocher une tâche du jour (se réinitialise le lendemain).
- [ ] Tableau de **conformité** (🟢🟡🔴) cohérent ; **dimanches & fériés** exclus.
- [ ] Clic sur une personne → détail jour par jour.

## Autorisation salaire (RH/DF/GE/PAU)
- [ ] RH : **Demande d'autorisation** → le(s) DF reçoivent un e-mail.
- [ ] DF **valide** → GE notifié ; GE **approuve** → PAU notifié ; PAU **autorise** → RH notifiée.
- [ ] **Rejet** à une étape → RH notifiée avec le motif.
- [ ] **Bénéficiaire externe** : enregistrer, lancer une demande, retirer.

## Personnel (chef/RH)
- [ ] **Ajouter** un employé → reçoit l'e-mail de bienvenue avec son lien.
- [ ] **Modifier** un employé ; **désactiver** (son lien ne marche plus).
- [ ] **Régénérer** un lien d'accès.

## Archives
- [ ] L'onglet Archives affiche les tâches archivées ; la recherche fonctionne.

## Cron (à vérifier plus tard)
- [ ] `select archive_old_tasks();` archive bien une vieille tâche Terminé.
- [ ] Appel manuel de `daily-reminders` → e-mail de rappel reçu.
