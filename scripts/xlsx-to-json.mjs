// ════════════════════════════════════════════════════════════════════
//  Convertit le classeur Excel de l'app (téléchargé depuis Google Sheets)
//  en termitiere-export.json — le format exact attendu par import.mjs.
//
//  Usage :
//    node scripts/xlsx-to-json.mjs "../Gestion_des_tâches_la_termitière (2).xlsx"
//    node scripts/xlsx-to-json.mjs <fichier.xlsx> -o termitiere-export.json
//
//  Pourquoi ce script plutôt que exportAllData() côté Apps Script : il part du
//  fichier que l'équipe a sous la main, sans dépendre d'un accès à l'éditeur
//  Apps Script. Il RÉPLIQUE volontairement les parseurs éprouvés de code.gs.js
//  (findHeaderRow / colIndex / getAllTasksRaw_ / dumpSheetByHeader_) : mêmes
//  lignes d'en-tête, mêmes colonnes, mêmes règles — pour produire exactement ce
//  que produirait l'export officiel.
//
//  Lecture seule : n'écrit qu'un fichier JSON, ne touche à aucune base.
// ════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import zlib from "node:zlib";

// ── Lecture ZIP minimale (un .xlsx est un zip) ───────────────────────
function unzip(file) {
  const buf = fs.readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("Fichier .xlsx illisible (fin d'archive introuvable).");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries[name] = {
      lho: buf.readUInt32LE(off + 42),
      method: buf.readUInt16LE(off + 10),
      csize: buf.readUInt32LE(off + 20),
    };
    off += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const e = entries[name];
    if (!e) return null;
    const nameLen = buf.readUInt16LE(e.lho + 26);
    const extraLen = buf.readUInt16LE(e.lho + 28);
    const start = e.lho + 30 + nameLen + extraLen;
    const data = buf.slice(start, start + e.csize);
    return e.method === 0 ? data : zlib.inflateRawSync(data);
  };
}

const unesc = (s) =>
  String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, "&");   // en dernier : sinon &amp;lt; se décode deux fois

// ── Dates : Excel stocke un nombre de jours depuis le 30/12/1899 ─────
// Détection par le format numérique de la cellule (comme le fait Excel lui-même),
// et non par la position de la colonne : c'est ce qui rend le script robuste si
// l'ordre des colonnes bouge.
function isDateFormat(code) {
  if (!code) return false;
  const c = code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "");
  return /[dmyhs]/i.test(c) && /[dmy]/i.test(c);
}
function serialToDate(n) {
  // 25569 = jours entre 1899-12-30 et 1970-01-01. On travaille en UTC pour que
  // la date affichée soit celle saisie, sans décalage de fuseau.
  return new Date(Math.round((n - 25569) * 86400 * 1000));
}
// Réplique formatDate() de code.gs.js : les Date deviennent 'yyyy-MM-dd'.
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// ── Feuille XML → grille 2D (valeurs déjà typées) ────────────────────
function colToIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function buildReader(file) {
  const read = unzip(file);

  // Chaînes partagées
  const ssXml = read("xl/sharedStrings.xml");
  const shared = [];
  if (ssXml) {
    for (const si of ssXml.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      // Une <si> peut être découpée en plusieurs <t> (runs de mise en forme).
      let s = "";
      for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += t[1];
      shared.push(unesc(s));
    }
  }

  // Formats numériques → savoir quelles cellules sont des dates
  const stylesXml = read("xl/styles.xml");
  const dateStyle = new Set();
  if (stylesXml) {
    const s = stylesXml.toString("utf8");
    const customFmt = {};
    for (const m of s.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
      customFmt[m[1]] = unesc(m[2]);
    }
    // Formats de date intégrés à Excel (14-22 : dates/heures ; 45-47 : durées).
    const builtinDate = new Set(["14","15","16","17","18","19","20","21","22","27","30","36","45","46","47","50","57"]);
    const cellXfs = s.slice(s.indexOf("<cellXfs"), s.indexOf("</cellXfs>"));
    let xfIndex = 0;
    for (const xf of cellXfs.matchAll(/<xf[^>]*numFmtId="(\d+)"[^>]*\/?>/g)) {
      const id = xf[1];
      if (builtinDate.has(id) || isDateFormat(customFmt[id])) dateStyle.add(xfIndex);
      xfIndex++;
    }
  }

  // Nom de feuille → fichier XML
  const wb = read("xl/workbook.xml").toString("utf8");
  const rels = read("xl/_rels/workbook.xml.rels").toString("utf8");
  const targetById = {};
  for (const m of rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    targetById[m[1]] = m[2].replace(/^\/?xl\//, "").replace(/^\//, "");
  }
  const sheetFile = {};
  for (const m of wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g)) {
    sheetFile[unesc(m[1])] = "xl/" + targetById[m[2]];
  }

  // Grille d'une feuille : tableau de lignes, chaque ligne = tableau de valeurs.
  function grid(sheetName) {
    const path = sheetFile[sheetName];
    if (!path) return [];
    const xml = read(path);
    if (!xml) return [];
    const s = xml.toString("utf8");
    const rows = [];
    let width = 0;
    // ⚠ Les balises auto-fermantes (<row …/>, <c …/> pour une cellule vide) doivent
    // être distinguées des balises ouvrantes : sinon « …<\/row> » part chercher le
    // </row> de la ligne SUIVANTE et avale son contenu, ce qui décale les colonnes.
    // D'où l'alternative (?:\/>|>…<\/x>), qui teste l'auto-fermeture en premier.
    for (const rm of s.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowIdx = Number((rm[1].match(/\br="(\d+)"/) || [])[1] || 0) - 1;
      if (rowIdx < 0) continue;
      const cells = [];
      for (const cm of (rm[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1] || "";
        const inner = cm[2] || "";
        const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
        if (!ref) continue;
        const ci = colToIndex(ref);
        const type = (attrs.match(/\st="([^"]+)"/) || [])[1] || "";
        const style = Number((attrs.match(/\ss="(\d+)"/) || [])[1] ?? -1);

        let value = "";
        if (type === "s") {
          const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          value = v != null ? (shared[Number(v)] ?? "") : "";
        } else if (type === "inlineStr") {
          let t = "";
          for (const m of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) t += m[1];
          value = unesc(t);
        } else if (type === "b") {
          const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          value = v === "1";
        } else {
          const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          if (v == null || v === "") value = "";
          else if (dateStyle.has(style) && isFinite(Number(v))) value = serialToDate(Number(v));
          else value = isFinite(Number(v)) ? Number(v) : unesc(v);
        }
        cells[ci] = value;
        if (ci + 1 > width) width = ci + 1;
      }
      rows[rowIdx] = cells;
    }
    // Normalise : pas de trous, cellules vides = '' (comme getValues() d'Apps Script).
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || [];
      const line = [];
      for (let c = 0; c < width; c++) line.push(r[c] === undefined ? "" : r[c]);
      out.push(line);
    }
    return out;
  }

  return { grid, sheets: Object.keys(sheetFile) };
}

// ── Répliques des helpers de code.gs.js ──────────────────────────────
const cell = (v) => (v instanceof Date ? fmtDate(v) : v == null ? "" : v);
const str = (v) => String(cell(v) ?? "").trim();

function findHeaderRow(data, keyword) {
  for (let i = 0; i < data.length; i++) {
    if (data[i].some((c) => String(cell(c)).toLowerCase().includes(keyword.toLowerCase()))) return i;
  }
  return -1;
}
function colIndex(headers, ...keywords) {
  const lower = headers.map((h) => String(cell(h)).toLowerCase());
  for (const kw of keywords) {
    const i = lower.findIndex((h) => h.includes(kw.toLowerCase()));
    if (i !== -1) return i;
  }
  return -1;
}
function formatDate(d) {
  if (!d && d !== 0) return "";
  if (d instanceof Date) return fmtDate(d);
  return String(d);
}

// ── Noms de feuilles (CONFIG de code.gs.js) ──────────────────────────
const SHEETS = {
  PERSONNEL:       "👥 Personnel",
  TACHES:          "📋 Tâches",
  TEAM_MEMBERS:    "👥 Membres Équipes",
  MESSAGES:        "💬 Messages",
  OBJECTIFS:       "🎯 Objectifs",
  OBJ_COMMENTS:    "💭 Commentaires Objectifs",
  DAILY:           "🔁 Tâches journalières",
  DAILY_LOG:       "✅ Suivi journalier",
  HOLIDAYS:        "📅 Jours fériés",
  SALARY:          "💰 Autorisations Salaire",
  SALARY_EXTERNAL: "💰 Bénéficiaires externes",
};

// ── Réplique de exportPersonnel_() ───────────────────────────────────
function exportPersonnel(grid) {
  const data = grid(SHEETS.PERSONNEL);
  const headerRow = findHeaderRow(data, "email");
  if (headerRow === -1) return [];
  const h = data[headerRow];
  const cName = colIndex(h, "nom");
  const cEmail = colIndex(h, "email");
  const cDept = colIndex(h, "département", "division");
  const cRole = colIndex(h, "rôle", "role");
  const cStatus = colIndex(h, "statut");
  const cPos = colIndex(h, "poste");
  const cToken = colIndex(h, "token", "jeton");
  const cStart = colIndex(h, "entrée", "entree", "date");
  const out = [];
  for (let i = headerRow + 1; i < data.length; i++) {
    const row = data[i] || [];
    const name = str(row[cName]);
    const email = str(row[cEmail]);
    if (!name || !email) continue;
    out.push({
      name,
      email,
      dept: cDept !== -1 ? str(row[cDept]) : "",
      position: cPos !== -1 ? str(row[cPos]) : "",
      role_raw: cRole !== -1 ? str(row[cRole]) : "",
      status: cStatus !== -1 ? str(row[cStatus]) || "Actif" : "Actif",
      token: cToken !== -1 ? str(row[cToken]) : "",
      start_date: cStart !== -1 ? formatDate(row[cStart]) : "",
    });
  }
  return out;
}

// ── Réplique de getAllTasksRaw_() (lecture POSITIONNELLE, comme l'original) ──
function exportTasks(grid) {
  const data = grid(SHEETS.TACHES);
  let headerRow = -1;
  for (let i = 0; i < data.length; i++) {
    if (str((data[i] || [])[0]) === "ID") { headerRow = i; break; }
  }
  if (headerRow === -1) return [];
  const headers = data[headerRow];
  const cGroupId = colIndex(headers, "group id", "group_id", "équipe", "groupe");
  const cReportRequired = colIndex(headers, "rapport requis", "rapport_requis");
  const cReportLink = colIndex(headers, "lien rapport", "lien_rapport", "rapport_link");
  const cExpected = colIndex(headers, "résultat attendu", "resultat attendu", "résultat", "resultat");

  const tasks = [];
  for (let i = headerRow + 1; i < data.length; i++) {
    const row = data[i] || [];
    // Même garde que l'original : seules les lignes T… sont des tâches.
    if (!row[0] || !String(cell(row[0])).match(/^T\d+/)) continue;
    tasks.push({
      id: str(row[0]),
      dateAssigned: formatDate(row[1]),
      dateLimit: formatDate(row[2]),
      assignedByRole: str(row[3]),
      assignedByName: str(row[4]),
      recipient: str(row[5]),
      department: str(row[6]),
      category: str(row[7]),
      description: str(row[8]),
      priority: str(row[9]),
      status: str(row[10]) || "À faire",
      progress: Number(cell(row[11]) || 0) || 0,
      closeDate: formatDate(row[12]),
      employeeComment: str(row[13]),
      chefNote: str(row[14]),
      chefComment: str(row[15]),
      dateStart: formatDate(row[16]),
      groupId: cGroupId !== -1 ? str(row[cGroupId]) : "",
      reportRequired: cReportRequired !== -1 ? str(row[cReportRequired]).toLowerCase() === "oui" : false,
      reportLink: cReportLink !== -1 ? str(row[cReportLink]) : "",
      expectedResult: cExpected !== -1 ? str(row[cExpected]) : "",
    });
  }
  return tasks;
}

// ── Réplique de dumpSheetByHeader_() (en-tête = 1re ligne) ───────────
function dumpSheet(grid, name) {
  const data = grid(name);
  if (data.length < 2) return [];
  const headers = data[0].map((x) => String(cell(x)).trim());
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i] || [];
    if (r.every((c) => c === "" || c === null)) continue;
    const o = {};
    for (let c = 0; c < headers.length; c++) {
      o[headers[c] || "col" + c] = cell(r[c]);
    }
    rows.push(o);
  }
  return rows;
}

// ── Programme ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("-"));
const oi = args.indexOf("-o");
const out = oi !== -1 ? args[oi + 1] : "termitiere-export.json";

if (!file) {
  console.error('Usage : node scripts/xlsx-to-json.mjs "<fichier.xlsx>" [-o sortie.json]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error("❌ Fichier introuvable :", file);
  process.exit(1);
}

const { grid, sheets } = buildReader(file);

// Garde-fou : si une feuille attendue manque, on le dit au lieu d'exporter du vide.
const missing = Object.values(SHEETS).filter((s) => !sheets.includes(s));
if (missing.length) {
  console.warn("⚠ Feuilles absentes du classeur :", missing.join(", "));
}

const data = {
  exportedAt: new Date().toISOString(),
  personnel: exportPersonnel(grid),
  tasks: exportTasks(grid),
  teamMembers: dumpSheet(grid, SHEETS.TEAM_MEMBERS),
  messages: dumpSheet(grid, SHEETS.MESSAGES),
  objectives: dumpSheet(grid, SHEETS.OBJECTIFS),
  objectiveComments: dumpSheet(grid, SHEETS.OBJ_COMMENTS),
  dailyTasks: dumpSheet(grid, SHEETS.DAILY),
  dailyLog: dumpSheet(grid, SHEETS.DAILY_LOG),
  holidays: dumpSheet(grid, SHEETS.HOLIDAYS),
  salary: dumpSheet(grid, SHEETS.SALARY),
  salaryExternal: dumpSheet(grid, SHEETS.SALARY_EXTERNAL),
};

fs.writeFileSync(out, JSON.stringify(data, null, 2));

console.log("✅ Converti →", out);
for (const k of Object.keys(data)) {
  if (Array.isArray(data[k])) console.log(String(data[k].length).padStart(6), k);
}
const sansToken = data.personnel.filter((p) => !p.token).length;
if (sansToken) console.log(`\nℹ ${sansToken} personne(s) sans token : elles n'auront pas de lien d'accès tant qu'on ne leur en génère pas un.`);
