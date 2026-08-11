// Edge Function : envoi des notifications e-mail (équivalent des sendXxxEmail de code.gs.js).
//  Appelée par le frontend après une mutation : db.functions.invoke('notify', { body:{ type, ... } }).
//  Tourne avec la clé SERVICE → peut lire l'email ET le token du destinataire pour
//  construire un lien profond, sans jamais exposer les tokens au navigateur.
//
// Secrets requis : BREVO_API_KEY, EMAIL_FROM (Nom <email vérifié chez Brevo>), APP_URL.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const APP_NAME = "LA TERMITIERE";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function esc(s: unknown) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function link(token: string, taskId?: string, view?: string) {
  const base = (Deno.env.get("APP_URL") || "").replace(/\/+$/, "");
  let u = base + "/?token=" + encodeURIComponent(token || "");
  if (taskId) u += "&task=" + encodeURIComponent(taskId);
  if (view) u += "&view=" + encodeURIComponent(view);
  return u;
}
function shell(title: string, color: string, name: string, bodyHtml: string, btnUrl: string, btnLabel: string) {
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
<div style="background:${color};padding:16px 24px;border-radius:8px 8px 0 0;"><h2 style="color:#fff;margin:0;font-size:18px;">${title}</h2></div>
<div style="padding:24px;border:1px solid #dadce0;border-top:none;border-radius:0 0 8px 8px;">
<p>Bonjour <strong>${esc(name)}</strong>,</p>${bodyHtml}
${btnUrl ? `<div style="text-align:center;margin:22px 0;"><a href="${btnUrl}" style="background:${color};color:#fff;padding:12px 28px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;">▶ ${btnLabel}</a></div>` : ""}
<hr style="border:none;border-top:1px solid #dadce0;margin:16px 0;"><p style="font-size:11px;color:#9aa0a6;">— ${APP_NAME}</p></div></div>`;
}
// EMAIL_FROM au format "Nom <email@exemple.com>" (l'email doit être un expéditeur vérifié chez Brevo)
function parseFrom() {
  const raw = Deno.env.get("EMAIL_FROM") || "LA TERMITIERE <no-reply@example.com>";
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1] || APP_NAME, email: m[2] } : { name: APP_NAME, email: raw.trim() };
}
async function sendMail(to: string, subject: string, html: string, text: string) {
  if (!to) return;
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": Deno.env.get("BREVO_API_KEY")!, "Content-Type": "application/json", "accept": "application/json" },
    body: JSON.stringify({ sender: parseFrom(), to: [{ email: to }], subject, htmlContent: html, textContent: text || undefined }),
  });
  if (!r.ok) console.error("brevo", await r.text());
}
async function person(name: string) {
  const { data } = await admin.from("personnel").select("id,name,email,dept").eq("name", name).limit(1);
  const p = data && data[0];
  if (!p) return null;
  const { data: a } = await admin.from("personnel_auth").select("token").eq("person_id", p.id).limit(1);
  return { ...p, token: (a && a[0] && a[0].token) || "" };
}
async function bySalaryFn(fn: string) {
  const { data } = await admin.from("personnel").select("name,email,role_raw,role_norm,status");
  return (data || []).filter((p) => {
    if (String(p.status || "").toLowerCase() === "inactif") return false;
    const raw = String(p.role_raw || "").trim().toLowerCase();
    if (raw === "pau") return fn === "pau";
    if (raw === "ge") return fn === "ge";
    if (raw === "df") return fn === "df";
    if (p.role_norm === "rh" && raw.indexOf("assistant") === -1) return fn === "rh";
    return false;
  });
}
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json();
    const t = b.type;
    const actor = b.actorName || "";

    if (t === "task_assigned") {
      const p = await person(b.recipient);
      if (!p || !p.email || p.name === actor) return json({ ok: true });
      const html = shell("📋 Nouvelle tâche assignée", "#1a73e8", p.name,
        `<p><strong>${esc(actor)}</strong> vous a assigné la tâche <strong>${esc(b.taskId)}</strong>.</p>
         <p style="background:#f8f9fa;padding:10px;border-radius:4px;">${esc(b.description)}</p>
         ${b.dateLimit ? `<p>Échéance : <strong>${esc(b.dateLimit)}</strong></p>` : ""}`,
        link(p.token, b.taskId), "Voir la tâche");
      await sendMail(p.email, `[${APP_NAME}] Nouvelle tâche assignée — ${b.taskId}`, html,
        `${actor} vous a assigné la tâche ${b.taskId} : ${b.description}\n${link(p.token, b.taskId)}`);
      return json({ ok: true });
    }

    if (t === "task_completed") {
      const p = await person(b.assigner);
      if (!p || !p.email || p.name === actor) return json({ ok: true });
      const html = shell("✅ Tâche terminée", "#137333", p.name,
        `<p><strong>${esc(actor)}</strong> a marqué la tâche <strong>${esc(b.taskId)}</strong> comme terminée.</p>
         <p style="background:#f8f9fa;padding:10px;border-radius:4px;">${esc(b.description)}</p>`,
        link(p.token, b.taskId), "Voir la tâche");
      await sendMail(p.email, `[${APP_NAME}] ✅ Tâche ${b.taskId} terminée — ${actor}`, html,
        `${actor} a terminé la tâche ${b.taskId}.\n${link(p.token, b.taskId)}`);
      return json({ ok: true });
    }

    if (t === "task_appreciation") {
      const p = await person(b.recipient);
      if (!p || !p.email || p.name === actor) return json({ ok: true });
      const html = shell("⭐ Appréciation de votre responsable", "#e37400", p.name,
        `<p><strong>${esc(actor)}</strong> a laissé une appréciation sur votre tâche <strong>${esc(b.taskId)}</strong> :</p>
         <div style="background:#fffde7;border-left:4px solid #f9ab00;padding:14px 18px;margin:18px 0;">${esc(b.text)}</div>`,
        link(p.token, b.taskId), "Voir la tâche");
      await sendMail(p.email, `[${APP_NAME}] ⭐ Appréciation reçue — Tâche ${b.taskId}`, html,
        `${actor} : « ${b.text} » (tâche ${b.taskId})\n${link(p.token, b.taskId)}`);
      return json({ ok: true });
    }

    if (t === "task_modified") {
      // b.changes = [{ label, before, after }] — déjà filtré côté appelant : on ne
      // reçoit que des champs réellement modifiés, jamais une liste vide.
      const p = await person(b.recipient);
      if (!p || !p.email || p.name === actor) return json({ ok: true });
      const changes = Array.isArray(b.changes) ? b.changes : [];
      if (!changes.length) return json({ ok: true });
      const rows = changes.map((c: { label: string; before: string; after: string }) =>
        `<tr>
           <td style="padding:6px 10px;border-bottom:1px solid #e8eaed;font-weight:bold;white-space:nowrap;">${esc(c.label)}</td>
           <td style="padding:6px 10px;border-bottom:1px solid #e8eaed;color:#9aa0a6;text-decoration:line-through;">${esc(c.before) || "—"}</td>
           <td style="padding:6px 10px;border-bottom:1px solid #e8eaed;color:#1967d2;font-weight:bold;">${esc(c.after) || "—"}</td>
         </tr>`).join("");
      const html = shell("✏️ Votre tâche a été modifiée", "#7b1fa2", p.name,
        `<p><strong>${esc(actor)}</strong> a modifié la tâche <strong>${esc(b.taskId)}</strong>.</p>
         <p style="background:#f8f9fa;padding:10px;border-radius:4px;">${esc(b.description)}</p>
         <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:14px;">
           <tr><th style="text-align:left;padding:6px 10px;color:#5f6368;font-size:11px;">CHAMP</th>
               <th style="text-align:left;padding:6px 10px;color:#5f6368;font-size:11px;">AVANT</th>
               <th style="text-align:left;padding:6px 10px;color:#5f6368;font-size:11px;">APRÈS</th></tr>
           ${rows}
         </table>`,
        link(p.token, b.taskId), "Voir la tâche");
      await sendMail(p.email, `[${APP_NAME}] ✏️ Tâche ${b.taskId} modifiée — ${actor}`, html,
        `${actor} a modifié la tâche ${b.taskId} :\n` +
        changes.map((c: { label: string; before: string; after: string }) => `- ${c.label} : ${c.before || "—"} → ${c.after || "—"}`).join("\n") +
        `\n${link(p.token, b.taskId)}`);
      return json({ ok: true });
    }

    if (t === "task_returned") {
      const p = await person(b.recipient);
      if (!p || !p.email) return json({ ok: true });
      const html = shell("🔄 Votre tâche a été renvoyée", "#b06000", p.name,
        `<p><strong>${esc(actor)}</strong> estime que la tâche <strong>${esc(b.taskId)}</strong> doit être <strong>reprise / corrigée</strong>.</p>
         <p>Motif : <em style="color:#b06000;">${esc(b.reason)}</em></p>`,
        link(p.token, b.taskId), "Revoir ma tâche");
      await sendMail(p.email, `[${APP_NAME}] 🔄 Tâche ${b.taskId} à reprendre`, html,
        `${actor} a renvoyé la tâche ${b.taskId}. Motif : ${b.reason}\n${link(p.token, b.taskId)}`);
      return json({ ok: true });
    }

    if (t === "salary_stage") {
      // b.target = 'df' | 'ge' | 'pau' ; b.person = bénéficiaire ; b.stage = ce qui vient d'être fait
      const verb = { df: "valider", ge: "approuver", pau: "autoriser" }[b.target] || "traiter";
      const recipients = await bySalaryFn(b.target);
      for (const r of recipients) {
        if (!r.email) continue;
        const full = await person(r.name);
        const html = shell(`💰 Versement de salaire — à ${verb}`, "#0a8043", r.name,
          `<p>Une demande de versement de salaire pour <strong>${esc(b.person)}</strong> attend votre action : <strong>${verb}</strong>.</p>
           ${b.periode ? `<p>Période : ${esc(b.periode)}</p>` : ""}${b.montant ? `<p>Montant : ${esc(b.montant)}</p>` : ""}`,
          link(full ? full.token : "", undefined, "salary"), "Ouvrir l'onglet Autorisation salaire");
        await sendMail(r.email, `[${APP_NAME}] 💰 Action requise : ${verb} un versement — ${b.person}`, html,
          `Demande de versement pour ${b.person} à ${verb}.\n${link(full ? full.token : "", undefined, "salary")}`);
      }
      return json({ ok: true });
    }

    if (t === "salary_final" || t === "salary_reject") {
      const recipients = await bySalaryFn("rh");
      const ok = t === "salary_final";
      for (const r of recipients) {
        if (!r.email) continue;
        const full = await person(r.name);
        const html = shell(ok ? "✅ Versement de salaire autorisé" : "❌ Demande de versement rejetée",
          ok ? "#137333" : "#c5221f", r.name,
          ok ? `<p>Le versement pour <strong>${esc(b.person)}</strong> a été <strong>autorisé</strong> par ${esc(actor)}. Circuit complet.</p>`
             : `<p><strong>${esc(actor)}</strong> a <strong>rejeté</strong> la demande pour <strong>${esc(b.person)}</strong>.</p><p>Motif : <em>${esc(b.reason)}</em></p>`,
          link(full ? full.token : "", undefined, "salary"), "Voir le suivi");
        await sendMail(r.email, `[${APP_NAME}] ${ok ? "✅ Versement autorisé" : "❌ Versement rejeté"} — ${b.person}`, html, "");
      }
      return json({ ok: true });
    }

    // ✨ v7.2 : diffusion d'INFORMATION (pas d'action attendue) autour d'une demande
    //  de versement. Deux publics, tenus par le paramétrage (table
    //  salary_notify_recipients, réglée par le Chef / la DA-RH depuis l'onglet) :
    //    • moment 'request'  → ceux qui ont coché « à l'initiation »
    //    • moment 'decision' → ceux qui ont coché « aux décisions »
    //  Le bénéficiaire est prévenu dans tous les cas : c'est sa demande.
    //  Les acteurs du circuit continuent de recevoir leur e-mail « action requise »
    //  par salary_stage — ce type-ci ne le remplace pas, il s'y ajoute.
    if (t === "salary_announce") {
      const moment = b.moment === "decision" ? "decision" : "request";
      const col = moment === "decision" ? "on_decision" : "on_request";
      const { data: recips } = await admin
        .from("salary_notify_recipients").select("person_id, person_name").eq(col, true);

      // Dédoublonnage par nom : le bénéficiaire peut aussi figurer dans la liste.
      const names = new Set<string>((recips || []).map((r) => String(r.person_name || "")).filter(Boolean));
      if (b.person) names.add(String(b.person));

      const autorise = b.outcome === "autorise";
      const rejete   = b.outcome === "rejete";
      const color = moment === "request" ? "#0a8043" : autorise ? "#137333" : rejete ? "#c5221f" : "#0a8043";
      const title = moment === "request" ? "💰 Demande de versement initiée"
                  : autorise ? "✅ Versement de salaire autorisé" : "❌ Demande de versement rejetée";

      const details = `${b.periode ? `<p>Période : <strong>${esc(b.periode)}</strong></p>` : ""}` +
                      `${b.montant ? `<p>Montant : <strong>${esc(b.montant)}</strong></p>` : ""}`;

      for (const name of names) {
        const p = await person(name);
        if (!p || !p.email) continue;
        // Le bénéficiaire lit « pour vous » ; les autres lisent son nom.
        const cible = p.name === b.person ? "vous" : `<strong>${esc(b.person)}</strong>`;
        const corps = moment === "request"
          ? `<p>Une demande d'autorisation de versement de salaire vient d'être initiée pour ${cible}${
              b.requestedBy ? ` par <strong>${esc(b.requestedBy)}</strong>` : ""}.</p>${details}
             <p style="font-size:13px;color:#5f6368;">Elle suit maintenant le circuit : validation (DF) → approbation (GE) → autorisation (PAU).</p>`
          : autorise
            ? `<p>Le versement concernant ${cible} a été <strong>autorisé</strong>. Le circuit est complet.</p>${details}`
            : `<p>La demande concernant ${cible} a été <strong>rejetée</strong> par ${esc(actor)}.</p>
               ${b.reason ? `<p>Motif : <em>${esc(b.reason)}</em></p>` : ""}`;

        const html = shell(title, color, p.name, corps,
          link(p.token, undefined, "salary"), "Ouvrir le suivi");
        // Objet = texte brut : pas de esc(), qui y laisserait des « &amp; ».
        await sendMail(p.email, `[${APP_NAME}] ${title} — ${b.person}`, html,
          `${title} — ${b.person}\n${link(p.token, undefined, "salary")}`);
      }
      return json({ ok: true });
    }

    if (t === "innovation_status") {
      const p = await person(b.author);
      if (!p || !p.email || p.name === actor) return json({ ok: true });
      const retenue = String(b.status) === "Retenue";
      const color = retenue ? "#137333" : String(b.status) === "Écartée" ? "#5f6368" : "#7b1fa2";
      const html = shell("💡 Votre idée a été examinée", color, p.name,
        `<p><strong>${esc(actor)}</strong> a fait évoluer votre idée <strong>${esc(b.title)}</strong>.</p>
         <p>Nouveau statut : <strong style="color:${color};">${esc(b.status)}</strong></p>
         ${b.note ? `<div style="background:#f8f9fa;border-left:4px solid ${color};padding:14px 18px;margin:18px 0;">${esc(b.note)}</div>` : ""}
         ${retenue ? "<p>Bravo, votre idée est retenue 🎉</p>" : ""}`,
        link(p.token, undefined, "innovation"), "Voir l'idée");
      await sendMail(p.email, `[${APP_NAME}] 💡 Votre idée « ${b.title} » — ${b.status}`, html,
        `${actor} a fait passer votre idée « ${b.title} » au statut : ${b.status}.` +
        (b.note ? `\nAvis : ${b.note}` : "") + `\n${link(p.token, undefined, "innovation")}`);
      return json({ ok: true });
    }

    if (t === "welcome" || t === "access_link") {
      // b.email, b.name, b.token fournis par l'appelant (RH/Chef vient de les créer)
      const url = link(b.token);
      const html = shell(t === "welcome" ? "👋 Bienvenue sur " + APP_NAME : "🔑 Votre lien d'accès",
        "#1a73e8", b.name || "",
        `<p>Voici votre <strong>lien d'accès personnel</strong> à l'application. Gardez-le, il vous identifie.</p>
         <p style="font-size:12px;color:#5f6368;word-break:break-all;">${url}</p>`,
        url, "Ouvrir l'application");
      await sendMail(b.email, `[${APP_NAME}] Votre lien d'accès`, html, `Votre lien d'accès : ${url}`);
      return json({ ok: true });
    }

    return json({ ok: false, error: "type inconnu" }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
