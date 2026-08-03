// Edge Function : envoi d'e-mail transactionnel via Resend.
//  Remplace MailApp.sendEmail. Les templates HTML de code.gs.js sont réutilisés
//  tels quels côté appelant (on passe { to, subject, html, text }).
//
// Secrets requis :
//   BREVO_API_KEY = clé API Brevo (brevo.com → SMTP & API → API Keys)
//   EMAIL_FROM    = "LA TERMITIERE <ton-email-verifie@gmail.com>" (expéditeur vérifié chez Brevo)

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { to, subject, html, text } = await req.json();
    if (!to || !subject) return json({ success: false, error: "Champs 'to' et 'subject' requis." }, 400);

    const rawFrom = Deno.env.get("EMAIL_FROM") || "LA TERMITIERE <no-reply@example.com>";
    const fm = rawFrom.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
    const sender = fm ? { name: fm[1] || "LA TERMITIERE", email: fm[2] } : { name: "LA TERMITIERE", email: rawFrom.trim() };
    const recipients = (Array.isArray(to) ? to : [to]).map((e) => ({ email: e }));

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": Deno.env.get("BREVO_API_KEY") || "",
        "Content-Type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify({ sender, to: recipients, subject, htmlContent: html || undefined, textContent: text || undefined }),
    });
    const data = await resp.json();
    if (!resp.ok) return json({ success: false, error: data?.message || "Échec de l'envoi." }, 502);
    return json({ success: true, id: data?.messageId });
  } catch (e) {
    return json({ success: false, error: String((e as Error)?.message || e) }, 500);
  }
});
