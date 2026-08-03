// ════════════════════════════════════════════════════════════════════
//  Import des données exportées (termitiere-export.json) vers Supabase.
//  Réutilise la clé SERVICE_ROLE (contourne la RLS, usage local ponctuel).
//
//  Usage (PowerShell) :
//    $env:SUPABASE_URL="https://xxxx.supabase.co"
//    $env:SUPABASE_SERVICE_ROLE_KEY="...clé service_role..."
//    node scripts/import.mjs ./termitiere-export.json              → SIMULATION
//    node scripts/import.mjs ./termitiere-export.json --write      → écrit (ajout/màj)
//    node scripts/import.mjs ./termitiere-export.json --write --replace
//                                                                  → écrit + supprime
//                                                     ce qui n'est plus dans le fichier
//
//  ⚠ La SIMULATION est le mode par défaut : elle ne modifie RIEN et affiche, table
//  par table, ce qui serait créé / mis à jour / supprimé. Lisez ce rapport avant
//  d'ajouter --write. C'est délibéré : --replace est irréversible.
//
//  Importe : personnel + tokens, tâches, membres d'équipe, messages, objectifs,
//  journalières, jours fériés, salaire, bénéficiaires externes.
// ════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const argv = process.argv.slice(2);
const FILE = argv.find((a) => !a.startsWith("-")) || "./termitiere-export.json";
const WRITE = argv.includes("--write");
const REPLACE = argv.includes("--replace");

if (!URL || !SERVICE) {
  console.error("❌ Définis SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY (variables d'environnement).");
  process.exit(1);
}
if (!fs.existsSync(FILE)) {
  console.error("❌ Fichier introuvable :", FILE);
  process.exit(1);
}

const db = createClient(URL, SERVICE, { auth: { persistSession: false } });
const data = JSON.parse(fs.readFileSync(FILE, "utf8"));

const norm = (s) => String(s == null ? "" : s).trim();
const dateOrNull = (v) => {
  const s = norm(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};
const dayOrNull = (v) => {
  const s = norm(v);
  return s ? s.slice(0, 10) : null;
};
function pick(o, ...keys) {
  for (const k of Object.keys(o)) {
    const lk = k.toLowerCase();
    if (keys.some((kw) => lk.includes(kw))) {
      const v = o[k];
      if (v !== "" && v != null) return v;
    }
  }
  return "";
}
function chunks(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

// ── Rapport (simulation comme écriture) ──────────────────────────────
const report = [];
function line(table, o) { report.push({ table, ...o }); }

// Clés déjà présentes en base, pour distinguer création et mise à jour.
async function existingKeys(table, keyCol) {
  const out = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select(keyCol).range(from, from + PAGE - 1);
    if (error) { console.warn(`⚠ lecture ${table} :`, error.message); return out; }
    (data || []).forEach((r) => out.add(String(r[keyCol])));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function countRows(table) {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error) { console.warn(`⚠ comptage ${table} :`, error.message); return 0; }
  return count || 0;
}

// Écrit (ou simule) un jeu de lignes, et calcule ce que ferait --replace.
//  - keyCol : colonne d'identité (celle du onConflict) → upsert, et --replace
//    supprime les lignes dont la clé a disparu du fichier.
//  - keyCol null : la table n'a pas de clé naturelle (son id est généré). On ne
//    peut pas apparier les lignes : --replace la vide puis réinsère (seul moyen
//    d'éviter les doublons), et sans --replace on avertit du risque de doublon.
//  - neverDelete : --replace n'efface RIEN dans cette table (cf. personnel, dont
//    l'id est référencé ailleurs). L'appelant décide quoi faire des orphelins.
async function push(table, rows, keyCol, neverDelete = false) {
  let creations, majs, orphelins = [], videes = 0;

  // ⚠ Postgres refuse un upsert dont le LOT contient deux fois la même clé
  //   (« ON CONFLICT DO UPDATE cannot affect row a second time ») et rejette alors
  //   le lot ENTIER — d'où des tables vides sans erreur visible. Les feuilles ont
  //   de vrais doublons (ex. D023 deux fois), on garde donc la dernière occurrence,
  //   ce qui reproduit la sémantique de l'upsert.
  if (keyCol) {
    const parCle = new Map();
    for (const r of rows) parCle.set(String(r[keyCol]), r);
    if (parCle.size !== rows.length) {
      console.warn(`ℹ ${table} : ${rows.length - parCle.size} doublon(s) de « ${keyCol} » dans le fichier → dernière occurrence retenue.`);
      rows = [...parCle.values()];
    }
  }

  if (keyCol) {
    const before = await existingKeys(table, keyCol);
    const wanted = new Set(rows.map((r) => String(r[keyCol])));
    creations = [...wanted].filter((k) => !before.has(k)).length;
    majs = wanted.size - creations;
    orphelins = [...before].filter((k) => !wanted.has(k));
  } else {
    videes = await countRows(table);
    creations = rows.length;
    majs = 0;
  }

  const restants = keyCol ? orphelins.length : videes;
  line(table, {
    fichier: rows.length, creations, majs,
    suppressions: REPLACE && !neverDelete ? restants : 0,
    conserves: !REPLACE || neverDelete ? restants : 0,
  });
  if (!keyCol && !REPLACE && videes) {
    console.warn(`⚠ ${table} : ${videes} ligne(s) déjà en base et pas de clé d'appariement — ` +
                 `sans --replace, l'import créerait des doublons.`);
  }

  if (!WRITE) return { orphelins };

  // Suppression AVANT insertion : le fichier fait foi.
  if (REPLACE && !neverDelete) {
    if (keyCol && orphelins.length) {
      for (const c of chunks(orphelins, 200)) {
        const { error } = await db.from(table).delete().in(keyCol, c);
        if (error) console.warn(`⚠ suppression ${table} :`, error.message);
      }
    } else if (!keyCol && videes) {
      // .neq sur une colonne toujours renseignée = « toutes les lignes »
      // (PostgREST refuse un delete sans filtre).
      const { error } = await db.from(table).delete().neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) console.warn(`⚠ vidage ${table} :`, error.message);
    }
  }
  for (const c of chunks(rows, 500)) {
    const { error } = keyCol
      ? await db.from(table).upsert(c, { onConflict: keyCol })
      : await db.from(table).insert(c);
    if (error) console.warn(`⚠ ${table} :`, error.message);
  }
  return { orphelins };
}

async function run() {
  // 1) Personnel ───────────────────────────────────────────────────
  const persons = (data.personnel || []).filter((p) => norm(p.name) && norm(p.email));
  const upPers = persons.map((p) => ({
    name: norm(p.name),
    email: norm(p.email).toLowerCase(),
    dept: norm(p.dept),
    position: norm(p.position),
    role_raw: norm(p.role_raw || p.role),
    status: norm(p.status) || "Actif",
    start_date: dayOrNull(p.start_date),
  }));
  // ⚠ Le personnel n'est JAMAIS supprimé, même avec --replace : son id est
  // référencé par les tâches, rapports et idées (une suppression échouerait, ou
  // détruirait ces liens). Les personnes absentes du fichier sont passées
  // « Inactif » — ce que fait déjà l'app quand on désactive quelqu'un.
  const { orphelins: persOrphelins } = await push("personnel", upPers, "email", true);
  if (REPLACE && persOrphelins.length) {
    console.log(`\nℹ ${persOrphelins.length} personne(s) absente(s) du fichier → passée(s) « Inactif » (jamais supprimées) :`);
    persOrphelins.forEach((e) => console.log("   ", e));
    if (WRITE) {
      const { error } = await db.from("personnel").update({ status: "Inactif" }).in("email", persOrphelins);
      if (error) console.warn("⚠ désactivation personnel :", error.message);
    }
  }

  const { data: pr, error: ePr } = await db.from("personnel").select("id,name,email");
  if (ePr) throw ePr;
  const idByName = {}, idByEmail = {}, nameById = {};
  (pr || []).forEach((r) => {
    idByName[r.name] = r.id;
    idByEmail[(r.email || "").toLowerCase()] = r.id;
    nameById[r.id] = r.name;
  });

  // 2) Tokens (liens d'accès) ───────────────────────────────────────
  // En simulation, le personnel n'a pas été écrit : les nouvelles personnes n'ont
  // pas encore d'id. Sans ce repère, le rapport annoncerait « 0 token » alors que
  // l'import réel en écrirait des dizaines — on compte donc la personne quand même.
  const authRows = persons
    .filter((p) => norm(p.token))
    .map((p) => {
      const id = idByEmail[norm(p.email).toLowerCase()];
      return { person_id: id || (WRITE ? null : "(personne à créer) " + norm(p.email)), token: norm(p.token) };
    })
    .filter((r) => r.person_id);
  // Les tokens absents du fichier (personne désactivée) sont retirés en --replace :
  // c'est exactement ce que fait deactivateEmployee(), l'accès est coupé.
  await push("personnel_auth", authRows, "person_id");

  // 3) Tâches ───────────────────────────────────────────────────────
  const tasks = (data.tasks || []).filter((t) => norm(t.id));
  const upTasks = tasks.map((t) => ({
    id: norm(t.id),
    description: norm(t.description),
    category: norm(t.category),
    recipient_name: norm(t.recipient),
    recipient_id: idByName[norm(t.recipient)] || null,
    assigned_by_name: norm(t.assignedByName),
    assigned_by_id: idByName[norm(t.assignedByName)] || null,
    assigned_by_role: norm(t.assignedByRole),
    department: norm(t.department),
    priority: norm(t.priority) || "Moyenne",
    status: norm(t.status) || "À faire",
    progress: Number(t.progress || 0),
    date_assigned: dayOrNull(t.dateAssigned),
    date_start: dayOrNull(t.dateStart),
    date_limit: dayOrNull(t.dateLimit),
    close_date: dayOrNull(t.closeDate),
    comment: norm(t.employeeComment),
    chef_note: norm(t.chefNote),
    chef_comment: norm(t.chefComment),
    group_id: norm(t.groupId),
    report_required: !!t.reportRequired,
    report_link: norm(t.reportLink),
    expected_result: norm(t.expectedResult),
    archived: false,
  }));
  const taskIds = new Set(upTasks.map((t) => t.id));
  await push("tasks", upTasks, "id");

  // 4) Membres d'équipe (dump brut de la feuille) ──────────────────
  const tm = (data.teamMembers || [])
    .map((r) => ({
      group_id: norm(pick(r, "group")),
      task_id: norm(pick(r, "task")),
      member_name: norm(pick(r, "membre nom", "membre", "nom")),
      member_email: norm(pick(r, "email")),
      is_leader: /oui|true|1|chef/i.test(String(pick(r, "chef", "leader"))),
      sub_status: norm(pick(r, "sous-statut", "statut", "status")) || "À faire",
      report_link: norm(pick(r, "rapport", "lien")),
    }))
    .filter((x) => x.task_id && taskIds.has(x.task_id));
  tm.forEach((x) => (x.member_id = idByName[x.member_name] || null));
  await push("team_members", tm, null);

  // 5) Messages ─────────────────────────────────────────────────────
  const msgs = (data.messages || [])
    .map((r) => ({
      task_id: norm(pick(r, "task", "tâche", "tache")),
      group_id: norm(pick(r, "group")),
      author_name: norm(pick(r, "auteur", "author", "nom", "expéditeur", "expediteur")),
      author_email: norm(pick(r, "email")),
      body: norm(pick(r, "message", "contenu", "texte", "body")),
      created_at: dateOrNull(pick(r, "date", "horodatage")),
    }))
    .filter((x) => x.task_id && taskIds.has(x.task_id) && x.body);
  await push("messages", msgs, null);

  const truthy = (v) => !/^(non|false|0|)$/i.test(String(v == null ? "" : v).trim());

  // 6) Objectifs (+ commentaires) ──────────────────────────────────
  const objectives = (data.objectives || []).map((r) => ({
    id: norm(pick(r, "id")), type: norm(pick(r, "type")) || "perso",
    target: norm(pick(r, "cible", "target")), author_name: norm(pick(r, "auteur", "author")),
    title: norm(pick(r, "titre", "title")), description: norm(pick(r, "description")),
    date_start: dayOrNull(pick(r, "début", "debut", "start")), date_end: dayOrNull(pick(r, "fin", "end")),
    progress: Number(pick(r, "avancement", "progress") || 0) || 0,
    status: norm(pick(r, "statut", "status")) || "En cours", comment: norm(pick(r, "commentaire", "comment")),
  })).filter((o) => o.id);
  const objIds = new Set(objectives.map((o) => o.id));
  await push("objectives", objectives, "id");

  const objComments = (data.objectiveComments || []).map((r) => ({
    id: norm(pick(r, "id")), objective_id: norm(pick(r, "objectif", "objective")),
    author_name: norm(pick(r, "auteur", "author")), author_email: norm(pick(r, "email")),
    body: norm(pick(r, "commentaire", "comment", "message")), created_at: dateOrNull(pick(r, "date")),
  })).filter((c) => c.id && objIds.has(c.objective_id));
  await push("objective_comments", objComments, "id");

  // 7) Routine journalière (définitions + journal) ─────────────────
  const dailyTasks = (data.dailyTasks || []).map((r) => ({
    id: norm(pick(r, "id")), employee_name: norm(pick(r, "employé", "employe")),
    employee_id: idByName[norm(pick(r, "employé", "employe"))] || null,
    label: norm(pick(r, "libellé", "libelle", "label")), description: norm(pick(r, "description")),
    sort_order: Number(pick(r, "ordre", "order") || 0) || 0, active: truthy(pick(r, "actif", "active")),
    author_name: norm(pick(r, "créé", "cree", "author")),
  })).filter((d) => d.id);
  const dailyIds = new Set(dailyTasks.map((d) => d.id));
  await push("daily_tasks", dailyTasks, "id");

  const dailyLog = (data.dailyLog || []).map((r) => ({
    id: norm(pick(r, "id")), daily_task_id: norm(pick(r, "tâche", "tache", "task")),
    employee_name: norm(pick(r, "employé", "employe")), log_date: dayOrNull(pick(r, "date")),
    done: truthy(pick(r, "fait", "done")), checked_at: dateOrNull(pick(r, "heure", "coche", "checked")),
    note: norm(pick(r, "note")),
  })).filter((l) => l.id && l.log_date && dailyIds.has(l.daily_task_id));
  await push("daily_log", dailyLog, "id");

  // 8) Jours fériés ────────────────────────────────────────────────
  const holidays = (data.holidays || []).map((r) => ({
    holiday_date: dayOrNull(pick(r, "date")), label: norm(pick(r, "libellé", "libelle", "label")) || "Férié",
  })).filter((h) => h.holiday_date);
  await push("holidays", holidays, "holiday_date");

  // 9) Autorisations salaire + bénéficiaires externes ──────────────
  const salary = (data.salary || []).map((r) => ({
    id: norm(pick(r, "id")), person: norm(pick(r, "personne", "person")),
    periode: norm(pick(r, "période", "periode")), montant: norm(pick(r, "montant")),
    status: norm(pick(r, "statut", "status")) || "Demandé",
    requested_by: norm(pick(r, "demandé par", "demande par")), requested_at: dateOrNull(pick(r, "demandé le", "demande le")),
    validated_by: norm(pick(r, "validé par", "valide par")), validated_at: dateOrNull(pick(r, "validé le", "valide le")),
    approved_by: norm(pick(r, "approuvé par", "approuve par")), approved_at: dateOrNull(pick(r, "approuvé le", "approuve le")),
    authorized_by: norm(pick(r, "autorisé par", "autorise par")), authorized_at: dateOrNull(pick(r, "autorisé le", "autorise le")),
    rejected_by: norm(pick(r, "rejeté par", "rejete par")), rejected_at: dateOrNull(pick(r, "rejeté le", "rejete le")),
    reject_reason: norm(pick(r, "motif")), note: norm(pick(r, "note")),
  })).filter((s) => s.id && s.person);
  await push("salary_authorizations", salary, "id");

  const salExt = (data.salaryExternal || []).map((r) => ({
    name: norm(pick(r, "nom", "name")), structure: norm(pick(r, "structure", "fonction")),
    email: norm(pick(r, "email")), note: norm(pick(r, "note")),
    added_by: norm(pick(r, "ajouté", "ajoute", "added")), active: truthy(pick(r, "actif", "active")),
  })).filter((b) => b.name);
  await push("salary_external_beneficiaries", salExt, null);

  // ── Rapport ──────────────────────────────────────────────────────
  const col = (v, n) => String(v).padStart(n);
  console.log("\n" + (WRITE ? "✅ Import terminé." : "🔍 SIMULATION — aucune donnée n'a été modifiée."));
  console.log(REPLACE ? "   Mode : REMPLACEMENT (le fichier fait foi)\n" : "   Mode : ajout / mise à jour, sans suppression\n");
  console.log("  TABLE                            FICHIER  CRÉÉES    MÀJ  SUPPR.  GARDÉES");
  for (const r of report) {
    console.log("  " + r.table.padEnd(30) + col(r.fichier, 8) + col(r.creations, 8) +
                col(r.majs, 7) + col(r.suppressions, 8) + col(r.conserves, 9));
  }
  const totalSuppr = report.reduce((s, r) => s + r.suppressions, 0);

  if (!WRITE) {
    console.log("\n  Pour appliquer :");
    console.log("    node scripts/import.mjs " + FILE + " --write" + (REPLACE ? " --replace" : ""));
    if (REPLACE && totalSuppr) {
      console.log(`\n  ⚠ --write --replace supprimera ${totalSuppr} ligne(s) définitivement. Faites une sauvegarde`);
      console.log("    Supabase (Dashboard → Database → Backups) avant de lancer.");
    }
    console.log("\n  ℹ Les rapports, idées et pièces jointes déposés sur la plateforme ne sont");
    console.log("    jamais touchés : ils n'existent pas dans le fichier Excel.");
  }

  const base = (process.env.APP_URL || "http://localhost:5173").replace(/\/+$/, "");
  console.log(`\n📨 Liens d'accès (base = ${base}) : ${authRows.length} personne(s).`);
  if (WRITE) {
    authRows.forEach((a) => {
      console.log(`  ${nameById[a.person_id] || "?"} : ${base}/?token=${encodeURIComponent(a.token)}`);
    });
  } else {
    console.log("   (la liste détaillée s'affiche lors de l'import réel)");
  }
}

run().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
