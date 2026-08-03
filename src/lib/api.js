// ════════════════════════════════════════════════════════════════════
//  Couche API — équivalent Supabase de code.gs.js
//  Chaque handler porte le MÊME nom et renvoie la MÊME forme d'objet que la
//  fonction Apps Script correspondante, pour que l'UI legacy fonctionne sans
//  changement (c'est le « seam » call()).
//
//  ✅ Implémentés (tranche verticale) : bootstrapApp, getTasks, getPersonnel,
//     updateTask.
//  ⏳ À porter (Phase 2) : objectifs, journalières, messages, pièces jointes,
//     salaire, archives, emails… → ajouter un handler ci-dessous.
// ════════════════════════════════════════════════════════════════════
import { anon, db, setJwt } from "./supabaseClient.js";

let user = null;
export function getUser() { return user; }

// Notification e-mail « tire-et-oublie » : n'interrompt jamais l'action en cours.
function notify(type, data) {
  try {
    db.functions.invoke("notify", { body: { type, actorName: user && user.name, ...data } })
      .then((r) => { if (r && r.error) console.warn("notify", type, r.error.message); })
      .catch((e) => console.warn("notify", type, e));
  } catch (e) { /* jamais bloquant */ }
}

// ── Authentification : token → JWT (Edge Function auth-token) ─────────
export async function authenticate(token) {
  const { data, error } = await anon.functions.invoke("auth-token", { body: { token } });
  if (error) throw new Error("auth-token : " + error.message);
  if (!data || !data.success) throw new Error((data && data.error) || "Authentification échouée");
  setJwt(data.jwt);
  user = data.user;
  // ✨ v7.0 : l'UI est partagée avec l'app Apps Script d'origine, qui n'a pas ces
  // handlers. Ce drapeau lui dit quels écrans cette plateforme sait servir ; sous
  // Apps Script il n'existe pas, et les écrans concernés restent masqués.
  user.features = { innovation: true, resendLink: true };
  return data;
}

// Traduit les erreurs Postgres brutes en français. « new row violates row-level
// security policy » ne veut rien dire pour un utilisateur : on explique ce qui
// s'est passé et quoi faire, plutôt que de laisser fuiter le jargon SQL.
function friendlyError(err, contexte) {
  const m = String((err && err.message) || err || "");
  if (/row-level security/i.test(m)) {
    return contexte || "Vous n'avez pas les droits nécessaires pour cette action.";
  }
  if (/duplicate key/i.test(m)) return "Cet enregistrement existe déjà.";
  if (/violates foreign key/i.test(m)) return "Référence introuvable (personne ou tâche supprimée ?).";
  if (/JWT|expired/i.test(m)) return "Votre session a expiré — rouvrez votre lien d'accès.";
  return m;
}

// ── Mappers : ligne Postgres → objet attendu par l'UI legacy ─────────
function mapTask(r) {
  const isTeam = !!(r.group_id && String(r.group_id).trim());
  return {
    id: r.id,
    description: r.description || "",
    category: r.category || "",
    recipient: r.recipient_name || "",
    assignedByName: r.assigned_by_name || "",
    assignedByRole: r.assigned_by_role || "",
    department: r.department || "",
    priority: r.priority || "Moyenne",
    status: r.status || "À faire",
    progress: Number(r.progress || 0),
    dateAssigned: r.date_assigned || "",
    dateStart: r.date_start || "",
    dateLimit: r.date_limit || "",
    closeDate: r.close_date || "",
    // ⚠ parité : l'UI lit `employeeComment` (pas `comment`)
    employeeComment: r.comment || "",
    chefNote: r.chef_note || "",
    chefComment: r.chef_comment || "",
    groupId: r.group_id || "",
    isTeamTask: isTeam,
    reportRequired: !!r.report_required,
    reportLink: r.report_link || "",
    expectedResult: r.expected_result || "",
    teamMembers: [],
    messagesCount: 0,
    attachmentsCount: 0,
    canEdit: false,
    canEditAsMember: false,
  };
}

async function loadTasks() {
  const me = user && user.name;
  const { data: rows, error } = await db.from("tasks").select("*").eq("archived", false);
  if (error) throw error;
  const tasks = (rows || []).map(mapTask);
  const ids = tasks.map((t) => t.id);
  if (!ids.length) return tasks;

  // Membres d'équipe (visibilité gérée par la RLS)
  const { data: tm } = await db.from("team_members").select("*").in("task_id", ids);
  const byTask = {};
  (tm || []).forEach((m) => {
    (byTask[m.task_id] = byTask[m.task_id] || []).push({
      name: m.member_name, email: m.member_email, isLeader: m.is_leader,
      subStatus: m.sub_status, reportLink: m.report_link || "",
    });
  });

  // Compteurs messages / pièces jointes
  const { data: msgs } = await db.from("messages").select("task_id").in("task_id", ids);
  const mc = {}; (msgs || []).forEach((x) => (mc[x.task_id] = (mc[x.task_id] || 0) + 1));
  const { data: atts } = await db.from("attachments").select("task_id").in("task_id", ids);
  const ac = {}; (atts || []).forEach((x) => (ac[x.task_id] = (ac[x.task_id] || 0) + 1));

  tasks.forEach((t) => {
    t.teamMembers = byTask[t.id] || [];
    t.messagesCount = mc[t.id] || 0;
    t.attachmentsCount = ac[t.id] || 0;
    // canUserEditTask : chef, assigneur ou destinataire
    t.canEdit = user.role === "chef" || t.assignedByName === me || t.recipient === me;
    t.canEditAsMember = !!t.groupId && (user.role === "chef" || t.teamMembers.some((x) => x.name === me));
  });
  return tasks;
}

async function loadPersonnel() {
  const { data, error } = await db
    .from("personnel")
    .select("id,name,email,dept,position,role_raw,role_norm,status");
  if (error) throw error;

  // ✨ v7.0 : le Chef et la DA-RH récupèrent les tokens pour pouvoir réafficher et
  // renvoyer un lien perdu (cf. 0014). Pour tout autre rôle la RLS renvoie 0 ligne,
  // et l'UI retombe simplement sur token vide — inutile d'interroger la table.
  const canReadTokens = user && (user.role === "chef" || user.role === "rh");
  const tokens = {};
  if (canReadTokens) {
    const { data: auth } = await db.from("personnel_auth").select("person_id,token");
    for (const a of auth || []) tokens[a.person_id] = a.token;
  }

  return (data || []).map((p) => ({
    id: p.id, num: "", name: p.name, email: p.email, dept: p.dept, position: p.position,
    role: p.role_raw, roleNorm: p.role_norm, status: p.status,
    token: tokens[p.id] || "", startDate: "",
  }));
}

// ── Helpers communs ───────────────────────────────────────────────────
const norm = (s) => String(s == null ? "" : s).trim();
const todayISO = () => new Date().toISOString().slice(0, 10);
function roleLabel(role) {
  return { chef: "Chef Administrateur", dir: "Directeur", dept_head: "Chef de département",
           emp: "Employé", rh: "DA-RH" }[role] || "Employé";
}
function fmtDateTime(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function personByName(name) {
  const n = norm(name);
  if (!n) return null;
  const { data } = await db.from("personnel").select("id,name,email,dept,role_norm").eq("name", n).limit(1);
  return (data && data[0]) || null;
}
let _me = null;
async function meRow() {
  if (_me) return _me;
  _me = await personByName(user && user.name);
  return _me;
}
// ID générés CÔTÉ BASE (voient toutes les lignes malgré la RLS → zéro collision).
async function nextTaskId() {
  const { data, error } = await db.rpc("next_id", { p_table: "tasks", p_prefix: "T", p_pad: 3 });
  if (error) throw error;
  return data;
}
async function nextGroupId() {
  const { data, error } = await db.rpc("next_group_id");
  if (error) throw error;
  return data;
}
async function loadTaskRow(taskId) {
  const { data } = await db.from("tasks").select("*").eq("id", taskId).limit(1);
  return (data && data[0]) || null;
}

// ── Handlers (mêmes noms que les fonctions Apps Script) ──────────────
// Champs dont la modification mérite un e-mail au destinataire : le fond de la
// tâche. Volontairement sans progress/comment/chefNote, qui changent en continu.
// Forme : clé côté UI → [colonne Postgres, libellé affiché dans l'e-mail].
const WATCHED_FIELDS = {
  description:    ["description",     "Description"],
  dateLimit:      ["date_limit",      "Date limite"],
  dateStart:      ["date_start",      "Date de début"],
  priority:       ["priority",        "Priorité"],
  category:       ["category",        "Catégorie"],
  expectedResult: ["expected_result", "Résultat attendu"],
};

const handlers = {
  async bootstrapApp() {
    const [tasks, personnel] = await Promise.all([loadTasks(), loadPersonnel()]);
    return { success: true, user, tasks, personnel };
  },

  async getTasks() {
    return { success: true, tasks: await loadTasks(), user };
  },

  async getPersonnel() {
    return { success: true, personnel: await loadPersonnel() };
  },

  async updateTask(_token, payload) {
    if (!payload || !payload.id) return { success: false, error: "ID manquant." };
    const map = {
      status: "status", progress: "progress", comment: "comment", description: "description",
      priority: "priority", dateLimit: "date_limit", dateStart: "date_start", category: "category",
      chefNote: "chef_note", chefComment: "chef_comment", reportRequired: "report_required",
      reportLink: "report_link", expectedResult: "expected_result", closeDate: "close_date",
    };
    const patch = {};
    for (const k in map) if (k in payload) patch[map[k]] = payload[k];
    if (payload.status === "Terminé") {
      patch.progress = 100;
      patch.close_date = new Date().toISOString().slice(0, 10);
    }
    // On charge la tâche si une notification en dépend (clôture / appréciation / modification)
    const watched = Object.keys(WATCHED_FIELDS).some((k) => k in payload);
    const needsTask = payload.status === "Terminé" || ("chefComment" in payload && norm(payload.chefComment)) || watched;
    const t = needsTask ? await loadTaskRow(payload.id) : null;
    const { error } = await db.from("tasks").update(patch).eq("id", payload.id);
    if (error) return { success: false, error: error.message };
    if (t && payload.status === "Terminé")
      notify("task_completed", { assigner: t.assigned_by_name, taskId: t.id, description: t.description });
    if (t && "chefComment" in payload && norm(payload.chefComment))
      notify("task_appreciation", { recipient: t.recipient_name, taskId: t.id, text: norm(payload.chefComment) });
    // ✨ v7.0 : le destinataire est prévenu quand on change le fond de sa tâche.
    // On compare avant/après pour ne jamais notifier une « modification » à vide
    // (l'UI renvoie souvent des champs inchangés), et on se tait si c'est lui l'auteur.
    if (t && payload.status !== "Terminé" && t.recipient_name !== user.name) {
      const changes = [];
      for (const k in WATCHED_FIELDS) {
        if (!(k in payload)) continue;
        const [col, label] = WATCHED_FIELDS[k];
        const before = norm(t[col]);
        const after = norm(payload[k]);
        if (before !== after) changes.push({ label, before, after });
      }
      if (changes.length)
        notify("task_modified", { recipient: t.recipient_name, taskId: t.id, description: t.description, changes });
    }
    return { success: true };
  },

  async forceRefreshServer() { return { success: true }; }, // cache inutile avec Postgres

  // ── Création de tâches ─────────────────────────────────────────────
  async addTask(_t, payload) {
    if (!payload || !payload.recipient || !payload.description || !payload.dateLimit)
      return { success: false, error: "Champs requis : destinataire, description, date limite." };
    const recipient = await personByName(payload.recipient);
    if (!recipient) return { success: false, error: "Destinataire introuvable : " + payload.recipient };
    const me = await meRow();
    const id = await nextTaskId();
    const row = {
      id, description: norm(payload.description), category: norm(payload.category),
      recipient_name: recipient.name, recipient_id: recipient.id,
      assigned_by_name: user.name, assigned_by_id: me ? me.id : null, assigned_by_role: roleLabel(user.role),
      department: recipient.dept || "", priority: norm(payload.priority) || "Moyenne",
      status: "À faire", progress: 0, date_assigned: todayISO(),
      date_start: payload.dateStart || null, date_limit: payload.dateLimit,
      chef_note: norm(payload.chefNote), report_required: !!payload.reportRequired,
      expected_result: norm(payload.expectedResult), group_id: "",
    };
    const { error } = await db.from("tasks").insert(row);
    if (error) return { success: false, error: error.message };
    if (recipient.name !== user.name)
      notify("task_assigned", { recipient: recipient.name, taskId: id, description: norm(payload.description), dateLimit: payload.dateLimit });
    return { success: true, id, selfAssigned: recipient.name === user.name };
  },

  async addTaskTeam(_t, payload) {
    if (!payload || !payload.description || !payload.dateLimit)
      return { success: false, error: "Description et date limite obligatoires." };
    if (!payload.leaderName) return { success: false, error: "Vous devez désigner un chef de groupe." };

    let memberNames = [];
    if (payload.mode === "department") {
      if (!payload.department) return { success: false, error: "Département non précisé." };
      const all = await loadPersonnel();
      memberNames = all
        .filter((p) => (p.status || "").toLowerCase() !== "inactif" && p.dept &&
          p.dept.toLowerCase() === payload.department.toLowerCase())
        .map((p) => p.name);
      if (!memberNames.length) return { success: false, error: 'Aucun membre actif dans "' + payload.department + '".' };
    } else if (payload.mode === "custom") {
      if (!Array.isArray(payload.memberNames) || !payload.memberNames.length)
        return { success: false, error: "Aucun membre sélectionné." };
      memberNames = payload.memberNames.slice();
    } else return { success: false, error: "Mode d'équipe invalide." };

    if (memberNames.indexOf(payload.leaderName) === -1) memberNames.push(payload.leaderName);
    if (memberNames.length < 2) return { success: false, error: "Une équipe doit comporter au moins 2 personnes." };

    const { data: persons } = await db.from("personnel").select("id,name,email,dept").in("name", memberNames);
    const byName = {}; (persons || []).forEach((p) => (byName[p.name] = p));
    const missing = memberNames.filter((n) => !byName[n]);
    if (missing.length) return { success: false, error: "Membres introuvables : " + missing.join(", ") };
    const leader = byName[payload.leaderName];

    const me = await meRow();
    const id = await nextTaskId();
    const groupId = await nextGroupId();
    const { error: eT } = await db.from("tasks").insert({
      id, description: norm(payload.description), category: norm(payload.category),
      recipient_name: leader.name, recipient_id: leader.id,
      assigned_by_name: user.name, assigned_by_id: me ? me.id : null, assigned_by_role: roleLabel(user.role),
      department: leader.dept || "", priority: norm(payload.priority) || "Moyenne",
      status: "À faire", progress: 0, date_assigned: todayISO(),
      date_start: payload.dateStart || null, date_limit: payload.dateLimit,
      chef_note: norm(payload.chefNote), report_required: !!payload.reportRequired,
      expected_result: norm(payload.expectedResult), group_id: groupId,
    });
    if (eT) return { success: false, error: eT.message };

    const rows = memberNames.map((n) => ({
      group_id: groupId, task_id: id, member_id: byName[n].id, member_name: byName[n].name,
      member_email: byName[n].email || "", is_leader: n === leader.name,
      sub_status: "À faire", report_link: "",
    }));
    const { error: eM } = await db.from("team_members").insert(rows);
    // ⚠ Deux requêtes distinctes, donc pas de transaction : si la composition de
    // l'équipe échoue, la tâche existe déjà. Sans ce retour en arrière, l'écran
    // affichait une erreur alors que la tâche était bien créée — et un second
    // essai la dupliquait. On annule donc la tâche pour revenir à l'état initial.
    if (eM) {
      await db.from("tasks").delete().eq("id", id);
      return { success: false, error: friendlyError(eM,
        "Création d'équipe refusée : votre compte n'a pas encore le droit de composer une équipe. " +
        "Signalez-le à l'administrateur (correctif RLS 0016 à appliquer). Aucune tâche n'a été créée.") };
    }
    memberNames.forEach((n) => {
      if (n !== user.name) notify("task_assigned", { recipient: n, taskId: id, description: norm(payload.description), dateLimit: payload.dateLimit });
    });
    return { success: true, id, groupId, memberCount: memberNames.length, leaderName: leader.name };
  },

  async updateTeamMember(_t, payload) {
    if (!payload || !payload.groupId || !payload.memberName)
      return { success: false, error: "Données incomplètes." };
    const patch = { updated_at: new Date().toISOString() };
    if ("subStatus" in payload) patch.sub_status = String(payload.subStatus);
    if ("reportLink" in payload) {
      const link = norm(payload.reportLink);
      if (link && !/^https?:\/\//i.test(link))
        return { success: false, error: "Le lien doit commencer par http:// ou https://" };
      patch.report_link = link;
    }
    const { error } = await db.from("team_members").update(patch)
      .eq("group_id", payload.groupId).eq("member_name", payload.memberName);
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  // ── Gestion de tâche ───────────────────────────────────────────────
  async changeTaskRecipient(_t, taskId, newRecipientName, reason) {
    const t = await loadTaskRow(taskId);
    if (!t) return { success: false, error: "Tâche introuvable." };
    if (user.role !== "chef" && t.assigned_by_name !== user.name)
      return { success: false, error: "Seul l'assignateur ou le Chef Admin peut changer le destinataire." };
    if (t.recipient_name === newRecipientName) return { success: false, error: "Destinataire identique à l'actuel." };
    if (t.status === "Terminé") return { success: false, error: "Impossible de réaffecter une tâche terminée." };
    const np = await personByName(newRecipientName);
    if (!np) return { success: false, error: "Destinataire introuvable : " + newRecipientName };
    const note = "🔄 Réaffectée de " + t.recipient_name + " vers " + np.name +
      (norm(reason) ? " — Motif : " + norm(reason) : "") + " (par " + user.name + ")";
    const { error } = await db.from("tasks").update({
      recipient_name: np.name, recipient_id: np.id, department: np.dept || "",
      status: "À faire", progress: 0, close_date: null, comment: "", chef_comment: note,
    }).eq("id", taskId);
    if (error) return { success: false, error: error.message };
    if (np.name !== user.name)
      notify("task_assigned", { recipient: np.name, taskId, description: t.description, dateLimit: t.date_limit });
    return { success: true, oldRecipient: t.recipient_name, newRecipient: np.name };
  },

  async returnTask(_t, taskId, newRecipientName, reason) {
    if (!norm(reason)) return { success: false, error: "Vous devez indiquer un motif." };
    if (!norm(newRecipientName)) return { success: false, error: "Désignez une personne à qui transférer." };
    const t = await loadTaskRow(taskId);
    if (!t) return { success: false, error: "Tâche introuvable." };
    if (user.role !== "chef" && t.recipient_name !== user.name)
      return { success: false, error: "Seul le destinataire actuel ou le Chef Admin peut retourner cette tâche." };
    if (t.status === "Terminé") return { success: false, error: "Impossible de retourner une tâche terminée." };
    if (newRecipientName === t.recipient_name) return { success: false, error: "Vous ne pouvez pas retourner la tâche à vous-même." };
    const np = await personByName(newRecipientName);
    if (!np) return { success: false, error: "Personne introuvable : " + newRecipientName };
    const note = "↩️ Retournée par " + user.name + " vers " + np.name + " — Motif : " + norm(reason);
    const { error } = await db.from("tasks").update({
      recipient_name: np.name, recipient_id: np.id, department: np.dept || "",
      status: "À faire", progress: 0, close_date: null, comment: "", chef_comment: note,
    }).eq("id", taskId);
    if (error) return { success: false, error: error.message };
    if (np.name !== user.name)
      notify("task_assigned", { recipient: np.name, taskId, description: t.description, dateLimit: t.date_limit });
    return { success: true, previousRecipient: t.recipient_name, newRecipient: np.name };
  },

  async rejectTask(_t, taskId, reason) {
    if (!norm(reason)) return { success: false, error: "Veuillez indiquer le motif du renvoi." };
    const t = await loadTaskRow(taskId);
    if (!t) return { success: false, error: "Tâche introuvable." };
    if (user.role !== "chef" && t.assigned_by_name !== user.name)
      return { success: false, error: "Seul l'assigneur ou le Chef Admin peut renvoyer cette tâche." };
    if (t.status !== "Terminé") return { success: false, error: "Seule une tâche « Terminé » peut être renvoyée." };
    const { error } = await db.from("tasks").update({
      status: "À faire", progress: 0, close_date: null,
      chef_comment: "🔄 RENVOYÉE par " + user.name + " : " + norm(reason),
    }).eq("id", taskId);
    if (error) return { success: false, error: error.message };
    notify("task_returned", { recipient: t.recipient_name, taskId, reason: norm(reason) });
    return { success: true };
  },

  async deleteTask(_t, taskId) {
    const t = await loadTaskRow(taskId);
    if (!t) return { success: false, error: "Tâche introuvable." };
    if (user.role !== "chef" && t.assigned_by_name !== user.name)
      return { success: false, error: "Vous n'avez pas le droit de supprimer cette tâche." };
    const { error } = await db.from("tasks").delete().eq("id", taskId); // cascade : membres/messages/PJ
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  async updateTaskReportLink(_t, taskId, reportLink) {
    const link = norm(reportLink);
    if (link && !/^https?:\/\//i.test(link))
      return { success: false, error: "Le lien doit commencer par http:// ou https://" };
    const t = await loadTaskRow(taskId);
    if (!t) return { success: false, error: "Tâche introuvable." };
    if (user.role !== "chef" && t.recipient_name !== user.name)
      return { success: false, error: "Seul le destinataire ou le Chef Admin peut modifier le lien rapport." };
    const { error } = await db.from("tasks").update({ report_link: link }).eq("id", taskId);
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  // ── Messagerie (chat de tâche) ─────────────────────────────────────
  async getTaskMessages(_t, taskId) {
    const t = await loadTaskRow(taskId);
    if (!t) return { success: false, error: "Tâche introuvable." };
    const groupId = norm(t.group_id);
    let q = db.from("messages").select("*");
    q = groupId ? q.or(`task_id.eq.${taskId},group_id.eq.${groupId}`) : q.eq("task_id", taskId);
    const { data, error } = await q;
    if (error) return { success: false, error: error.message };
    const messages = (data || []).map((m) => ({
      id: m.id, taskId: m.task_id, groupId: m.group_id || "",
      date: fmtDateTime(m.created_at), author: m.author_name || "",
      email: m.author_email || "", message: m.body || "",
    })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { success: true, messages, groupId };
  },

  async postTaskMessage(_t, taskId, messageText) {
    const text = norm(messageText);
    if (!text) return { success: false, error: "Message vide." };
    if (text.length > 2000) return { success: false, error: "Message trop long (max 2000 caractères)." };
    const t = await loadTaskRow(taskId);
    if (!t) return { success: false, error: "Tâche introuvable." };
    const groupId = norm(t.group_id);
    const now = new Date().toISOString();
    const { data, error } = await db.from("messages").insert({
      task_id: taskId, group_id: groupId, author_name: user.name,
      author_email: user.email, body: text, created_at: now,
    }).select("id").single();
    if (error) return { success: false, error: error.message };
    return {
      success: true,
      message: { id: data.id, taskId, groupId, date: fmtDateTime(now), author: user.name, email: user.email, message: text },
    };
  },

  async deleteTaskMessage(_t, messageId) {
    const { data } = await db.from("messages").select("author_name").eq("id", messageId).limit(1);
    const m = data && data[0];
    if (!m) return { success: false, error: "Message introuvable." };
    if (user.role !== "chef" && m.author_name !== user.name)
      return { success: false, error: "Seul l'auteur ou le Chef Admin peut supprimer ce message." };
    const { error } = await db.from("messages").delete().eq("id", messageId);
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  // ── Objectifs ──────────────────────────────────────────────────────
  async getObjectifs() {
    const { data, error } = await db.from("objectives").select("*"); // RLS = visibilité
    if (error) return { success: false, error: error.message };
    const me = user.name, role = user.role, dept = (user.dept || "").toLowerCase();
    const objectifs = (data || []).map((o) => {
      const obj = {
        id: o.id, type: o.type || "perso", target: o.target || "", author: o.author_name || "",
        title: o.title || "", description: o.description || "",
        dateStart: o.date_start || "", dateEnd: o.date_end || "",
        progress: Number(o.progress || 0), status: o.status || "En cours", comment: o.comment || "",
        canEdit: false,
      };
      if (role === "chef") obj.canEdit = true;
      else if (obj.type === "perso" && obj.target === me) obj.canEdit = true;
      else if (obj.author === me) obj.canEdit = true;
      else if ((role === "dir" || role === "dept_head") && obj.type === "dept" && obj.target.toLowerCase() === dept) obj.canEdit = true;
      return obj;
    });
    return { success: true, objectifs, user };
  },

  async addObjectif(_t, payload) {
    if (!payload || !payload.title || !payload.dateStart || !payload.dateEnd)
      return { success: false, error: "Titre, date début et date fin obligatoires." };
    const type = payload.type === "dept" ? "dept" : "perso";
    const target = norm(payload.target);
    if (!target) return { success: false, error: "Cible (employé ou département) obligatoire." };
    // Règles métier (la RLS borne déjà, on reproduit les messages clairs)
    if (type === "perso" && target !== user.name) {
      if (user.role === "emp") return { success: false, error: "Vous ne pouvez créer un objectif que pour vous-même." };
      if (user.role === "dir" || user.role === "dept_head") {
        const p = await personByName(target);
        if (!p) return { success: false, error: "Personne introuvable." };
        if ((p.dept || "").toLowerCase() !== (user.dept || "").toLowerCase())
          return { success: false, error: "Uniquement pour un membre de votre département." };
      }
    } else if (type === "dept") {
      if (user.role === "emp") return { success: false, error: "Vous ne pouvez pas créer d'objectif de département." };
      if ((user.role === "dir" || user.role === "dept_head") && target.toLowerCase() !== (user.dept || "").toLowerCase())
        return { success: false, error: "Uniquement pour votre propre département." };
    }
    if (new Date(payload.dateEnd) < new Date(payload.dateStart))
      return { success: false, error: "La date de fin doit être après la date de début." };
    const id = await nextSeqId("objectives", "O", 3);
    const { error } = await db.from("objectives").insert({
      id, type, target, author_name: user.name, title: norm(payload.title),
      description: norm(payload.description), date_start: payload.dateStart, date_end: payload.dateEnd,
      progress: Number(payload.progress || 0), status: norm(payload.status) || "En cours", comment: norm(payload.comment),
    });
    if (error) return { success: false, error: error.message };
    return { success: true, id };
  },

  async updateObjectif(_t, payload) {
    if (!payload || !payload.id) return { success: false, error: "ID manquant." };
    const patch = {};
    if ("title" in payload) patch.title = String(payload.title);
    if ("description" in payload) patch.description = String(payload.description);
    if ("dateStart" in payload && payload.dateStart) patch.date_start = payload.dateStart;
    if ("dateEnd" in payload && payload.dateEnd) patch.date_end = payload.dateEnd;
    if ("progress" in payload) patch.progress = Math.max(0, Math.min(100, Number(payload.progress) || 0));
    if ("status" in payload) patch.status = String(payload.status);
    if ("comment" in payload) patch.comment = String(payload.comment);
    const { error } = await db.from("objectives").update(patch).eq("id", payload.id);
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  async deleteObjectif(_t, objId) {
    const { error } = await db.from("objectives").delete().eq("id", objId);
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  async getObjectifComments(_t, objId) {
    const { data, error } = await db.from("objective_comments").select("*").eq("objective_id", objId);
    if (error) return { success: false, error: error.message };
    const comments = (data || []).map((c) => ({
      id: c.id, objId: c.objective_id, date: fmtDateTime(c.created_at),
      author: c.author_name || "", email: c.author_email || "", comment: c.body || "",
    })).sort((a, b) => (a.date < b.date ? -1 : 1));
    return { success: true, comments };
  },

  async postObjectifComment(_t, objId, commentText) {
    const text = norm(commentText);
    if (!text) return { success: false, error: "Commentaire vide." };
    if (text.length > 2000) return { success: false, error: "Commentaire trop long (max 2000)." };
    const id = "OC" + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    const now = new Date().toISOString();
    const { error } = await db.from("objective_comments").insert({
      id, objective_id: objId, author_name: user.name, author_email: user.email, body: text, created_at: now,
    });
    if (error) return { success: false, error: error.message };
    return { success: true, comment: { id, objId, date: fmtDateTime(now), author: user.name, email: user.email, comment: text } };
  },

  async deleteObjectifComment(_t, commentId) {
    const { data } = await db.from("objective_comments").select("author_name").eq("id", commentId).limit(1);
    const c = data && data[0];
    if (!c) return { success: false, error: "Introuvable." };
    if (user.role !== "chef" && c.author_name !== user.name)
      return { success: false, error: "Seul l'auteur ou l'Admin peut supprimer." };
    const { error } = await db.from("objective_comments").delete().eq("id", commentId);
    if (error) return { success: false, error: error.message };
    return { success: true };
  },
};

// ── Routine journalière : helpers ────────────────────────────────────
async function holidaysMap() {
  const { data } = await db.from("holidays").select("holiday_date,label");
  const map = {};
  (data || []).forEach((h) => { const d = String(h.holiday_date).slice(0, 10); if (d) map[d] = h.label || "Férié"; });
  return map;
}
function isWorkingDay(ymd, dow, holidays) { return dow !== 0 && !holidays[ymd]; }
function eachDay(from, to, cb) {
  let d = new Date(from + "T12:00:00");
  const end = new Date(to + "T12:00:00");
  while (d <= end) {
    const ymd = d.toISOString().slice(0, 10);
    cb(ymd, d.getDay());
    d.setDate(d.getDate() + 1);
  }
}
async function dailyScopeNames() {
  const all = await loadPersonnel();
  const active = all.filter((p) => (p.status || "").toLowerCase() !== "inactif");
  const role = user.role, dept = (user.dept || "").toLowerCase();
  if (role === "chef" || role === "rh") return active;
  if (role === "dir" || role === "dept_head") return active.filter((p) => (p.dept || "").toLowerCase() === dept);
  return active.filter((p) => p.name === user.name);
}

Object.assign(handlers, {
  async getDailyTasks(_t, dateStr, forEmployee) {
    const employee = (forEmployee && String(forEmployee).trim()) || user.name;
    const date = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : todayISO();
    const { data: defs, error } = await db.from("daily_tasks").select("*")
      .eq("employee_name", employee).eq("active", true)
      .order("sort_order", { ascending: true }).order("label", { ascending: true });
    if (error) return { success: false, error: error.message };
    const ids = (defs || []).map((d) => d.id);
    const logState = {};
    if (ids.length) {
      const { data: logs } = await db.from("daily_log").select("*")
        .eq("employee_name", employee).eq("log_date", date).in("daily_task_id", ids);
      (logs || []).forEach((l) => { logState[l.daily_task_id] = { done: !!l.done, checkedAt: fmtDateTime(l.checked_at), note: l.note || "" }; });
    }
    const tasks = (defs || []).map((d) => {
      const st = logState[d.id] || {};
      return { id: d.id, label: d.label, description: d.description || "", order: d.sort_order || 0,
        done: !!st.done, checkedAt: st.checkedAt || "", note: st.note || "" };
    });
    return { success: true, date, employee, canManage: true, isSelf: employee === user.name, tasks, user };
  },

  async addDailyTask(_t, payload) {
    if (!payload || !norm(payload.label)) return { success: false, error: "Le libellé est obligatoire." };
    const employee = (payload.employee && String(payload.employee).trim()) || user.name;
    const { data: existing } = await db.from("daily_tasks").select("sort_order").eq("employee_name", employee).eq("active", true);
    const maxOrder = (existing || []).reduce((m, r) => Math.max(m, Number(r.sort_order || 0)), 0);
    const emp = await personByName(employee);
    const id = await nextSeqId("daily_tasks", "D", 3);
    const { error } = await db.from("daily_tasks").insert({
      id, employee_name: employee, employee_id: emp ? emp.id : null,
      label: norm(payload.label), description: norm(payload.description),
      sort_order: maxOrder + 1, active: true, author_name: user.name,
    });
    if (error) return { success: false, error: error.message };
    return { success: true, id };
  },

  async updateDailyTask(_t, payload) {
    if (!payload || !payload.id) return { success: false, error: "ID manquant." };
    const patch = { updated_at: new Date().toISOString() };
    if ("label" in payload) { if (!norm(payload.label)) return { success: false, error: "Le libellé ne peut pas être vide." }; patch.label = norm(payload.label); }
    if ("description" in payload) patch.description = norm(payload.description);
    if ("order" in payload) patch.sort_order = Number(payload.order) || 0;
    const { error } = await db.from("daily_tasks").update(patch).eq("id", payload.id);
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  async setDailyTaskActive(_t, taskId, active) {
    const { error } = await db.from("daily_tasks").update({ active: active === true, updated_at: new Date().toISOString() }).eq("id", taskId);
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  async toggleDailyCheck(_t, taskId, done, note) {
    const { data: defs } = await db.from("daily_tasks").select("employee_name").eq("id", taskId).limit(1);
    const def = defs && defs[0];
    if (!def) return { success: false, error: "Tâche journalière introuvable." };
    const date = todayISO();
    const isDone = done === true;
    const row = {
      id: taskId + "@" + date, daily_task_id: taskId, employee_name: def.employee_name,
      log_date: date, done: isDone, checked_at: new Date().toISOString(),
    };
    if (note != null) row.note = String(note);
    const { error } = await db.from("daily_log").upsert(row, { onConflict: "daily_task_id,log_date" });
    if (error) return { success: false, error: error.message };
    return { success: true, date, done: isDone };
  },

  async getDailyCompliance(_t, fromStr, toStr) {
    const today = todayISO();
    const from = fromStr && /^\d{4}-\d{2}-\d{2}$/.test(fromStr) ? fromStr : today;
    const to = toStr && /^\d{4}-\d{2}-\d{2}$/.test(toStr) ? toStr : today;
    const holidays = await holidaysMap();
    let workingDays = 0;
    eachDay(from, to, (ymd, dow) => { if (isWorkingDay(ymd, dow, holidays)) workingDays++; });

    const scope = await dailyScopeNames();
    const scopeNames = {};
    scope.forEach((p) => (scopeNames[p.name] = { name: p.name, dept: p.dept || "" }));

    const { data: defs } = await db.from("daily_tasks").select("id,employee_name,active").eq("active", true);
    const activeByEmp = {}, activeIds = {};
    (defs || []).forEach((d) => { if (scopeNames[d.employee_name]) { activeByEmp[d.employee_name] = (activeByEmp[d.employee_name] || 0) + 1; activeIds[d.id] = true; } });

    const { data: logs } = await db.from("daily_log").select("daily_task_id,employee_name,log_date,done").gte("log_date", from).lte("log_date", to);
    const doneInRange = {}, doneToday = {};
    (logs || []).forEach((l) => {
      if (!activeIds[l.daily_task_id] || !scopeNames[l.employee_name] || !l.done) return;
      const d = String(l.log_date).slice(0, 10);
      if (d === today) doneToday[l.employee_name] = (doneToday[l.employee_name] || 0) + 1;
      const dow = new Date(d + "T12:00:00").getDay();
      if (isWorkingDay(d, dow, holidays)) doneInRange[l.employee_name] = (doneInRange[l.employee_name] || 0) + 1;
    });

    const rows = Object.keys(scopeNames).map((name) => {
      const active = activeByEmp[name] || 0;
      const dToday = Math.min(doneToday[name] || 0, active || (doneToday[name] || 0));
      const expectedRange = active * workingDays;
      const dRange = Math.min(doneInRange[name] || 0, expectedRange || (doneInRange[name] || 0));
      return { name, dept: scopeNames[name].dept, activeCount: active, doneToday: dToday,
        rateToday: active ? Math.min(100, Math.round(dToday * 100 / active)) : null,
        donePeriod: dRange, expectedPeriod: expectedRange,
        ratePeriod: expectedRange ? Math.min(100, Math.round(dRange * 100 / expectedRange)) : null };
    }).sort((a, b) => (a.dept || "").localeCompare(b.dept || "") || a.name.localeCompare(b.name));
    return { success: true, today, from, to, workingDays, rows, user };
  },

  async getDailyDetail(_t, employee, fromStr, toStr) {
    const emp = norm(employee);
    if (!emp) return { success: false, error: "Accès refusé à ce détail." };
    const today = todayISO();
    const from = fromStr && /^\d{4}-\d{2}-\d{2}$/.test(fromStr) ? fromStr : today;
    const to = toStr && /^\d{4}-\d{2}-\d{2}$/.test(toStr) ? toStr : today;
    const holidays = await holidaysMap();
    const { data: defsRaw } = await db.from("daily_tasks").select("*").eq("employee_name", emp).eq("active", true)
      .order("sort_order", { ascending: true }).order("label", { ascending: true });
    const defs = defsRaw || [];
    const activeCount = defs.length;
    const idToLabel = {}; defs.forEach((d) => (idToLabel[d.id] = d.label));

    const { data: logs } = await db.from("daily_log").select("daily_task_id,employee_name,log_date,done")
      .eq("employee_name", emp).gte("log_date", from).lte("log_date", to);
    const doneByDate = {};
    (logs || []).forEach((l) => {
      if (!idToLabel[l.daily_task_id] || !l.done) return;
      const d = String(l.log_date).slice(0, 10);
      (doneByDate[d] = doneByDate[d] || {})[l.daily_task_id] = true;
    });

    const weekdays = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
    const days = []; let totalExpected = 0, totalDone = 0;
    eachDay(from, to, (ymd, dow) => {
      const working = isWorkingDay(ymd, dow, holidays);
      const doneSet = doneByDate[ymd] || {};
      const doneCount = Object.keys(doneSet).length;
      if (working) { totalExpected += activeCount; totalDone += Math.min(doneCount, activeCount); }
      days.push({ date: ymd, weekday: weekdays[dow],
        type: dow === 0 ? "sunday" : (holidays[ymd] ? "holiday" : "work"),
        holidayName: holidays[ymd] || "", isToday: ymd === today,
        doneCount, total: activeCount, doneIds: Object.keys(doneSet) });
    });
    days.reverse();
    const rate = totalExpected ? Math.min(100, Math.round(totalDone * 100 / totalExpected)) : null;
    return { success: true, employee: emp, from, to, activeCount,
      tasks: defs.map((d) => ({ id: d.id, label: d.label })), days, totalDone, totalExpected, rate, user };
  },
});

// ── Salaire : helpers ────────────────────────────────────────────────
function salaryStatusKey(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("autoris")) return "autorise";
  if (s.includes("approuv")) return "approuve";
  if (s.includes("valid")) return "valide";
  if (s.includes("rejet")) return "rejete";
  if (s.includes("demand")) return "demande";
  return "none";
}
function salaryStatusLabel(key) {
  return { none: "—", demande: "⏳ En attente de validation (DF)", valide: "⏳ En attente d'approbation (GE)",
    approuve: "⏳ En attente d'autorisation (PAU)", autorise: "✅ Autorisé", rejete: "❌ Rejeté" }[key] || "—";
}
function salaryAuthObj(r) {
  return { id: r.id, person: r.person, periode: r.periode || "", montant: r.montant || "", status: r.status || "",
    requestedBy: r.requested_by || "", requestedAt: (r.requested_at || "").slice(0, 10),
    validatedBy: r.validated_by || "", approvedBy: r.approved_by || "", authorizedBy: r.authorized_by || "",
    rejectedBy: r.rejected_by || "", rejectReason: r.reject_reason || "", note: r.note || "" };
}
const accessLinkFor = (token) => `${location.origin}/?token=${encodeURIComponent(token)}`;
const randomToken = () => {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let t = ""; for (let i = 0; i < 32; i++) t += a[Math.floor(Math.random() * a.length)];
  return t;
};

Object.assign(handlers, {
  // ── Autorisation salaire ────────────────────────────────────────────
  async getSalaryAuthorizations() {
    const viewerFn = user.salaryRole;
    const isAdmin = user.role === "chef";
    if (!viewerFn && !isAdmin)
      return { success: false, error: "Accès refusé : onglet réservé à la RH, au DF, à la GE, à la PAU et aux administrateurs." };
    const [{ data: auths }, { data: ext }, personnel] = await Promise.all([
      db.from("salary_authorizations").select("*"),
      db.from("salary_external_beneficiaries").select("*").eq("active", true),
      loadPersonnel(),
    ]);
    const latest = {};
    (auths || []).forEach((a) => { latest[a.person] = a; }); // dernière occurrence
    const internal = personnel.filter((p) => (p.status || "").toLowerCase() !== "inactif")
      .map((p) => ({ person: p.name, dept: p.dept || "", fonction: p.role || "", isExternal: false }));
    const external = (ext || []).map((b) => ({ person: b.name, dept: b.structure || "", fonction: b.structure || "Externe", isExternal: true }));
    const rows = internal.concat(external).map((p) => {
      const a = latest[p.person] || null;
      const key = a ? salaryStatusKey(a.status) : "none";
      let myAction = null;
      if (viewerFn === "rh") { if (!a || key === "autorise" || key === "rejete") myAction = "demander"; }
      else if (viewerFn === "df" && key === "demande") myAction = "valider";
      else if (viewerFn === "ge" && key === "valide") myAction = "approuver";
      else if (viewerFn === "pau" && key === "approuve") myAction = "autoriser";
      return { person: p.person, dept: p.dept, fonction: p.fonction, isExternal: p.isExternal,
        auth: a ? salaryAuthObj(a) : null, statusKey: key, statusLabel: salaryStatusLabel(key), myAction };
    });
    return { success: true, user, viewerFunction: viewerFn, isAdmin, rows };
  },

  async createSalaryRequest(_t, payload) {
    if (user.salaryRole !== "rh") return { success: false, error: "Seule la DA-RH peut initier une demande." };
    const person = norm(payload && payload.person);
    if (!person) return { success: false, error: "Personne obligatoire." };
    const isInternal = !!(await personByName(person));
    const { data: ext } = await db.from("salary_external_beneficiaries").select("name").eq("active", true).eq("name", person);
    if (!isInternal && !(ext && ext.length))
      return { success: false, error: "Bénéficiaire introuvable (ni personnel, ni externe enregistré)." };
    const { data: cur } = await db.from("salary_authorizations").select("status").eq("person", person);
    const last = cur && cur.length ? cur[cur.length - 1] : null;
    if (last) { const k = salaryStatusKey(last.status); if (k !== "autorise" && k !== "rejete" && k !== "none")
      return { success: false, error: "Une demande est déjà en cours pour " + person + " (" + salaryStatusLabel(k) + ")." }; }
    const id = "SAL-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
    const { error } = await db.from("salary_authorizations").insert({
      id, person, periode: norm(payload.periode), montant: norm(payload.montant), status: "Demandé",
      requested_by: user.name, requested_at: new Date().toISOString(), note: norm(payload.note),
    });
    if (error) return { success: false, error: error.message };
    notify("salary_stage", { target: "df", person, periode: norm(payload.periode), montant: norm(payload.montant) });
    return { success: true, id };
  },

  async actOnSalaryAuthorization(_t, authId, action, note) {
    const fn = user.salaryRole;
    const act = String(action || "").trim().toLowerCase();
    const { data } = await db.from("salary_authorizations").select("*").eq("id", authId).limit(1);
    const obj = data && data[0];
    if (!obj) return { success: false, error: "Demande introuvable." };
    const key = salaryStatusKey(obj.status);
    const now = new Date().toISOString();
    const reason = norm(note);
    const patch = {};
    if (act === "rejeter") {
      const stepActor = { demande: "df", valide: "ge", approuve: "pau" }[key];
      if (!fn || fn !== stepActor) return { success: false, error: "Vous ne pouvez pas rejeter à cette étape." };
      if (!reason) return { success: false, error: "Motif de rejet obligatoire." };
      Object.assign(patch, { status: "Rejeté", rejected_by: user.name, rejected_at: now, reject_reason: reason });
    } else if (act === "valider") {
      if (fn !== "df") return { success: false, error: "Seul le DF peut valider." };
      if (key !== "demande") return { success: false, error: "Pas en attente de validation." };
      Object.assign(patch, { status: "Validé", validated_by: user.name, validated_at: now });
    } else if (act === "approuver") {
      if (fn !== "ge") return { success: false, error: "Seule la GE peut approuver." };
      if (key !== "valide") return { success: false, error: "Pas en attente d'approbation." };
      Object.assign(patch, { status: "Approuvé", approved_by: user.name, approved_at: now });
    } else if (act === "autoriser") {
      if (fn !== "pau") return { success: false, error: "Seule la PAU peut autoriser." };
      if (key !== "approuve") return { success: false, error: "Pas en attente d'autorisation." };
      Object.assign(patch, { status: "Autorisé", authorized_by: user.name, authorized_at: now });
    } else return { success: false, error: "Action inconnue." };
    const { error } = await db.from("salary_authorizations").update(patch).eq("id", authId);
    if (error) return { success: false, error: error.message };
    if (act === "rejeter") notify("salary_reject", { person: obj.person, reason });
    else if (act === "valider") notify("salary_stage", { target: "ge", person: obj.person, periode: obj.periode, montant: obj.montant });
    else if (act === "approuver") notify("salary_stage", { target: "pau", person: obj.person, periode: obj.periode, montant: obj.montant });
    else if (act === "autoriser") notify("salary_final", { person: obj.person });
    return { success: true };
  },

  async addExternalBeneficiary(_t, payload) {
    if (user.salaryRole !== "rh") return { success: false, error: "Seule la DA-RH peut enregistrer un bénéficiaire externe." };
    const name = norm(payload && payload.name);
    if (!name) return { success: false, error: "Le nom du bénéficiaire est obligatoire." };
    if (await personByName(name)) return { success: false, error: "Cette personne existe déjà dans le personnel." };
    const { data: ex } = await db.from("salary_external_beneficiaries").select("id").eq("active", true).ilike("name", name);
    if (ex && ex.length) return { success: false, error: "Ce bénéficiaire externe est déjà enregistré." };
    const { error } = await db.from("salary_external_beneficiaries").insert({
      name, structure: norm(payload.structure), email: norm(payload.email), note: norm(payload.note),
      added_by: user.name, active: true,
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  async removeExternalBeneficiary(_t, name) {
    if (user.salaryRole !== "rh") return { success: false, error: "Seule la DA-RH peut retirer un bénéficiaire externe." };
    const target = norm(name);
    const { data: cur } = await db.from("salary_authorizations").select("status").eq("person", target);
    const last = cur && cur.length ? cur[cur.length - 1] : null;
    if (last) { const k = salaryStatusKey(last.status); if (k !== "autorise" && k !== "rejete" && k !== "none")
      return { success: false, error: "Impossible : une demande est en cours pour " + target + "." }; }
    const { error } = await db.from("salary_external_beneficiaries").update({ active: false }).eq("name", target);
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  // ── Archives ────────────────────────────────────────────────────────
  async getArchivedTasks(_t, searchTerm) {
    const { data, error } = await db.from("tasks").select("*").eq("archived", true);
    if (error) return { success: false, error: error.message };
    let all = (data || []).map(mapTask);
    const q = norm(searchTerm).toLowerCase();
    if (q) all = all.filter((t) =>
      t.id.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) ||
      t.recipient.toLowerCase().includes(q) || t.assignedByName.toLowerCase().includes(q));
    all.sort((a, b) => (a.closeDate < b.closeDate ? 1 : -1));
    const total = all.length, truncated = total > 300;
    return { success: true, tasks: all.slice(0, 300), total, truncated, user };
  },

  // ── Personnel (gestion) ─────────────────────────────────────────────
  async addEmployee(_t, payload) {
    if (user.role !== "chef" && user.role !== "rh") return { success: false, error: "Seuls le Chef et la RH peuvent ajouter des employés." };
    if (!payload || !payload.name || !payload.email || !payload.role) return { success: false, error: "Champs requis : nom, email, rôle." };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email)) return { success: false, error: "Format email invalide." };
    const roleNorm = normalizeRoleJs(payload.role);
    if (user.role === "rh" && roleNorm === "chef") return { success: false, error: "La RH ne peut pas créer un compte Chef." };
    const { data: dup } = await db.from("personnel").select("id").ilike("email", norm(payload.email));
    if (dup && dup.length) return { success: false, error: "Cet email est déjà utilisé." };
    const { data: ins, error } = await db.from("personnel").insert({
      name: norm(payload.name), email: norm(payload.email).toLowerCase(), dept: norm(payload.dept),
      position: norm(payload.position), role_raw: norm(payload.role), status: norm(payload.status) || "Actif",
      start_date: payload.startDate || todayISO(),
    }).select("id").single();
    if (error) return { success: false, error: error.message };
    const token = randomToken();
    const { error: eA } = await db.from("personnel_auth").insert({ person_id: ins.id, token });
    if (eA) return { success: false, error: "Employé créé mais lien d'accès non généré : " + eA.message };
    notify("welcome", { email: norm(payload.email).toLowerCase(), name: norm(payload.name), token });
    return { success: true, token, accessLink: accessLinkFor(token), normalizedDept: norm(payload.dept) };
  },

  async updateEmployee(_t, payload) {
    if (user.role !== "chef" && user.role !== "rh") return { success: false, error: "Droits insuffisants." };
    if (!payload || !payload.rowIndex) return { success: false, error: "Identifiant manquant." };
    if (user.role === "rh" && payload.role && normalizeRoleJs(payload.role) === "chef")
      return { success: false, error: "La RH ne peut pas créer ou promouvoir un Chef." };
    const patch = {};
    if ("role" in payload) patch.role_raw = norm(payload.role);
    if ("name" in payload) patch.name = norm(payload.name);
    if ("dept" in payload) patch.dept = norm(payload.dept);
    if ("position" in payload) patch.position = norm(payload.position);
    if ("email" in payload) patch.email = norm(payload.email).toLowerCase();
    if ("startDate" in payload) patch.start_date = payload.startDate || null;
    if ("status" in payload) patch.status = norm(payload.status);
    const { error } = await db.from("personnel").update(patch).eq("id", payload.rowIndex);
    if (error) return { success: false, error: error.message };
    return { success: true, normalizedDept: norm(payload.dept) };
  },

  async deactivateEmployee(_t, rowIndex) {
    if (user.role !== "chef" && user.role !== "rh") return { success: false, error: "Droits insuffisants." };
    const me = await meRow();
    if (me && me.id === rowIndex) return { success: false, error: "Vous ne pouvez pas vous désactiver vous-même." };
    const { error } = await db.from("personnel").update({ status: "Inactif" }).eq("id", rowIndex);
    if (error) return { success: false, error: error.message };
    await db.from("personnel_auth").delete().eq("person_id", rowIndex); // coupe l'accès
    return { success: true };
  },

  async regenerateAccessLink(_t, rowIndex) {
    if (user.role !== "chef" && user.role !== "rh") return { success: false, error: "Droits insuffisants." };
    const token = randomToken();
    // ⚠ pas d'upsert : personnel_auth n'a aucune policy SELECT (tokens jamais lisibles
    // côté navigateur), or ON CONFLICT DO UPDATE a besoin de "voir" la ligne existante →
    // Postgres refuse avec "new row violates row-level security policy". On met donc à
    // jour la ligne existante si elle existe (count exact, sans avoir besoin de SELECT),
    // sinon on l'insère — jamais les deux à la fois, donc jamais de conflit de clé.
    const { error: eU, count } = await db
      .from("personnel_auth")
      .update({ token }, { count: "exact" })
      .eq("person_id", rowIndex);
    if (eU) return { success: false, error: eU.message };
    if (!count) {
      const { error: eI } = await db.from("personnel_auth").insert({ person_id: rowIndex, token });
      if (eI) return { success: false, error: eI.message };
    }
    const { data: pr } = await db.from("personnel").select("name,email").eq("id", rowIndex).limit(1);
    if (pr && pr[0]) notify("access_link", { email: pr[0].email, name: pr[0].name, token });
    return { success: true, token, accessLink: accessLinkFor(token) };
  },

  // ✨ v7.0 : renvoie par e-mail le lien EXISTANT, sans toucher au token — c'est le
  // cas courant (« j'ai perdu mon lien »). regenerateAccessLink reste réservé au cas
  // où le lien doit être révoqué, puisqu'il invalide celui déjà en circulation.
  async resendAccessLink(_t, rowIndex) {
    if (user.role !== "chef" && user.role !== "rh") return { success: false, error: "Droits insuffisants." };
    const { data: pr, error: eP } = await db.from("personnel").select("name,email").eq("id", rowIndex).limit(1);
    if (eP) return { success: false, error: eP.message };
    if (!pr || !pr[0]) return { success: false, error: "Personne introuvable." };
    const { data: au, error: eA } = await db.from("personnel_auth").select("token").eq("person_id", rowIndex).limit(1);
    if (eA) return { success: false, error: eA.message };
    const token = au && au[0] && au[0].token;
    if (!token) return { success: false, error: "Aucun lien actif : utilisez « Générer un nouveau lien »." };
    notify("access_link", { email: pr[0].email, name: pr[0].name, token });
    return { success: true, token, accessLink: accessLinkFor(token), email: pr[0].email };
  },
});

// UUID v4. crypto.randomUUID() exige un contexte sécurisé (https ou localhost) —
// le repli couvre les navigateurs plus anciens et les accès en http.
function newUuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// ── Pièces jointes (Supabase Storage) ────────────────────────────────
function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

Object.assign(handlers, {
  async getAttachmentsForTask(_t, taskId) {
    const t = await loadTaskRow(taskId);
    const canManage = !!t && (user.role === "chef" || t.assigned_by_name === user.name || t.recipient_name === user.name);
    const { data, error } = await db.from("attachments").select("*").eq("task_id", taskId).order("created_at", { ascending: true });
    if (error) return { success: false, error: error.message };
    const attachments = (data || []).map((a) => ({
      id: a.id, taskId: a.task_id, name: a.name, url: a.url, mimeType: a.mime_type,
      size: Number(a.size || 0), uploadedBy: a.uploaded_by, date: (a.created_at || "").slice(0, 10),
    }));
    return { success: true, attachments, canManage };
  },

  async addAttachment(_t, taskId, payload) {
    const name = norm(payload && payload.name) || "fichier";
    const mime = norm(payload && payload.mimeType) || "application/octet-stream";
    const b64 = (payload && payload.dataBase64) || "";
    if (!b64) return { success: false, error: "Fichier vide." };
    let blob;
    try { blob = b64ToBlob(b64, mime); } catch (e) { return { success: false, error: "Fichier illisible." }; }
    const safe = name.replace(/[^\w.\-]+/g, "_");
    const path = `${taskId}/${Date.now()}-${Math.random().toString(36).slice(2)}-${safe}`;
    const { error: eUp } = await db.storage.from("attachments").upload(path, blob, { contentType: mime, upsert: false });
    if (eUp) return { success: false, error: eUp.message };
    const { data: pub } = db.storage.from("attachments").getPublicUrl(path);
    const { error } = await db.from("attachments").insert({
      task_id: taskId, name, storage_path: path, url: (pub && pub.publicUrl) || "",
      mime_type: mime, size: blob.size, uploaded_by: user.name,
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  async deleteAttachment(_t, attId) {
    const { data } = await db.from("attachments").select("*").eq("id", attId).limit(1);
    const a = data && data[0];
    if (!a) return { success: false, error: "Pièce jointe introuvable." };
    const t = await loadTaskRow(a.task_id);
    const canDel = user.role === "chef" || a.uploaded_by === user.name || (t && t.assigned_by_name === user.name);
    if (!canDel) return { success: false, error: "Suppression réservée au déposant, à l'assigneur ou au Chef." };
    if (a.storage_path) { try { await db.storage.from("attachments").remove([a.storage_path]); } catch (e) {} }
    const { error } = await db.from("attachments").delete().eq("id", attId);
    if (error) return { success: false, error: error.message };
    return { success: true };
  },
});

// ── Rapports (dépôt libre, visibilité = destinataires choisis par l'auteur) ─
Object.assign(handlers, {
  async getReports() {
    // RLS filtre déjà : auteur, destinataire choisi, ou Chef (supervision).
    const { data, error } = await db.from("reports").select("*").order("created_at", { ascending: false });
    if (error) return { success: false, error: error.message };
    const reports = data || [];
    const ids = reports.map((r) => r.id);
    let recipientsByReport = {};
    if (ids.length) {
      const { data: rr } = await db
        .from("report_recipients")
        .select("report_id, viewer_id, viewer:personnel!viewer_id(name)")
        .in("report_id", ids);
      (rr || []).forEach((x) => {
        (recipientsByReport[x.report_id] = recipientsByReport[x.report_id] || []).push(
          (x.viewer && x.viewer.name) || ""
        );
      });
    }
    return {
      success: true,
      reports: reports.map((r) => ({
        id: r.id, title: r.title, description: r.description || "",
        authorName: r.author_name,
        isMine: r.author_name === user.name,
        canDelete: r.author_name === user.name || user.role === "chef",
        fileName: r.file_name, mimeType: r.mime_type, size: Number(r.size || 0),
        createdAt: (r.created_at || "").slice(0, 10),
        recipients: recipientsByReport[r.id] || [],
      })),
    };
  },

  async createReport(_t, payload) {
    const title = norm(payload && payload.title);
    if (!title) return { success: false, error: "Titre requis." };
    const recipientIds = Array.isArray(payload && payload.recipientIds) ? payload.recipientIds.filter(Boolean) : [];
    if (!recipientIds.length) return { success: false, error: "Choisis au moins une personne autorisée à voir ce rapport." };
    const name = norm(payload && payload.fileName) || "fichier";
    const mime = norm(payload && payload.mimeType) || "application/octet-stream";
    const b64 = (payload && payload.dataBase64) || "";
    if (!b64) return { success: false, error: "Fichier vide." };
    let blob;
    try { blob = b64ToBlob(b64, mime); } catch (e) { return { success: false, error: "Fichier illisible." }; }

    const me = await meRow();
    // ⚠ Ne PAS faire `.insert(…).select()` ici : Postgres applique la policy SELECT
    // aux lignes renvoyées, et celle de `reports` s'appuie sur une fonction stable
    // qui relit la table — la ligne à peine insérée n'y est pas encore visible, et
    // toute l'insertion était rejetée (« new row violates row-level security
    // policy »). On génère donc l'id côté client : plus de RETURNING, et le chemin
    // de stockage est connu d'avance (une requête de moins).
    const id = newUuid();
    const safe = name.replace(/[^\w.\-]+/g, "_");
    const path = `${id}/${safe}`;
    const { error: eIns } = await db.from("reports").insert({
      id, title, description: norm(payload && payload.description),
      author_id: me && me.id, author_name: user.name,
      file_name: name, file_path: path, mime_type: mime, size: blob.size,
    });
    if (eIns) return { success: false, error: friendlyError(eIns, "Dépôt refusé : vous ne pouvez déposer un rapport qu'en votre nom.") };

    const { error: eUp } = await db.storage.from("reports").upload(path, blob, { contentType: mime, upsert: false });
    // Le fichier est le cœur du rapport : sans lui, on retire la ligne plutôt que
    // de laisser un rapport intéléchargeable dans la liste.
    if (eUp) { await db.from("reports").delete().eq("id", id); return { success: false, error: eUp.message }; }

    const rows = recipientIds.map((viewer_id) => ({ report_id: id, viewer_id }));
    const { error: eRec } = await db.from("report_recipients").insert(rows);
    if (eRec) return { success: false, error: "Rapport déposé mais destinataires non enregistrés : " + eRec.message };

    return { success: true };
  },

  async getReportDownloadUrl(_t, reportId) {
    const { data } = await db.from("reports").select("file_path").eq("id", reportId).limit(1);
    const r = data && data[0];
    if (!r || !r.file_path) return { success: false, error: "Rapport introuvable." };
    const { data: signed, error } = await db.storage.from("reports").createSignedUrl(r.file_path, 60);
    if (error) return { success: false, error: error.message };
    return { success: true, url: signed.signedUrl };
  },

  async deleteReport(_t, reportId) {
    const { data } = await db.from("reports").select("*").eq("id", reportId).limit(1);
    const r = data && data[0];
    if (!r) return { success: false, error: "Rapport introuvable." };
    if (r.author_name !== user.name && user.role !== "chef") {
      return { success: false, error: "Suppression réservée à l'auteur ou au Chef." };
    }
    if (r.file_path) { try { await db.storage.from("reports").remove([r.file_path]); } catch (e) {} }
    const { error } = await db.from("reports").delete().eq("id", reportId);
    if (error) return { success: false, error: error.message };
    return { success: true };
  },
});

// ── Innovation (boîte à idées : visible par tout le personnel) ────────
const INNOVATION_STATUSES = ["Nouvelle", "À l'étude", "Retenue", "Écartée"];

Object.assign(handlers, {
  async getInnovations() {
    // Pas de filtrage : la RLS ouvre la lecture à tous, c'est le principe du module.
    const { data, error } = await db.from("innovations").select("*").order("created_at", { ascending: false });
    if (error) return { success: false, error: error.message };
    const ideas = data || [];

    // Compteur de commentaires en une requête, plutôt qu'une par idée.
    const counts = {};
    if (ideas.length) {
      const { data: cs } = await db
        .from("innovation_comments")
        .select("innovation_id")
        .in("innovation_id", ideas.map((i) => i.id));
      (cs || []).forEach((c) => { counts[c.innovation_id] = (counts[c.innovation_id] || 0) + 1; });
    }

    const isChef = user.role === "chef";
    return {
      success: true,
      canSetStatus: isChef,
      statuses: INNOVATION_STATUSES,
      innovations: ideas.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description || "",
        category: r.category || "",
        authorName: r.author_name || "",
        status: r.status || "Nouvelle",
        chefNote: r.chef_note || "",
        isMine: r.author_name === user.name,
        canEdit: r.author_name === user.name || isChef,
        canDelete: r.author_name === user.name || isChef,
        commentsCount: counts[r.id] || 0,
        createdAt: (r.created_at || "").slice(0, 10),
      })),
    };
  },

  async addInnovation(_t, payload) {
    const title = norm(payload && payload.title);
    const description = norm(payload && payload.description);
    if (!title) return { success: false, error: "Titre requis." };
    if (!description) return { success: false, error: "Décris ton idée." };
    const me = await meRow();
    const { error } = await db.from("innovations").insert({
      title, description, category: norm(payload && payload.category),
      author_id: me && me.id, author_name: user.name, status: "Nouvelle",
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  async updateInnovation(_t, payload) {
    const id = payload && payload.id;
    if (!id) return { success: false, error: "ID manquant." };
    const { data } = await db.from("innovations").select("*").eq("id", id).limit(1);
    const r = data && data[0];
    if (!r) return { success: false, error: "Idée introuvable." };

    const isChef = user.role === "chef";
    const isAuthor = r.author_name === user.name;
    if (!isChef && !isAuthor) return { success: false, error: "Modification réservée à l'auteur ou au Chef." };

    const patch = { updated_at: new Date().toISOString() };
    // L'auteur corrige le fond de son idée…
    if (isAuthor) {
      if ("title" in payload) {
        const title = norm(payload.title);
        if (!title) return { success: false, error: "Titre requis." };
        patch.title = title;
      }
      if ("description" in payload) patch.description = norm(payload.description);
      if ("category" in payload) patch.category = norm(payload.category);
    }
    // …mais seul le Chef arbitre le statut, même sur sa propre idée.
    if ("status" in payload) {
      if (!isChef) return { success: false, error: "Seul le Chef peut changer le statut d'une idée." };
      const status = norm(payload.status);
      if (INNOVATION_STATUSES.indexOf(status) === -1) return { success: false, error: "Statut invalide : " + status };
      patch.status = status;
    }
    if ("chefNote" in payload) {
      if (!isChef) return { success: false, error: "Seul le Chef peut laisser un avis." };
      patch.chef_note = norm(payload.chefNote);
    }

    const { error } = await db.from("innovations").update(patch).eq("id", id);
    if (error) return { success: false, error: error.message };

    // L'auteur est prévenu de l'arbitrage du Chef (jamais de son propre geste).
    if (patch.status && r.author_name !== user.name) {
      notify("innovation_status", {
        author: r.author_name, title: r.title,
        status: patch.status, note: norm(payload.chefNote || r.chef_note),
      });
    }
    return { success: true };
  },

  async deleteInnovation(_t, id) {
    const { data } = await db.from("innovations").select("author_name").eq("id", id).limit(1);
    const r = data && data[0];
    if (!r) return { success: false, error: "Idée introuvable." };
    if (r.author_name !== user.name && user.role !== "chef") {
      return { success: false, error: "Suppression réservée à l'auteur ou au Chef." };
    }
    const { error } = await db.from("innovations").delete().eq("id", id); // commentaires : ON DELETE CASCADE
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  async getInnovationComments(_t, innovationId) {
    const { data, error } = await db
      .from("innovation_comments").select("*")
      .eq("innovation_id", innovationId)
      .order("created_at", { ascending: true });
    if (error) return { success: false, error: error.message };
    return {
      success: true,
      comments: (data || []).map((c) => ({
        id: c.id, author: c.author_name || "", text: c.text || "",
        date: fmtDateTime(c.created_at),
        canDelete: c.author_name === user.name || user.role === "chef",
      })),
    };
  },

  async postInnovationComment(_t, innovationId, commentText) {
    const text = norm(commentText);
    if (!text) return { success: false, error: "Commentaire vide." };
    const me = await meRow();
    const { error } = await db.from("innovation_comments").insert({
      innovation_id: innovationId, author_id: me && me.id, author_name: user.name, text,
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  async deleteInnovationComment(_t, commentId) {
    const { error } = await db.from("innovation_comments").delete().eq("id", commentId);
    if (error) return { success: false, error: error.message };
    return { success: true };
  },
});

// Réplique JS de normalize_role (pour les contrôles côté client).
function normalizeRoleJs(roleStr) {
  const s = String(roleStr || "").toLowerCase().trim();
  if (s.indexOf("assistant") !== -1 && (s.indexOf("rh") !== -1 || s.indexOf("ressources humaines") !== -1)) return "emp";
  if (s === "pau" || s === "ge") return "chef";
  if (s === "df") return "dir";
  if (s.indexOf("da-rh") !== -1 || s.indexOf("responsable rh") !== -1 || s.indexOf("ressources humaines") !== -1) return "rh";
  if ((s.indexOf("chef") !== -1 && s.indexOf("directeur") !== -1) || s.indexOf("directeur général") !== -1 ||
      s === "dg" || s.indexOf("pdg") !== -1 || s.indexOf("chef administrateur") !== -1 || s.indexOf("administrateur") !== -1) return "chef";
  if (s.indexOf("chef de département") !== -1 || s.indexOf("chef de departement") !== -1 || s.indexOf("chef de division") !== -1) return "dept_head";
  if (s.indexOf("directeur") !== -1) return "dir";
  if (s === "rh") return "rh";
  return "emp";
}

// ID séquentiel « <prefix>### » généré côté base (immunisé RLS).
async function nextSeqId(table, prefix, pad) {
  const { data, error } = await db.rpc("next_id", { p_table: table, p_prefix: prefix, p_pad: pad });
  if (error) throw error;
  return data;
}

// ── Dispatcher appelé par le seam call() de l'UI legacy ──────────────
export async function call(fnName, ...args) {
  const h = handlers[fnName];
  if (!h) {
    console.warn("[api] fonction non encore migrée :", fnName);
    return { success: false, error: "Fonction non encore migrée : " + fnName };
  }
  try {
    return await h(...args);
  } catch (e) {
    console.error("[api] " + fnName, e);
    return { success: false, error: String((e && e.message) || e) };
  }
}
