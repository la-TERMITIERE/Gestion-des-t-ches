// Edge Function : échange un token d'accès contre un JWT Supabase signé.
//  - Lit personnel_auth + personnel avec la clé service (contourne la RLS).
//  - Signe un JWT HS256 avec le JWT secret du projet (APP_JWT_SECRET) →
//    auth.uid() = personnel.id côté Postgres, la RLS s'applique.
//
// Secrets requis (supabase secrets set ...) :
//   APP_JWT_SECRET = JWT Secret du projet (Dashboard → Settings → API → JWT Secret)
// (SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont fournis automatiquement.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function salaryFn(raw: string, norm: string): string | null {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "pau") return "pau";
  if (s === "ge") return "ge";
  if (s === "df") return "df";
  if (norm === "rh" && !s.includes("assistant")) return "rh";
  return null;
}
function isAssistantRH(raw: string): boolean {
  const s = String(raw || "").toLowerCase();
  return s.includes("assistant") &&
    (s.includes("rh") || s.includes("ressources humaines"));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { token } = await req.json();
    if (!token) return json({ success: false, error: "Lien d'accès requis." }, 400);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: auth, error } = await admin
      .from("personnel_auth").select("person_id").eq("token", token).maybeSingle();
    if (error) throw error;
    if (!auth) return json({ success: false, error: "Lien invalide ou compte désactivé." }, 401);

    const { data: person } = await admin
      .from("personnel").select("*").eq("id", auth.person_id).maybeSingle();
    if (!person || String(person.status || "").toLowerCase() === "inactif") {
      return json({ success: false, error: "Lien invalide ou compte désactivé." }, 401);
    }

    const secret = Deno.env.get("APP_JWT_SECRET")!;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
    );
    const jwt = await create(
      { alg: "HS256", typ: "JWT" },
      { sub: person.id, role: "authenticated", aud: "authenticated", exp: getNumericDate(60 * 60 * 12) },
      key,
    );

    const salaryRole = salaryFn(person.role_raw, person.role_norm);
    const user = {
      name: person.name,
      email: person.email,
      role: person.role_norm,
      roleRaw: person.role_raw,
      dept: person.dept,
      position: person.position,
      salaryRole,
      seeAllTasks: ["chef", "dir", "rh"].includes(person.role_norm) || isAssistantRH(person.role_raw),
      token,
    };
    return json({ success: true, jwt, user });
  } catch (e) {
    return json({ success: false, error: "Erreur : " + String((e as Error)?.message || e) }, 500);
  }
});
