/*
 * Porte l'UI Apps Script (../../index.html) vers termitiere-web/index.html :
 *  - neutralise les balises de template Apps Script (<?= ?>)
 *  - rebranche l'unique seam `call()` sur la couche API Supabase (window.__termitiereCall)
 *  - injecte le module pont (legacy-bridge.js)
 *
 * Idempotent : relançable à chaque mise à jour de l'index.html source.
 * Usage : node scripts/port-legacy.cjs
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', 'index.html');
const OUT = path.resolve(__dirname, '..', 'index.html');

let h = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');   // normalise CRLF → LF

// 1) Neutraliser les balises de template Apps Script
//    a) bloc logo (scriptlets <? if … ?>) → logo statique
h = h.replace(
  /<\? var _logo[\s\S]*?<h1><\?=\s*_name\s*\?><\/h1>/,
  '<div class="logo" id="app-logo">T</div>\n      <h1>LA TERMITIERE</h1>'
);
//    b) métadonnées de lien profond (injectées plus tard côté client)
h = h.replace('content="<?= urlToken ?>"', 'content=""');
h = h.replace('content="<?= taskParam ?>"', 'content=""');
h = h.replace('content="<?= viewParam ?>"', 'content=""');
// Garde-fou : plus AUCUNE balise Apps Script <? … ?> ne doit subsister (sinon Vite plante)
if (/<\?/.test(h)) {
  console.error('⚠ Balises Apps Script <? … ?> restantes — adapter le script.');
  process.exit(1);
}

// 2) Rebrancher call() sur la couche API (remplace google.script.run)
const OLD_CALL = `  function call(fnName) {
    const args = Array.prototype.slice.call(arguments, 1);
    return new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(err => reject(err))
        [fnName].apply(null, args);
    });
  }`;
const NEW_CALL = `  function call(fnName) {
    const args = Array.prototype.slice.call(arguments, 1);
    // ✨ Migration Supabase : tout passe par la couche API (window.__termitiereCall)
    if (!window.__termitiereCall) return Promise.reject(new Error('API non initialisée'));
    return window.__termitiereCall(fnName, args);
  }`;
if (!h.includes(OLD_CALL)) {
  console.error('⚠ Bloc call() introuvable (a-t-il changé ?). Portage interrompu.');
  process.exit(1);
}
h = h.replace(OLD_CALL, NEW_CALL);
if (h.includes('google.script.run')) {
  console.error('⚠ google.script.run subsiste — vérifier.');
  process.exit(1);
}

// 2b) Personnel : les id sont des UUID (texte) dans la version Supabase → il faut
//     les quoter dans les onclick (sinon openEmployeeModal(a1b2-...) = JS invalide).
//     L'app Apps Script d'origine utilise des id numériques et n'est pas touchée.
h = h.replace(/openEmployeeModal\(\$\{p\.id\}\)/g, "openEmployeeModal('${p.id}')");
h = h.replace(/showAccessLink\(\$\{p\.id\}\)/g, "showAccessLink('${p.id}')");
h = h.replace(/confirmDeactivate\(\$\{p\.id\}\)/g, "confirmDeactivate('${p.id}')");

// 3) Injecter le module pont juste avant </body>
if (!h.includes('legacy-bridge.js')) {
  h = h.replace('</body>', '  <script type="module" src="/src/legacy-bridge.js"></script>\n</body>');
}

fs.writeFileSync(OUT, h);
console.log('✅ Porté →', OUT, '(' + h.length + ' caractères)');
