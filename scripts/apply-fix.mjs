// ════════════════════════════════════════════════════════════════════
//  Applique le correctif RLS 0016 (tâches d'équipe + rapports) PUIS le vérifie
//  en créant réellement une tâche d'équipe avec un compte employé.
//
//  Prérequis : SUPABASE_ACCESS_TOKEN (token « sbp_… ») dans .secrets.local.
//  → https://supabase.com/dashboard/account/tokens  (révocable d'un clic ensuite)
//
//  Usage :  node scripts/apply-fix.mjs
// ════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const REF = "qbzvvnzeuxfxikjvxdyc";
const URL = `https://${REF}.supabase.co`;

function secret(k) {
  if (!fs.existsSync(".secrets.local")) return "";
  const l = fs.readFileSync(".secrets.local", "utf8").split(/\r?\n/).find((x) => x.startsWith(k + "="));
  return l ? l.slice(k.length + 1).trim().replace(/^["']|["']$/g, "") : "";
}
const TOKEN = secret("SUPABASE_ACCESS_TOKEN");
const SVC = secret("SUPABASE_SERVICE_ROLE_KEY");
const ANON = fs.readFileSync(".env", "utf8").split(/\r?\n/)
  .find((l) => l.startsWith("VITE_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();

if (!TOKEN) {
  console.error("❌ SUPABASE_ACCESS_TOKEN absent de .secrets.local.");
  console.error("   Générez-en un : https://supabase.com/dashboard/account/tokens");
  console.error("   puis ajoutez la ligne :  SUPABASE_ACCESS_TOKEN=sbp_………");
  process.exit(1);
}

// ── 1) Appliquer le SQL ──────────────────────────────────────────────
const sql = fs.readFileSync("supabase/migrations/0016_fix_rls_reports_team.sql", "utf8");
const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: "POST",
  headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
if (!r.ok) {
  const t = await r.text();
  console.error("❌ SQL refusé (HTTP " + r.status + ") :", t.slice(0, 300));
  if (r.status === 401) console.error("   → token invalide ou révoqué.");
  process.exit(1);
}
console.log("✅ Migration 0016 appliquée.");

// ── 2) Vérifier pour de vrai : un employé crée une tâche d'équipe ────
if (!SVC) { console.log("ℹ Clé service_role absente : vérification sautée."); process.exit(0); }
const admin = createClient(URL, SVC, { auth: { persistSession: false } });
const { data: ps } = await admin.from("personnel")
  .select("id,name,email,dept").eq("role_norm", "emp").eq("status", "Actif").limit(3);
const emp = ps[0];
const { data: au } = await admin.from("personnel_auth").select("token").eq("person_id", emp.id).maybeSingle();
const { data: auth } = await createClient(URL, ANON, { auth: { persistSession: false } })
  .functions.invoke("auth-token", { body: { token: au.token } });
const db = createClient(URL, ANON, { auth: { persistSession: false }, accessToken: async () => auth.jwt });

const { data: id } = await db.rpc("next_id", { p_table: "tasks", p_prefix: "T", p_pad: 3 });
const { data: gid } = await db.rpc("next_group_id");
const today = new Date().toISOString().slice(0, 10);
const { error: eT } = await db.from("tasks").insert({
  id, description: "__VERIF correctif équipe__", recipient_name: emp.name, recipient_id: emp.id,
  assigned_by_name: emp.name, assigned_by_id: emp.id, assigned_by_role: "Employé",
  department: emp.dept || "", priority: "Moyenne", status: "À faire", progress: 0,
  date_assigned: today, date_limit: today, group_id: gid,
});
const { error: eM } = eT ? {} : await db.from("team_members").insert(
  ps.slice(0, 2).map((m, i) => ({ group_id: gid, task_id: id, member_id: m.id, member_name: m.name,
    member_email: m.email || "", is_leader: i === 0, sub_status: "À faire", report_link: "" })));

console.log(`\nVérification avec « ${emp.name} » (employée, non-Chef) :`);
console.log("  création de la tâche :", eT ? "❌ " + eT.message : "✅");
console.log("  composition d'équipe :", eM ? "❌ " + eM.message : "✅");

// Ménage : la tâche de vérification ne doit pas rester dans l'application.
await admin.from("team_members").delete().eq("task_id", id);
await admin.from("tasks").delete().eq("id", id);
console.log("  (tâche de test supprimée)");
console.log(eT || eM ? "\n⚠ Le correctif n'a pas produit l'effet attendu." : "\n🎉 Les tâches d'équipe fonctionnent pour tout le monde.");
