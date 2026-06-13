// Edge Function: añade el email del usuario autenticado a una lista de Acumbamail.
// Se invoca desde el cliente tras iniciar sesión SOLO si el usuario dio su opt-in.
// Secrets necesarios: ACUMBAMAIL_TOKEN, ACUMBAMAIL_LIST_ID
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    // Usuario autenticado a partir de su JWT
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user?.email) return json({ error: "unauthorized" }, 401);

    const token = Deno.env.get("ACUMBAMAIL_TOKEN");
    const listId = Deno.env.get("ACUMBAMAIL_LIST_ID");
    if (!token || !listId) return json({ error: "missing_config" }, 500);

    // Acumbamail API → addSubscriber (con merge fields para personalizar emails)
    const m = (user.user_metadata ?? {}) as Record<string, string>;
    const body = new URLSearchParams();
    body.set("auth_token", token);
    body.set("list_id", listId);
    body.set("merge_fields[email]", user.email);
    if (m.first_name) body.set("merge_fields[NOMBRE]", m.first_name);
    if (m.last_name) body.set("merge_fields[LASTNAME]", m.last_name);
    if (m.country) body.set("merge_fields[COUNTRY]", m.country);
    body.set("double_optin", "0");
    body.set("update_subscriber", "1");
    body.set("response_type", "json");

    const res = await fetch("https://acumbamail.com/api/1/addSubscriber/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await res.text();
    console.log("acumbamail status", res.status, "body", text);
    return json({ ok: res.ok, status: res.status, acumbamail: text });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
