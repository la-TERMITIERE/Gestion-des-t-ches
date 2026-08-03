import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!URL || !ANON) {
  console.error("⚠ VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY manquants (.env)");
}

// Client anonyme — sert uniquement à invoquer l'Edge Function auth-token.
export const anon = createClient(URL, ANON);

// JWT custom (signé par auth-token), injecté sur chaque requête du client authentifié.
let _jwt = null;
export function setJwt(j) { _jwt = j; }
export function getJwt() { return _jwt; }

// Client authentifié : porte le JWT → la RLS Postgres s'applique (auth.uid() = personnel.id).
export const db = createClient(URL, ANON, {
  accessToken: async () => _jwt,
});
