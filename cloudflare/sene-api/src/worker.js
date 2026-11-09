const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (length) => {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const sha256 = async (value) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

async function requireAdmin(request, env) {
  const supplied = request.headers.get("authorization") || "";
  if (!env.ADMIN_TOKEN || supplied !== `Bearer ${env.ADMIN_TOKEN}`) return false;
  return true;
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ service: "SENE licensing API", status: "ok", version: 1 });
  }

  if (request.method === "POST" && url.pathname === "/admin/licenses") {
    if (!(await requireAdmin(request, env))) return json({ error: "unauthorized" }, 401);

    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : "";
    const licenseId = crypto.randomUUID();
    const activationCode = makeCode();
    const codeHash = await sha256(activationCode);
    const now = Math.floor(Date.now() / 1000);

    try {
      await env.DB.prepare(
        "INSERT INTO licenses (id, label, status, max_devices, activation_code_hash, created_at) VALUES (?, ?, 'pending', 3, ?, ?)"
      ).bind(licenseId, label || null, codeHash, now).run();
    } catch {
      return json({ error: "database_error" }, 503);
    }

    // El código se devuelve una sola vez. En producción se entrega manualmente
    // al cliente después de confirmar el pago; nunca se almacena en texto plano.
    return json({
      licenseId,
      activationCode,
      package: "1_PATRON_2_VENTAS",
      maxDevices: 3,
      validityDays: 30,
      status: "pending",
      note: "Guarda este código: no se puede recuperar desde el servidor."
    }, 201);
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    try {
      return await handle(request, env);
    } catch {
      return json({ error: "internal_error" }, 500);
    }
  },
};
