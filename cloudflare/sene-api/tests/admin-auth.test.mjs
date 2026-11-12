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
const cursors = new Map();
const acknowledgements = new Map();
const events = [];

function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") return "{" + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
const sha256 = async value => Buffer.from(await webcrypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(value)
)).toString("hex");

const db = {
  prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() {
        if (sql.includes("FROM admin_login_attempts")) return attempts.get(args[0]) ?? null;
        if (sql.includes("FROM admin_sessions")) return sessions.get(args[0]) ?? null;
        if (sql.includes("COALESCE(MAX(id),0) AS last_cursor FROM admin_event_outbox")) {
          return { last_cursor: events.length ? events[events.length - 1].id : 0 };
        }
        if (sql.includes("FROM admin_event_cursors")) {
          const value = cursors.get(args[0]);
          return value ? { last_cursor: value.last_cursor } : null;
        }
        if (sql.includes("FROM admin_event_acknowledgements WHERE ack_id=?")) {
          return acknowledgements.get(args[0]) ?? null;
        }
        if (sql.includes("FROM admin_event_acknowledgements WHERE ack_id=? OR")) {
          return [...acknowledgements.values()].find(row =>
            row.ack_id === args[0] || (row.session_id === args[1] && row.through_cursor === args[2])
          ) ?? null;
        }
        throw new Error("Unexpected first query: " + sql);
      },
      async run() {
        if (sql.includes("INSERT INTO admin_login_attempts")) {
          attempts.set(args[0], { ip_hash: args[0], window_started_at: args[1], attempts: args[2], blocked_until: args[3] });
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
        if (sql.includes("INSERT INTO admin_event_cursors")) {
          if (sql.includes("ON CONFLICT")) {
            const current = cursors.get(args[0]);
            if (!current || current.last_cursor !== args[3]) return { meta: { changes: 0 } };
            cursors.set(args[0], { last_cursor: args[1], updated_at: args[2] });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("OR IGNORE") && cursors.has(args[0])) return { meta: { changes: 0 } };
          cursors.set(args[0], { last_cursor: args[1], updated_at: args[2] });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO admin_event_acknowledgements")) {
          const row = {
            ack_id: args[0], session_id: args[1], from_cursor: args[2],
            through_cursor: args[3], delivery_id: args[4], payload_sha256: args[5],
            request_sha256: args[6], acknowledged_at: args[7]
          };
          acknowledgements.set(row.ack_id, row);
          return { meta: { changes: 1 } };
        }
        if (sql.includes("DELETE FROM admin_event_acknowledgements")) {
          const removed = acknowledgements.delete(args[0]);
          return { meta: { changes: removed ? 1 : 0 } };
        }
        if (sql.includes("UPDATE admin_event_outbox SET payload_json")) {
          let changes = 0;
          for (const event of events) {
            if (event.id <= args[0]) {
              event.payload_json = JSON.stringify({
                eventId: event.event_id, eventType: event.event_type, compacted: true
              });
              changes++;
            }
          }
          return { meta: { changes } };
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
        if (sql.includes("FROM admin_event_outbox WHERE id>? AND id<=?")) {
          return { results: events.filter(x => x.id > args[0] && x.id <= args[1]).sort((a,b)=>a.id-b.id).slice(0,101) };
        }
        if (sql.includes("FROM admin_event_outbox WHERE id>?")) {
          return { results: events.filter(x => x.id > args[0]).sort((a,b)=>a.id-b.id).slice(0,101) };
        }
        throw new Error("Unexpected all query: " + sql);
      }
    };
  },
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
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

// Simula una solicitud nueva generada después de abrir la sesión administrativa.
events.push({
  id: 1, event_id: "evt-admin-001", event_type: "registration_requested",
  license_id: null,
  payload_json: JSON.stringify({ requestId: "reg-001", businessName: "Tienda de prueba" }),
  created_at: Math.floor(Date.now() / 1000)
});
const eventResponse = await worker.fetch(new Request("https://sene.test/v1/admin/events", {
  method: "GET", headers: { authorization: "Bearer " + session.accessToken }
}), env);
assert.equal(eventResponse.status, 200);
const batch = await eventResponse.json();
assert.equal(batch.items.length, 1);
assert.equal(batch.items[0].eventId, "evt-admin-001");
const ackId = "123e4567-e89b-42d3-a456-426614174099";
const ackBody = {
  ackId, fromCursor: batch.fromCursor, throughCursor: batch.throughCursor,
  deliveryId: batch.deliveryId, payloadSha256: await sha256(canonicalJson(batch.items))
};
const ackRequest = () => new Request("https://sene.test/v1/admin/events/ack", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " + session.accessToken },
  body: JSON.stringify(ackBody)
});
const ack = await worker.fetch(ackRequest(), env);
assert.equal(ack.status, 200);
assert.equal((await ack.json()).duplicate, false);
assert.equal(JSON.parse(events[0].payload_json).compacted, true,
  "El payload solo se compacta después del ACK durable");
const ackRetry = await worker.fetch(ackRequest(), env);
assert.equal(ackRetry.status, 200);
assert.equal((await ackRetry.json()).duplicate, true);
const nextBatch = await worker.fetch(new Request("https://sene.test/v1/admin/events", {
  method: "GET", headers: { authorization: "Bearer " + session.accessToken }
}), env);
assert.equal((await nextBatch.json()).items.length, 0, "El cursor solo avanza después del ACK");

const logout = await worker.fetch(new Request("https://sene.test/v1/admin/logout", {
  method: "POST", headers: { authorization: "Bearer " + session.accessToken }
}), env);
assert.equal(logout.status, 200);
assert.equal((await logout.json()).loggedOut, true);
const replay = await worker.fetch(new Request("https://sene.test/v1/admin/logout", {
  method: "POST", headers: { authorization: "Bearer " + session.accessToken }
}), env);
assert.equal(replay.status, 401, "Una sesión revocada no debe volver a autenticarse");
console.log("PASS: login PBKDF2, rate limit, sesión revocable, bandeja durable, ACK por cursor y compactación posterior");
