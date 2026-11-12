import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import worker from "../src/worker.mjs";

const password = "Test-Admin-Password-2026!";
const salt = webcrypto.getRandomValues(new Uint8Array(16));
const passwordKey = await webcrypto.subtle.importKey(
  "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
);
const hash = Buffer.from(await webcrypto.subtle.deriveBits(
  { name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, passwordKey, 256
)).toString("hex");
const saltBase64 = Buffer.from(salt).toString("base64");
const sessions = new Map();
const attempts = new Map();
const db = {
  prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() {
        if (sql.includes("FROM admin_login_attempts")) return attempts.get(args[0]) ?? null;
        if (sql.includes("FROM admin_sessions")) return sessions.get(args[0]) ?? null;
        throw new Error("Unexpected first query: " + sql);
      },
      async run() {
        if (sql.includes("INSERT INTO admin_login_attempts")) {
          attempts.set(args[0], {
            ip_hash: args[0], window_started_at: args[1],
            attempts: args[2], blocked_until: args[3]
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("DELETE FROM admin_login_attempts")) {
          attempts.delete(args[0]);
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO admin_sessions")) {
          sessions.set(args[0], {
            session_id: args[0], token_sha256: args[1], role: "admin",
            created_at: args[2], expires_at: args[3], revoked_at: null
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE admin_sessions SET revoked_at")) {
          const row = sessions.get(args[1]);
          if (row) row.revoked_at = args[0];
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (sql.includes("UPDATE registration_requests SET status='cancelled'")) {
          return { meta: { changes: 0 } };
        }
        throw new Error("Unexpected run query: " + sql);
      },
      async all() {
        if (sql.includes("FROM registration_requests WHERE status='pending_payment'")) return { results: [] };
        if (sql.includes("FROM licenses l")) return { results: [] };
        if (sql.includes("FROM audit_log")) return { results: [] };
        throw new Error("Unexpected all query: " + sql);
      }
    };
  }
};
const env = {
  DB: db,
  ADMIN_LOGIN_EMAIL: "admin@sene.invalid",
  ADMIN_PASSWORD_HASH: hash,
  ADMIN_PASSWORD_SALT: saltBase64,
  ADMIN_SESSION_SECRET: "SENE-ADMIN-SESSION-SECRET-TEST-ONLY-0123456789"
};
const login = async (email, pass) => worker.fetch(new Request("https://sene.test/v1/admin/login", {
  method: "POST",
  headers: { "content-type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
  body: JSON.stringify({ email, password: pass })
}), env);

const bad = await login("admin@sene.invalid", "Incorrect-Password-2026!");
assert.equal(bad.status, 401, "Las credenciales incorrectas deben rechazarse");
for (let i = 0; i < 8; i++) {
  const response = await worker.fetch(new Request("https://sene.test/v1/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "192.0.2.20" },
    body: JSON.stringify({ email: "admin@sene.invalid", password: "Wrong-Password-2026!" })
  }), env);
  assert.equal(response.status, i === 7 ? 429 : 401);
}
const blocked = await worker.fetch(new Request("https://sene.test/v1/admin/login", {
  method: "POST",
  headers: { "content-type": "application/json", "CF-Connecting-IP": "192.0.2.20" },
  body: JSON.stringify({ email: "admin@sene.invalid", password })
}), env);
assert.equal(blocked.status, 429, "El bloqueo por IP debe impedir intentos de contraseña posteriores");
const good = await login("ADMIN@sene.invalid", password);
assert.equal(good.status, 200, "El correo debe normalizarse y aceptar la contraseña válida");
const session = await good.json();
assert.equal(session.tokenType, "Bearer");
assert.ok(session.accessToken.length > 80);
assert.ok(session.expiresAt > session.serverTime);

const operatorInbox = await worker.fetch(new Request("https://sene.test/v1/operator/registrations/pending", {
  method: "GET", headers: { authorization: "Bearer " + session.accessToken }
}), env);
assert.equal(operatorInbox.status, 200, "La sesión SENE ADMIN debe autorizar las bandejas del operador");
assert.deepEqual((await operatorInbox.json()).items, []);

for (const path of ["/v1/operator/licenses", "/v1/operator/audit"]) {
  const response = await worker.fetch(new Request("https://sene.test" + path, {
    method: "GET", headers: { authorization: "Bearer " + session.accessToken }
  }), env);
  assert.equal(response.status, 200, "La sesión admin debe consultar " + path);
  assert.deepEqual((await response.json()).items, []);
}

const logout = await worker.fetch(new Request("https://sene.test/v1/admin/logout", {
  method: "POST", headers: { authorization: "Bearer " + session.accessToken }
}), env);
assert.equal(logout.status, 200);
assert.equal((await logout.json()).loggedOut, true);

const replay = await worker.fetch(new Request("https://sene.test/v1/admin/logout", {
  method: "POST", headers: { authorization: "Bearer " + session.accessToken }
}), env);
assert.equal(replay.status, 401, "Una sesión revocada no debe volver a autenticarse");
console.log("PASS: inicio de sesión PBKDF2, token HMAC, sesión revocable y rechazo de replay");
