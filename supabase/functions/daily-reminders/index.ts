// Edge Function : rappels de démarrage (équivalent de sendStartReminderEmail).
//  Envoie un e-mail au destinataire des tâches « À faire » dont la date de début
//  est atteinte/dépassée. À planifier 1×/jour (voir 0011_cron_reminders.sql).
//
// Secrets : BREVO_API_KEY, EMAIL_FROM (Nom <email vérifié chez Brevo>), APP_URL.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_NAME = "LA TERMITIERE";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function esc(s: unknown) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function link(token: string, taskId: string) {
  const base = (Deno.env.get("APP_URL") || "").replace(/\/+$/, "");
  return base + "/?token=" + encodeURIComponent(token || "") + "&task=" + encodeURIComponent(taskId);
}
function parseFrom() {
  const raw = Deno.env.get("EMAIL_FROM") || "LA TERMITIERE <no-reply@example.com>";
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1] || APP_NAME, email: m[2] } : { name: APP_NAME, email: raw.trim() };
}
async function sendMail(to: string, subject: string, html: string) {
  if (!to) return;
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": Deno.env.get("BREVO_API_KEY")!, "Content-Type": "application/json", "accept": "application/json" },
    body: JSON.stringify({ sender: parseFrom(), to: [{ email: to }], subject, htmlContent: html }),
  });
  if (!r.ok) console.error("brevo", await r.text());
}

Deno.serve(async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Tâches à démarrer (À faire) dont la date de début est atteinte.
    const { data: tasks } = await admin.from("tasks").select("id,description,recipient_id,recipient_name,date_start,date_limit")
      .eq("status", "À faire").eq("archived", false).lte("date_start", today).not("recipient_id", "is", null);

    // Tokens des destinataires
    const ids = [...new Set((tasks || []).map((t) => t.recipient_id))];
    const tokens: Record<string, string> = {};
    const emails: Record<string, string> = {};
    if (ids.length) {
      const { data: au } = await admin.from("personnel_auth").select("person_id,token").in("person_id", ids);
      (au || []).forEach((a) => (tokens[a.person_id] = a.token));
      const { data: pe } = await admin.from("personnel").select("id,email,status").in("id", ids);
      (pe || []).forEach((p) => { if (String(p.status || "").toLowerCase() !== "inactif") emails[p.id] = p.email; });
    }

    let sent = 0;
    for (const t of tasks || []) {
      const email = emails[t.recipient_id];
      if (!email) continue;
      const late = t.date_limit && t.date_limit < today;
      const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
<div style="background:${late ? "#c5221f" : "#b06000"};padding:16px 24px;border-radius:8px 8px 0 0;"><h2 style="color:#fff;margin:0;font-size:18px;">⏰ Tâche à démarrer — ${esc(t.id)}</h2></div>
<div style="padding:24px;border:1px solid #dadce0;border-top:none;border-radius:0 0 8px 8px;">
<p>Bonjour <strong>${esc(t.recipient_name)}</strong>,</p>
<p>La tâche <strong>${esc(t.id)}</strong> ${late ? "est <strong>en retard</strong> et " : ""}attend d'être démarrée :</p>
<p style="background:#f8f9fa;padding:10px;border-radius:4px;">${esc(t.description)}</p>
${t.date_limit ? `<p>Échéance : <strong>${esc(t.date_limit)}</strong></p>` : ""}
<div style="text-align:center;margin:22px 0;"><a href="${link(tokens[t.recipient_id] || "", t.id)}" style="background:#1a73e8;color:#fff;padding:12px 28px;border-radius:4px;text-decoration:none;font-weight:bold;">▶ Voir la tâche</a></div>
<hr style="border:none;border-top:1px solid #dadce0;margin:16px 0;"><p style="font-size:11px;color:#9aa0a6;">— ${APP_NAME}</p></div></div>`;
      await sendMail(email, `[${APP_NAME}] ⏰ Tâche ${t.id} à démarrer`, html);
      sent++;
    }
    return new Response(JSON.stringify({ ok: true, sent }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e) }), { status: 500 });
  }
});
