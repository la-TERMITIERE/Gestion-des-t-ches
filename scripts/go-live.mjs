// ════════════════════════════════════════════════════════════════════
//  Mise en service v7.0 — orchestre ce qui demande des identifiants.
//
//  Lit les clés dans .secrets.local (gitignoré) et les passe aux sous-processus
//  par variables d'environnement : elles ne sont JAMAIS affichées ni journalisées.
//
//  Usage (depuis termitiere-web/) :
//    node scripts/go-live.mjs            → vérifie et SIMULE (n'écrit rien)
//    node scripts/go-live.mjs --write    → déploie la fonction notify + importe
//    node scripts/go-live.mjs --write --replace   → idem, en mode remplacement
//
//  Ne fait PAS : les migrations SQL (à coller — voir supabase/APPLY_V7.sql) ni le
//  déploiement du frontend (glisser-déposer Netlify — voir DEPLOY.md).
// ════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const PROJECT_REF = "qbzvvnzeuxfxikjvxdyc";
const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const REPLACE = argv.includes("--replace");

// ── Secrets ──────────────────────────────────────────────────────────
function readSecrets() {
  if (!fs.existsSync(".secrets.local")) return {};
  const out = {};
  for (const raw of fs.readFileSync(".secrets.local", "utf8").split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    if (i === -1) continue;
    const v = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (v) out[l.slice(0, i).trim()] = v;
  }
  return out;
}
const S = readSecrets();
// Empreinte : permet de confirmer qu'une clé est bien lue, sans la divulguer.
const fingerprint = (v) => (v ? `présente (${v.length} car., …${v.slice(-4)})` : "ABSENTE");

console.log("🔑 Secrets lus depuis .secrets.local");
console.log("   SUPABASE_ACCESS_TOKEN      :", fingerprint(S.SUPABASE_ACCESS_TOKEN));
console.log("   SUPABASE_SERVICE_ROLE_KEY  :", fingerprint(S.SUPABASE_SERVICE_ROLE_KEY));
console.log("");

function run(label, cmd, args, env) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    console.error(`❌ Échec : ${label} (code ${r.status})`);
    return false;
  }
  return true;
}

let ok = true;

// ── 1) Edge Function notify (types task_modified + innovation_status) ─
if (!S.SUPABASE_ACCESS_TOKEN) {
  console.log("⏭  notify : SUPABASE_ACCESS_TOKEN absent → déploiement sauté.");
  ok = false;
} else if (!WRITE) {
  console.log("🔍 notify : serait déployée (--write pour le faire).");
} else {
  ok = run("Déploiement de la fonction notify",
    "npx", ["supabase", "functions", "deploy", "notify", "--project-ref", PROJECT_REF],
    { SUPABASE_ACCESS_TOKEN: S.SUPABASE_ACCESS_TOKEN }) && ok;
}

// ── 2) Import des données ────────────────────────────────────────────
if (!S.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("\n⏭  import : SUPABASE_SERVICE_ROLE_KEY absente → import sauté.");
  ok = false;
} else {
  if (!fs.existsSync("termitiere-export.json")) {
    console.log("\n▶ Conversion de l'Excel (termitiere-export.json absent)");
    run("Conversion", "node", ["scripts/xlsx-to-json.mjs", "../Gestion_des_tâches_la_termitière (2).xlsx"], {});
  }
  const args = ["scripts/import.mjs", "./termitiere-export.json"];
  if (WRITE) args.push("--write");
  if (REPLACE) args.push("--replace");
  ok = run(WRITE ? "Import des données" : "Import — SIMULATION", "node", args, {
    SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: S.SUPABASE_SERVICE_ROLE_KEY,
  }) && ok;
}

// ── Reste à faire à la main ──────────────────────────────────────────
console.log("\n" + "─".repeat(64));
console.log("À faire à la main (aucun secret à me confier) :");
console.log("  1. SQL   : coller supabase/APPLY_V7.sql dans Supabase → SQL Editor → Run");
console.log("  2. Front : npm run build, puis glisser dist/ sur https://app.netlify.com/drop");
console.log("─".repeat(64));
console.log(ok ? "\n✅ Étapes automatisables terminées." : "\n⚠ Certaines étapes ont été sautées (voir ci-dessus).");
console.log("🧹 Après la mise en service : supprimez .secrets.local et révoquez le token d'accès.");
