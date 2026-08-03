// Pont entre l'UI legacy (index.html) et la couche API Supabase.
//  - Récupère le token depuis l'URL (?token=…)
//  - Authentifie (token → JWT) AVANT que l'UI ne lance bootstrapApp
//  - Expose window.__termitiereCall, que le seam call() de l'UI appelle
//
// Les modules ES sont « deferred » : ce script s'exécute après l'analyse du
// document mais AVANT l'événement DOMContentLoaded → window.__termitiereCall
// est défini quand l'UI démarre.
import { call, authenticate } from "./lib/api.js";

function tokenFromUrl() {
  try {
    const p = new URLSearchParams(window.location.search);
    const t = p.get("token");
    if (t) return t.trim();
  } catch (e) { /* ignore */ }
  const hash = window.location.hash || "";
  if (hash.includes("token=")) {
    try { return decodeURIComponent(hash.split("token=")[1].split("&")[0]).trim(); } catch (e) {}
  }
  return "";
}

let resolveReady;
const ready = new Promise((r) => (resolveReady = r));
let authError = null;

(async () => {
  const token = tokenFromUrl();
  try {
    if (!token) throw new Error("Lien d'accès requis (paramètre ?token= manquant).");
    await authenticate(token);
  } catch (e) {
    authError = e;
    console.error("[bridge] authentification:", e);
  } finally {
    resolveReady();
  }
})();

window.__termitiereCall = async (fnName, args) => {
  await ready;
  if (authError) throw authError;
  return call(fnName, ...(args || []));
};
