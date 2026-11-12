const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const hex = (bytes) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

const randomHex = (length) => {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const base64Url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const fromBase64 = (value) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

const sha256 = async (value) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

const sha256Bytes = async (value) =>
  hex(await crypto.subtle.digest("SHA-256", value));


function strictBase64(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 2048 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
}

// Android Keystore returns ECDSA signatures as ASN.1 DER; WebCrypto expects
// the fixed-width P-1363 form r||s for ECDSA verification.
function derEcdsaToP1363(der) {
  if (!(der instanceof Uint8Array) || der.length < 8 || der.length > 80 || der[0] !== 0x30) {
    return null;
  }
  let offset = 1;
  let sequenceLength = der[offset++];
  if (sequenceLength & 0x80) {
    const count = sequenceLength & 0x7f;
    if (count !== 1 || offset >= der.length) return null;
    sequenceLength = der[offset++];
  }
  if (sequenceLength !== der.length - offset || der[offset++] !== 0x02) return null;
  const rLength = der[offset++];
  if (!rLength || offset + rLength + 2 > der.length) return null;
  const r = der.slice(offset, offset + rLength);
  offset += rLength;
  if (der[offset++] !== 0x02) return null;
  const sLength = der[offset++];
  if (!sLength || offset + sLength !== der.length) return null;
  const s = der.slice(offset, offset + sLength);

  const normalize = (integer) => {
    if (integer[0] & 0x80) return null; // DER INTEGER must be positive.
    let value = integer;
    while (value.length > 1 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) return null;
    const out = new Uint8Array(32);
    out.set(value, 32 - value.length);
    return out;
  };
  const rr = normalize(r);
  const ss = normalize(s);
  if (!rr || !ss) return null;
  const result = new Uint8Array(64);
  result.set(rr, 0);
  result.set(ss, 32);
  return result;
}

async function verifySignedRequest(request, env, expectedPurpose) {
  const challengeId = request.headers.get("X-SENE-Challenge") || "";
  const signatureText = request.headers.get("X-SENE-Signature") || "";
  const deviceHeader = request.headers.get("X-SENE-Device") || "";
  if (!challengeId || !signatureText) return { ok: false, status: 401, error: "INVALID_SIGNATURE" };

  const signatureDer = strictBase64(signatureText);
  const signature = signatureDer && derEcdsaToP1363(signatureDer);
  if (!signature) return { ok: false, status: 401, error: "INVALID_SIGNATURE" };

  const bodyBytes = new Uint8Array(await request.clone().arrayBuffer());
  if (bodyBytes.length > 32768) return { ok: false, status: 413, error: "REQUEST_TOO_LARGE" };
  const bodyHash = await sha256Bytes(bodyBytes);
  const path = new URL(request.url).pathname;
  const method = request.method.toUpperCase();

  const challenge = await env.DB.prepare(
    "SELECT id, nonce, purpose, installation_id, created_at, expires_at, consumed_at, device_id, fingerprint, target_method, target_path, body_sha256, signing_message FROM challenges WHERE id = ? LIMIT 1"
  ).bind(challengeId).first();

  const now = Math.floor(Date.now() / 1000);
  if (!challenge || challenge.purpose !== expectedPurpose ||
      challenge.target_method !== method || challenge.target_path !== path ||
      challenge.body_sha256 !== bodyHash || challenge.expires_at < now ||
      challenge.consumed_at !== null) {
    return { ok: false, status: 401, error: "CHALLENGE_INVALID_OR_EXPIRED" };
  }

  let publicKeyBytes;
  let signerIdentity;
  if (challenge.device_id) {
    if (deviceHeader !== challenge.device_id) {
      return { ok: false, status: 401, error: "DEVICE_MISMATCH" };
    }
    const device = await env.DB.prepare(
      "SELECT public_key, fingerprint, status FROM devices WHERE id = ? LIMIT 1"
    ).bind(challenge.device_id).first();
    if (!device || device.status !== "active" ||
        String(device.fingerprint).toLowerCase() !== String(challenge.fingerprint).toLowerCase()) {
      return { ok: false, status: 401, error: "DEVICE_NOT_REGISTERED" };
    }
    publicKeyBytes = new Uint8Array(device.public_key);
    signerIdentity = challenge.device_id;
  } else {
    if (deviceHeader) return { ok: false, status: 401, error: "UNEXPECTED_DEVICE_HEADER" };
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bodyBytes)); } catch {
      return { ok: false, status: 400, error: "INVALID_REQUEST" };
    }
    if (body.installationId !== challenge.installation_id) {
      return { ok: false, status: 401, error: "DEVICE_MISMATCH" };
    }
    const identity = await validateBootstrapIdentity(body);
    if (!identity || identity.fingerprint !== String(challenge.fingerprint).toLowerCase()) {
      return { ok: false, status: 401, error: "INVALID_DEVICE_IDENTITY" };
    }
    publicKeyBytes = identity.publicKey;
    signerIdentity = identity.fingerprint;
  }

  const signingText = [
    "SENE-API-V1",
    challenge.purpose,
    challenge.id,
    challenge.nonce,
    challenge.target_method,
    challenge.target_path,
    challenge.body_sha256,
    signerIdentity,
  ].join("\n");
  const expectedMessage = base64Url(new TextEncoder().encode(signingText));
  if (expectedMessage !== challenge.signing_message) {
    return { ok: false, status: 401, error: "CHALLENGE_CORRUPT" };
  }

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "spki", publicKeyBytes,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
    );
    valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, signature,
      fromBase64(challenge.signing_message)
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, status: 401, error: "INVALID_SIGNATURE" };

  // Conditional write makes a valid challenge one-use even under concurrent replay.
  const consumed = await env.DB.prepare(
    "UPDATE challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at >= ?"
  ).bind(now, challengeId, now).run();
  if ((consumed.meta?.changes ?? 0) !== 1) {
    return { ok: false, status: 409, error: "CHALLENGE_ALREADY_USED" };
  }

  return { ok: true, bodyBytes, bodyText: new TextDecoder().decode(bodyBytes), challenge };
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

async function adminSessionSecretKey(env, usages) {
  if (typeof env.ADMIN_SESSION_SECRET !== "string" || env.ADMIN_SESSION_SECRET.length < 32) return null;
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.ADMIN_SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, usages
  );
}

async function issueAdminSession(email, env) {
  const now = Math.floor(Date.now() / 1000);
  const sessionId = crypto.randomUUID();
  const expiresAt = now + 12 * 60 * 60;
  const payload = { sub: "sene-admin", role: "admin", sid: sessionId, iat: now, exp: expiresAt };
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await adminSessionSecretKey(env, ["sign"]);
  if (!key) return { error: "ADMIN_AUTH_NOT_CONFIGURED" };
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded));
  const token = encoded + "." + base64Url(signature);
  const tokenHash = await sha256(token);
  // Create the revocable session and its initial event cursor atomically.
  // Start at zero; compacted payloads are filtered by the event inbox query.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO admin_sessions (session_id, token_sha256, role, created_at, expires_at, revoked_at) VALUES (?, ?, 'admin', ?, ?, NULL)"
    ).bind(sessionId, tokenHash, now, expiresAt),
    env.DB.prepare(
      "INSERT INTO admin_event_cursors (session_id,last_cursor,updated_at) VALUES (?,0,?)"
    ).bind(sessionId, now)
  ]);
  return { accessToken: token, tokenType: "Bearer", expiresAt, serverTime: now };
}

async function verifyAdminSession(request, env) {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const key = await adminSessionSecretKey(env, ["verify"]);
  if (!key) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64(parts[0])));
  } catch { return null; }
  if (!payload || payload.sub !== "sene-admin" || payload.role !== "admin" ||
      typeof payload.sid !== "string" || !Number.isSafeInteger(payload.exp) ||
      payload.exp <= Math.floor(Date.now() / 1000)) return null;
  let signature;
  try { signature = fromBase64(parts[1]); } catch { return null; }
  const valid = await crypto.subtle.verify(
    "HMAC", key, signature, new TextEncoder().encode(parts[0])
  );
  if (!valid) return null;
  const session = await env.DB.prepare(
    "SELECT token_sha256, role, expires_at, revoked_at FROM admin_sessions WHERE session_id = ? LIMIT 1"
  ).bind(payload.sid).first();
  if (!session || session.role !== "admin" || session.revoked_at !== null ||
      Number(session.expires_at) !== payload.exp ||
      !constantTimeTextEqual(session.token_sha256, await sha256(token))) return null;
  return { sessionId: payload.sid, expiresAt: payload.exp };
}

async function requireAdmin(request, env) {
  const supplied = request.headers.get("authorization") || "";
  if (env.ADMIN_TOKEN && supplied === `Bearer ${env.ADMIN_TOKEN}`) return true;
  return Boolean(await verifyAdminSession(request, env));
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + canonicalJson(value[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}

async function recordUniversalDelivery(env, ctx, stream, payload) {
  const stablePayload = { ...payload };
  delete stablePayload.serverTime;
  const payloadSha256 = await sha256(canonicalJson(stablePayload));
  const deliveryId = stream + ":" + payloadSha256.slice(0, 48);
  const cursor = Number.isSafeInteger(stablePayload.cursor) ? stablePayload.cursor : 0;
  const issuedAt = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO delivery_issued (device_id,license_id,stream,delivery_id,payload_sha256,cursor,issued_at,acknowledged_at) VALUES (?,?,?,?,?,?,?,NULL) ON CONFLICT(device_id,stream,delivery_id) DO UPDATE SET issued_at=excluded.issued_at WHERE delivery_issued.payload_sha256=excluded.payload_sha256 AND delivery_issued.cursor=excluded.cursor"
  ).bind(ctx.deviceId, ctx.licenseId, stream, deliveryId, payloadSha256, cursor, issuedAt).run();
  const issued = await env.DB.prepare(
    "SELECT payload_sha256,cursor FROM delivery_issued WHERE device_id=? AND stream=? AND delivery_id=? LIMIT 1"
  ).bind(ctx.deviceId, stream, deliveryId).first();
  if (!issued || issued.payload_sha256 !== payloadSha256 || Number(issued.cursor) !== cursor) {
    throw new Error("DELIVERY_ISSUE_CONFLICT");
  }
  return payload;
}

async function listAdminEvents(request, env) {
  const session = await verifyAdminSession(request, env);
  if (!session) return json({ error: "ADMIN_UNAUTHORIZED" }, 401);
  const now = Math.floor(Date.now() / 1000);
  // Expiration is materialized lazily when ADMIN polls its event stream.
  // The migration trigger records the transition in the durable outbox.
  await env.DB.prepare(
    "UPDATE licenses SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=?"
  ).bind(now).run();
  let cursorRow = await env.DB.prepare(
    "SELECT last_cursor FROM admin_event_cursors WHERE session_id=? LIMIT 1"
  ).bind(session.sessionId).first();
  if (!cursorRow) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO admin_event_cursors (session_id,last_cursor,updated_at) VALUES (?,0,?)"
    ).bind(session.sessionId, Math.floor(Date.now() / 1000)).run();
    cursorRow = { last_cursor: 0 };
  }
  const fromCursor = Number(cursorRow.last_cursor || 0);
  const rows = await env.DB.prepare(
    "SELECT id,event_id,event_type,license_id,payload_json,created_at FROM admin_event_outbox WHERE id>? AND json_extract(payload_json,'$.compacted') IS NULL ORDER BY id ASC LIMIT 101"
  ).bind(fromCursor).all();
  const hasMore = (rows.results || []).length > 100;
  const items = (rows.results || []).slice(0, 100).map((row) => ({
    cursor: Number(row.id), eventId: row.event_id, eventType: row.event_type,
    licenseId: row.license_id || null,
    payload: JSON.parse(row.payload_json),
    createdAt: Number(row.created_at)
  }));
  const throughCursor = items.length ? items[items.length - 1].cursor : fromCursor;
  const payloadSha256 = await sha256(canonicalJson(items));
  const stream = "ADMIN_EVENTS";
  return json({
    stream, fromCursor, throughCursor, cursor: throughCursor, items,
    payloadSha256,
    deliveryId: stream + ":" + payloadSha256.slice(0, 48),
    hasMore
  });
}

async function acknowledgeAdminEvents(request, env) {
  const session = await verifyAdminSession(request, env);
  if (!session) return json({ error: "ADMIN_UNAUTHORIZED" }, 401);
  let raw;
  let body;
  try { raw = await request.text(); body = JSON.parse(raw); } catch {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !["ackId","fromCursor","throughCursor","deliveryId","payloadSha256"].includes(key))) {
    return json({ error: "INVALID_ACK" }, 400);
  }
  const ackId = typeof body.ackId === "string" ? body.ackId.toLowerCase() : "";
  const fromCursor = body.fromCursor;
  const throughCursor = body.throughCursor;
  const payloadSha256 = typeof body.payloadSha256 === "string" ? body.payloadSha256.toLowerCase() : "";
  const deliveryId = typeof body.deliveryId === "string" ? body.deliveryId : "";
  if (!/^[0-9a-f-]{36}$/.test(ackId) ||
      !Number.isSafeInteger(fromCursor) || fromCursor < 0 ||
      !Number.isSafeInteger(throughCursor) || throughCursor <= fromCursor ||
      !/^[0-9a-f]{64}$/.test(payloadSha256) ||
      deliveryId !== "ADMIN_EVENTS:" + payloadSha256.slice(0, 48)) {
    return json({ error: "INVALID_ACK" }, 400);
  }
  const requestHash = await sha256(raw);
  const existingAck = await env.DB.prepare(
    "SELECT ack_id,session_id,from_cursor,through_cursor,payload_sha256,request_sha256,acknowledged_at FROM admin_event_acknowledgements WHERE ack_id=? LIMIT 1"
  ).bind(ackId).first();
  if (existingAck) {
    if (existingAck.session_id !== session.sessionId || existingAck.request_sha256 !== requestHash) {
      return json({ error: "ACK_ID_CONFLICT" }, 409);
    }
    return json({ acknowledged: true, duplicate: true, ackId,
      cursor: Number(existingAck.through_cursor),
      acknowledgedAt: Number(existingAck.acknowledged_at) });
  }

  const cursorRow = await env.DB.prepare(
    "SELECT last_cursor FROM admin_event_cursors WHERE session_id=? LIMIT 1"
  ).bind(session.sessionId).first();
  const currentCursor = Number(cursorRow?.last_cursor || 0);
  if (currentCursor !== fromCursor) return json({ error: "ADMIN_EVENT_CURSOR_CONFLICT", cursor: currentCursor }, 409);

  const rows = await env.DB.prepare(
    "SELECT id,event_id,event_type,license_id,payload_json,created_at FROM admin_event_outbox WHERE id>? AND id<=? AND json_extract(payload_json,'$.compacted') IS NULL ORDER BY id ASC LIMIT 101"
  ).bind(fromCursor, throughCursor).all();
  if (!rows.results?.length || rows.results.length > 100 ||
      Number(rows.results[rows.results.length - 1].id) !== throughCursor) {
    return json({ error: "ADMIN_EVENT_BATCH_INCOMPLETE" }, 409);
  }
  const items = rows.results.map((row) => ({
    cursor: Number(row.id), eventId: row.event_id, eventType: row.event_type,
    licenseId: row.license_id || null,
    payload: JSON.parse(row.payload_json),
    createdAt: Number(row.created_at)
  }));
  if (await sha256(canonicalJson(items)) !== payloadSha256) {
    return json({ error: "ADMIN_EVENT_HASH_MISMATCH" }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO admin_event_acknowledgements (ack_id,session_id,from_cursor,through_cursor,delivery_id,payload_sha256,request_sha256,acknowledged_at) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(ackId, session.sessionId, fromCursor, throughCursor, deliveryId, payloadSha256, requestHash, now),
      env.DB.prepare(
        "INSERT INTO admin_event_cursors (session_id,last_cursor,updated_at) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET last_cursor=excluded.last_cursor,updated_at=excluded.updated_at WHERE admin_event_cursors.last_cursor=?"
      ).bind(session.sessionId, throughCursor, now, fromCursor)
    ]);
    if ((results?.[0]?.meta?.changes ?? 0) !== 1) {
      const raced = await env.DB.prepare(
        "SELECT ack_id,session_id,request_sha256,through_cursor,acknowledged_at FROM admin_event_acknowledgements WHERE ack_id=? OR (session_id=? AND through_cursor=?) LIMIT 1"
      ).bind(ackId, session.sessionId, throughCursor).first();
      if (raced && raced.session_id === session.sessionId &&
          raced.request_sha256 === requestHash) {
        return json({ acknowledged: true, duplicate: true, ackId: raced.ack_id,
          cursor: Number(raced.through_cursor), acknowledgedAt: Number(raced.acknowledged_at) });
      }
      return json({ error: "ADMIN_EVENT_ACK_CONFLICT" }, 409);
    }
    if ((results?.[1]?.meta?.changes ?? 0) !== 1) {
      await env.DB.prepare("DELETE FROM admin_event_acknowledgements WHERE ack_id=?").bind(ackId).run();
      return json({ error: "ADMIN_EVENT_CURSOR_CONFLICT", cursor: fromCursor }, 409);
    }
    // Compacta el payload solo cuando todas las sesiones administrativas
    // activas ya confirmaron el evento; conserva recibo, tipo y trazabilidad.
    await env.DB.prepare(
      `UPDATE admin_event_outbox
          SET payload_json=json_object('eventId',event_id,'eventType',event_type,'compacted',1)
        WHERE id <= ?
          AND json_extract(payload_json,'$.compacted') IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM admin_sessions s
            LEFT JOIN admin_event_cursors c ON c.session_id=s.session_id
             WHERE s.revoked_at IS NULL AND s.expires_at > ?
               AND COALESCE(c.last_cursor,0) < admin_event_outbox.id
          )`
    ).bind(throughCursor, now).run();
  } catch {
    const raced = await env.DB.prepare(
      "SELECT ack_id,session_id,request_sha256,through_cursor,acknowledged_at FROM admin_event_acknowledgements WHERE ack_id=? OR (session_id=? AND through_cursor=?) LIMIT 1"
    ).bind(ackId, session.sessionId, throughCursor).first();
    if (raced && raced.session_id === session.sessionId && raced.request_sha256 === requestHash) {
      return json({ acknowledged: true, duplicate: true, ackId: raced.ack_id,
        cursor: Number(raced.through_cursor), acknowledgedAt: Number(raced.acknowledged_at) });
    }
    if (raced) return json({ error: "ADMIN_EVENT_ACK_CONFLICT" }, 409);
    return json({ error: "ADMIN_EVENT_ACK_FAILED" }, 503);
  }
  return json({ acknowledged: true, duplicate: false, ackId, cursor: throughCursor, acknowledgedAt: now });
}

async function adminLogin(request, env) {
  let body;
  try {
    if (Number(request.headers.get("content-length") || 0) > 4096) return json({ error: "INVALID_REQUEST" }, 413);
    body = await request.json();
  } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (Object.keys(body || {}).some((key) => key !== "email" && key !== "password") ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      password.length < 10 || password.length > 256) {
    return json({ error: "INVALID_CREDENTIALS" }, 401);
  }
  if (typeof env.ADMIN_LOGIN_EMAIL !== "string" ||
      typeof env.ADMIN_PASSWORD_HASH !== "string" ||
      typeof env.ADMIN_PASSWORD_SALT !== "string" ||
      typeof env.ADMIN_SESSION_SECRET !== "string") {
    return json({ error: "ADMIN_AUTH_NOT_CONFIGURED" }, 503);
  }

  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256(env.ADMIN_SESSION_SECRET + ":" + ip);
  const attempt = await env.DB.prepare(
    "SELECT window_started_at, attempts, blocked_until FROM admin_login_attempts WHERE ip_hash = ? LIMIT 1"
  ).bind(ipHash).first();
  if (attempt && Number(attempt.blocked_until || 0) > now) {
    return json({ error: "ADMIN_LOGIN_RATE_LIMITED", retryAfter: Number(attempt.blocked_until) - now }, 429);
  }

  let salt;
  try { salt = fromBase64(env.ADMIN_PASSWORD_SALT); } catch { return json({ error: "ADMIN_AUTH_NOT_CONFIGURED" }, 503); }
  if (salt.length < 16 || !/^[0-9a-f]{64}$/i.test(env.ADMIN_PASSWORD_HASH)) {
    return json({ error: "ADMIN_AUTH_NOT_CONFIGURED" }, 503);
  }
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, key, 256
  );
  const candidate = hex(derived);
  const valid = constantTimeTextEqual(email, env.ADMIN_LOGIN_EMAIL.trim().toLowerCase()) &&
    constantTimeTextEqual(candidate, env.ADMIN_PASSWORD_HASH.toLowerCase());
  if (!valid) {
    const resetWindow = !attempt || now - Number(attempt.window_started_at) >= 900;
    const windowStarted = resetWindow ? now : Number(attempt.window_started_at);
    const attempts = resetWindow ? 1 : Number(attempt.attempts || 0) + 1;
    const blockedUntil = attempts >= 8 ? now + 900 : 0;
    await env.DB.prepare(
      "INSERT INTO admin_login_attempts (ip_hash, window_started_at, attempts, blocked_until) VALUES (?, ?, ?, ?) ON CONFLICT(ip_hash) DO UPDATE SET window_started_at=excluded.window_started_at, attempts=excluded.attempts, blocked_until=excluded.blocked_until"
    ).bind(ipHash, windowStarted, attempts, blockedUntil).run();
    return json({ error: blockedUntil ? "ADMIN_LOGIN_RATE_LIMITED" : "INVALID_CREDENTIALS" }, blockedUntil ? 429 : 401);
  }
  await env.DB.prepare("DELETE FROM admin_login_attempts WHERE ip_hash = ?").bind(ipHash).run();
  try {
    const session = await issueAdminSession(email, env);
    if (session.error) return json(session, 503);
    return json(session);
  } catch {
    return json({ error: "ADMIN_SESSION_CREATE_FAILED" }, 503);
  }
}

async function adminLogout(request, env) {
  const session = await verifyAdminSession(request, env);
  if (!session) return json({ error: "ADMIN_UNAUTHORIZED" }, 401);
  await env.DB.prepare(
    "UPDATE admin_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL"
  ).bind(Math.floor(Date.now() / 1000), session.sessionId).run();
  return json({ loggedOut: true });
}

const CHALLENGE_TARGETS = {
  PATRON_ACTIVATE: ["POST", "/v1/patron/activate"],
  PATRON_REGISTRATION_REQUEST: ["POST", "/v1/patron/registrations/request"],
  PATRON_RECOVERY_REQUEST: ["POST", "/v1/patron/recovery/request"],
  PATRON_RECOVERY: ["POST", "/v1/patron/recover"],
  PATRON_RESTORE: ["POST", "/v1/patron/restore"],
  VENTAS_PAIR: ["POST", "/v1/ventas/pair"],
  VENTAS_RESTORE: ["POST", "/v1/ventas/restore"],
  DEVICE_AUTH: ["POST", "/v1/device/session"],
  PATRON_PAIRING_TOKEN: ["POST", "/v1/patron/pairing-tokens"],
  VENTAS_REQUEST: ["POST", "/v1/ventas/requests"],
  PATRON_REQUESTS_INBOX: ["POST", "/v1/patron/requests/inbox"],
  PATRON_NOTIFICATIONS: ["POST", "/v1/patron/notifications"],
  PATRON_DEVICES_LIST: ["POST", "/v1/patron/devices/list"],
  PATRON_PAYROLL_SETTINGS_GET: ["POST", "/v1/patron/payroll/settings/get"],
  VENTAS_PAYROLL_SETTINGS_GET: ["POST", "/v1/ventas/payroll/settings/get"],
  PATRON_PAYROLL_SETTINGS_SET: ["POST", "/v1/patron/payroll/settings/set"],
  PATRON_REQUEST_DECISION: ["POST", "/v1/patron/requests/decision"],
  VENTAS_REQUEST_UPDATES: ["POST", "/v1/ventas/requests/updates"],
  VENTAS_REQUEST_HISTORY: ["POST", "/v1/ventas/requests/history"],
  VENTAS_SHIFT_REPORT: ["POST", "/v1/ventas/shift-reports"],
  VENTAS_PAYROLL_REPORT: ["POST", "/v1/ventas/payroll-reports"],
  PATRON_REPORTS_INBOX: ["POST", "/v1/patron/reports/inbox"],
  VENTAS_DAILY_INVENTORY: ["POST", "/v1/ventas/inventory/daily"],
  PATRON_PAYDAY_BUNDLE: ["POST", "/v1/patron/payday/bundle"],
  PATRON_PAYDAY_ACK: ["POST", "/v1/patron/payday/ack"],
  DELIVERY_ACK: ["POST", "/v1/deliveries/ack"],
  PATRON_RENEWAL_REQUEST: ["POST", "/v1/patron/renewals/request"],
  PATRON_RENEWAL_REDEEM: ["POST", "/v1/patron/renewals/redeem"],
  PATRON_REPLACEMENT_REQUEST: ["POST", "/v1/patron/devices/replacement-request"],
  PATRON_REPLACEMENT_REDEEM: ["POST", "/v1/patron/devices/replacement-redeem"],
  VENTAS_CORRECTION_CREATE: ["POST", "/v1/ventas/corrections"],
  PATRON_CORRECTIONS_INBOX: ["POST", "/v1/patron/corrections/inbox"],
  PATRON_CORRECTION_DECISION: ["POST", "/v1/patron/corrections/decision"],
  VENTAS_CORRECTION_CONSUME: ["POST", "/v1/ventas/corrections/consume"],
};

async function validateBootstrapIdentity(body) {
  const installationId = typeof body.installationId === "string" ? body.installationId : "";
  const continuityId = typeof body.continuityId === "string" ? body.continuityId.toLowerCase() : "";
  const publicKeyBase64 = typeof body.publicKeyBase64 === "string" ? body.publicKeyBase64 : "";
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.toLowerCase() : "";

  if (!/^[0-9a-f-]{36}$/i.test(installationId) ||
      !/^[0-9a-f]{64}$/.test(continuityId) ||
      !/^[0-9a-f]{64}$/.test(fingerprint) ||
      publicKeyBase64.length < 80 || publicKeyBase64.length > 1024) {
    return null;
  }

  try {
    const publicKey = fromBase64(publicKeyBase64);
    const actualFingerprint = await sha256Bytes(publicKey);
    if (actualFingerprint !== fingerprint) return null;

    // Importing the SPKI key also rejects malformed or non-P-256 public keys.
    await crypto.subtle.importKey(
      "spki",
      publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    return { installationId, continuityId, fingerprint, publicKey };
  } catch {
    return null;
  }
}

async function issueChallenge(request, env) {
  let body;
  try {
    if (Number(request.headers.get("content-length") || 0) > 8192) {
      return json({ error: "INVALID_REQUEST" }, 413);
    }
    body = await request.json();
  } catch {
    return json({ error: "INVALID_REQUEST" }, 400);
  }

  const purpose = typeof body.purpose === "string" ? body.purpose : "";
  const target = CHALLENGE_TARGETS[purpose];
  const method = typeof body.targetMethod === "string" ? body.targetMethod.toUpperCase() : "";
  const path = typeof body.targetPath === "string" ? body.targetPath : "";
  const bodyHash = typeof body.bodySha256 === "string" ? body.bodySha256.toLowerCase() : "";

  if (!target || method !== target[0] || path !== target[1] || !/^[0-9a-f]{64}$/.test(bodyHash)) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }

  let installationId = "";
  let fingerprint = "";
  let deviceId = null;

  if (purpose === "PATRON_ACTIVATE" || purpose === "PATRON_REGISTRATION_REQUEST" || purpose === "PATRON_RECOVERY_REQUEST" || purpose === "PATRON_RESTORE" || purpose === "VENTAS_PAIR" || purpose === "VENTAS_RESTORE" || purpose === "PATRON_RECOVERY") {
    const identity = await validateBootstrapIdentity(body);
    if (!identity) return json({ error: "INVALID_DEVICE_IDENTITY" }, 400);
    installationId = identity.installationId;
    fingerprint = identity.fingerprint;
  } else {
    deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    if (!deviceId) return json({ error: "INVALID_REQUEST" }, 400);

    const device = await env.DB.prepare(
      "SELECT id, installation_id, fingerprint, status FROM devices WHERE id = ? LIMIT 1"
    ).bind(deviceId).first();

    if (!device || device.status !== "active") {
      return json({ error: "DEVICE_NOT_REGISTERED" }, 401);
    }
    installationId = device.installation_id;
    fingerprint = device.fingerprint.toLowerCase();
  }

  const challengeId = crypto.randomUUID();
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = base64Url(nonceBytes);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 120;
  const signerIdentity = deviceId || fingerprint;

  // The client signs these exact UTF-8 bytes after Base64URL decoding.
  // Including method, path and body hash prevents replaying the proof for
  // a different endpoint or payload.
  const signingText = [
    "SENE-API-V1",
    purpose,
    challengeId,
    nonce,
    method,
    path,
    bodyHash,
    signerIdentity,
  ].join("\n");
  const signingMessage = base64Url(new TextEncoder().encode(signingText));

  try {
    await env.DB.prepare(
      `INSERT INTO challenges
       (id, nonce, purpose, installation_id, created_at, expires_at,
        device_id, fingerprint, target_method, target_path, body_sha256, signing_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      challengeId, nonce, purpose, installationId, now, expiresAt,
      deviceId, fingerprint, method, path, bodyHash, signingMessage
    ).run();
  } catch {
    return json({ error: "SERVICE_UNAVAILABLE" }, 503);
  }

  return json({ challengeId, challenge: nonce, signingMessage, expiresAt }, 201);
}


function mexicoCityIsoWeek(unixSeconds) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(unixSeconds * 1000));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const localDate = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  const weekday = localDate.getUTCDay() || 7;
  localDate.setUTCDate(localDate.getUTCDate() + 4 - weekday);
  const year = localDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((localDate - yearStart) / 86400000) + 1) / 7);
  return `${year}-${String(week).padStart(2, "0")}`;
}

async function consumeWeeklyQuota(env, deviceId) {
  const now = Math.floor(Date.now() / 1000);
  const weekKey = mexicoCityIsoWeek(now);
  try {
    const quota = await env.DB.prepare(
      `INSERT INTO weekly_usage (id, device_id, week_key, used, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(device_id, week_key) DO UPDATE
         SET used = weekly_usage.used + 1, updated_at = excluded.updated_at
       WHERE weekly_usage.used < 20
       RETURNING used`
    ).bind(crypto.randomUUID(), deviceId, weekKey, now).first();
    return quota ? null : { error: "WEEKLY_QUOTA_EXCEEDED", status: 429 };
  } catch {
    return { error: "QUOTA_CHECK_UNAVAILABLE", status: 503 };
  }
}

async function activatePatron(request, env) {
  const proof = await verifySignedRequest(request, env, "PATRON_ACTIVATE");
  if (!proof.ok) return json({ error: proof.error }, proof.status);

  let body;
  try { body = JSON.parse(proof.bodyText); } catch {
    return json({ error: "INVALID_REQUEST" }, 400);
  }

  const activationCode = typeof body.activationCode === "string"
    ? body.activationCode.trim().toUpperCase() : "";
  const identity = await validateBootstrapIdentity(body);
  if (!identity || !/^[A-HJ-NP-Z2-9]{12}$/.test(activationCode) ||
      identity.installationId !== proof.challenge.installation_id ||
      identity.fingerprint !== String(proof.challenge.fingerprint).toLowerCase()) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }

  const codeHash = await sha256(activationCode);
  const registration = await env.DB.prepare(
    "SELECT id,license_id,installation_id,fingerprint,status FROM registration_requests WHERE code_hash=? LIMIT 1"
  ).bind(codeHash).first();
  if (registration && (registration.status !== "authorized" ||
      registration.installation_id !== identity.installationId ||
      registration.fingerprint !== identity.fingerprint)) {
    return json({ error: "ACTIVATION_CODE_DEVICE_MISMATCH" }, 409);
  }
  const deviceId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // The insert and one-time code consumption run in one D1 batch transaction.
  // A unique slot/fingerprint constraint prevents two concurrent activations.
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO devices
         (id, license_id, device_type, installation_id, continuity_id,
          public_key, fingerprint, slot_number, status, created_at)
         SELECT ?, l.id, 'PATRON', ?, ?, ?, ?, 1, 'active', ?
           FROM licenses l
          WHERE l.activation_code_hash = ?
            AND l.setup_paid_at IS NOT NULL
            AND l.first_rent_paid_at IS NOT NULL
            AND l.status = 'pending'
            AND (NOT EXISTS (SELECT 1 FROM registration_requests rr WHERE rr.license_id = l.id)
              OR EXISTS (SELECT 1 FROM registration_requests rr WHERE rr.license_id = l.id
                AND rr.code_hash = ? AND rr.installation_id = ? AND rr.fingerprint = ? AND rr.status = 'authorized'))
            AND NOT EXISTS (
              SELECT 1 FROM devices d
               WHERE d.license_id = l.id AND d.slot_number = 1
                 AND d.status = 'active'
            )`
      ).bind(
        deviceId, identity.installationId, body.continuityId.toLowerCase(),
        identity.publicKey, identity.fingerprint, now, codeHash,
        codeHash, identity.installationId, identity.fingerprint
      ),
      env.DB.prepare(
        `UPDATE licenses
            SET activation_code_hash = NULL
          WHERE activation_code_hash = ?
            AND setup_paid_at IS NOT NULL
            AND first_rent_paid_at IS NOT NULL
            AND status = 'pending'
            AND EXISTS (
              SELECT 1 FROM devices d
               WHERE d.id = ? AND d.license_id = licenses.id
            )`
      ).bind(codeHash, deviceId),
      env.DB.prepare(
        `UPDATE licenses
            SET status = 'active', activated_at = COALESCE(activated_at, ?), expires_at = ?
          WHERE id = (SELECT license_id FROM devices WHERE id = ?)
            AND status = 'pending' AND setup_paid_at IS NOT NULL AND first_rent_paid_at IS NOT NULL`
      ).bind(now, now + 30 * 86400, deviceId),
      env.DB.prepare(
        "UPDATE registration_requests SET status='consumed',consumed_at=? WHERE code_hash=? AND license_id=(SELECT license_id FROM devices WHERE id=?) AND status='authorized'"
      ).bind(now,codeHash,deviceId)
    ]);

    if ((results?.[0]?.meta?.changes ?? 0) !== 1 ||
        (results?.[1]?.meta?.changes ?? 0) !== 1 ||
        (results?.[2]?.meta?.changes ?? 0) !== 1 ||
        (registration && (results?.[3]?.meta?.changes ?? 0) !== 1)) {
      return json({ error: "ACTIVATION_CODE_INVALID" }, 409);
    }
  } catch {
    return json({ error: "ACTIVATION_CONFLICT_OR_DATABASE_ERROR" }, 409);
  }

  const activated = await env.DB.prepare(
    "SELECT status, expires_at FROM licenses WHERE id = (SELECT license_id FROM devices WHERE id = ?) LIMIT 1"
  ).bind(deviceId).first();
  return json({
    deviceId,
    slot: "PATRON",
    licenseStatus: activated?.status === "active" ? "ACTIVE" : "PENDING_PAYMENT",
    periodEndsAt: activated?.expires_at ?? null
  }, 201);
}

async function recoverPatron(request, env) {
  const proof = await verifySignedRequest(request, env, "PATRON_RECOVERY");
  if (!proof.ok) return json({ error: proof.error }, proof.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const code = typeof body.recoveryCode === "string" ? body.recoveryCode.trim().toUpperCase() : "";
  const identity = await validateBootstrapIdentity(body);
  if (!identity || !/^[A-HJ-NP-Z2-9]{12}$/.test(code) ||
      identity.installationId !== proof.challenge.installation_id ||
      identity.fingerprint !== String(proof.challenge.fingerprint).toLowerCase()) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const codeHash = await sha256(code);
  const recovery = await env.DB.prepare(
    "SELECT r.id, r.license_id, r.old_patron_device_id, l.status AS license_status, l.expires_at, p.installation_id AS recovery_installation_id, p.fingerprint AS recovery_fingerprint, p.status AS payment_status FROM patron_recovery_requests r JOIN licenses l ON l.id = r.license_id LEFT JOIN patron_recovery_payment_requests p ON p.code_hash = r.code_hash WHERE r.code_hash = ? AND r.status = 'pending' LIMIT 1"
  ).bind(codeHash).first();
  if (!recovery || !["active", "expired"].includes(recovery.license_status)) {
    return json({ error: "RECOVERY_CODE_INVALID_OR_USED" }, 409);
  }
  // Toda reposición de PATRÓN requiere pago validado y queda ligada al teléfono
  // que creó la solicitud; no se aceptan códigos manuales que omitan los $500 MXN.
  const paidRecovery = recovery.payment_status === "authorized";
  if (!paidRecovery ||
      recovery.recovery_installation_id !== identity.installationId ||
      String(recovery.recovery_fingerprint).toLowerCase() !== identity.fingerprint) {
    return json({ error: "RECOVERY_DEVICE_MISMATCH_OR_PAYMENT_REQUIRED" }, 409);
  }
  const oldPatron = await env.DB.prepare(
    "SELECT id FROM devices WHERE id = ? AND license_id = ? AND device_type = 'PATRON' AND slot_number = 1 AND status = 'active' LIMIT 1"
  ).bind(recovery.old_patron_device_id, recovery.license_id).first();
  if (!oldPatron) return json({ error: "PATRON_RECOVERY_CONFLICT" }, 409);

  const newDeviceId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  let results;
  try {
    results = await env.DB.batch([
      // Claim the pending request only while the original PATRÓN is still active.
      // D1 batch statements are transactional, but a successful UPDATE with 0 changes
      // does not abort later statements; the processing state gates every side effect.
      env.DB.prepare(
        "UPDATE patron_recovery_requests SET status = 'cancelled', consumed_at = ? WHERE id = ? AND code_hash = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM devices WHERE id = patron_recovery_requests.old_patron_device_id AND license_id = patron_recovery_requests.license_id AND device_type = 'PATRON' AND slot_number = 1 AND status = 'active')"
      ).bind(now, recovery.id, codeHash),
      env.DB.prepare(
        "UPDATE devices SET status = 'revoked' WHERE id = ? AND license_id = ? AND device_type = 'PATRON' AND slot_number = 1 AND status = 'active' AND EXISTS (SELECT 1 FROM patron_recovery_requests WHERE id = ? AND code_hash = ? AND status = 'cancelled' AND consumed_at = ?)"
      ).bind(recovery.old_patron_device_id, recovery.license_id, recovery.id, codeHash, now),
      env.DB.prepare(
        "UPDATE pairing_tokens SET revoked_at = ? WHERE license_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND status = 'revoked') AND EXISTS (SELECT 1 FROM patron_recovery_requests WHERE id = ? AND code_hash = ? AND status = 'cancelled' AND consumed_at = ?)"
      ).bind(now, recovery.license_id, recovery.old_patron_device_id, recovery.id, codeHash, now),
      env.DB.prepare(
        "INSERT INTO devices (id, license_id, device_type, installation_id, continuity_id, public_key, fingerprint, slot_number, status, created_at) SELECT ?, r.license_id, 'PATRON', ?, ?, ?, ?, 1, 'active', ? FROM patron_recovery_requests r JOIN licenses l ON l.id = r.license_id JOIN devices old ON old.id = r.old_patron_device_id WHERE r.id = ? AND r.code_hash = ? AND r.status = 'cancelled' AND r.consumed_at = ? AND old.status = 'revoked' AND l.status IN ('active','expired') AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.license_id = r.license_id AND d.slot_number = 1 AND d.status = 'active')"
      ).bind(newDeviceId, identity.installationId, body.continuityId.toLowerCase(), identity.publicKey, identity.fingerprint, now, recovery.id, codeHash, now),
      // Conserva cualquier solicitud de mensualidad abierta y su código pagado,
      // trasladándolos al nuevo dispositivo PATRÓN dentro de la misma transacción.
      env.DB.prepare(
        "UPDATE renewal_requests SET patron_device_id = ? WHERE license_id = ? AND patron_device_id = ? AND status IN ('pending_payment','authorized') AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND status = 'active')"
      ).bind(newDeviceId, recovery.license_id, recovery.old_patron_device_id, newDeviceId),
      env.DB.prepare(
        "UPDATE patron_recovery_requests SET status = 'consumed', consumed_at = ? WHERE id = ? AND code_hash = ? AND status = 'cancelled' AND consumed_at = ? AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND license_id = patron_recovery_requests.license_id AND device_type = 'PATRON' AND status = 'active')"
      ).bind(now, recovery.id, codeHash, newDeviceId, now),
      env.DB.prepare(
        "INSERT INTO audit_log (id, license_id, device_id, actor_type, actor_id, event_type, details_json, created_at) SELECT ?, ?, ?, 'system', 'patron_recovery', 'patron_device_recovered', ?, ? WHERE EXISTS (SELECT 1 FROM patron_recovery_requests WHERE id = ? AND status = 'consumed' AND consumed_at = ?) AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND status = 'active')"
      ).bind(crypto.randomUUID(), recovery.license_id, newDeviceId, JSON.stringify({ recoveryRequestId: recovery.id, oldDeviceId: recovery.old_patron_device_id }), now, recovery.id, now, newDeviceId),
      env.DB.prepare(
        "UPDATE patron_recovery_payment_requests SET status = 'consumed', consumed_at = ? WHERE code_hash = ? AND status = 'authorized' AND EXISTS (SELECT 1 FROM patron_recovery_requests WHERE id = ? AND status = 'consumed' AND code_hash = ?)"
      ).bind(now, codeHash, recovery.id, codeHash)
    ]);
  } catch {
    return json({ error: "PATRON_RECOVERY_CONFLICT" }, 409);
  }
  if ([0, 1, 3, 5, 6].some((index) => (results?.[index]?.meta?.changes ?? 0) !== 1) ||
      (paidRecovery && (results?.[7]?.meta?.changes ?? 0) !== 1)) {
    return json({ error: "PATRON_RECOVERY_CONFLICT" }, 409);
  }
  return json({
    deviceId: newDeviceId,
    slot: "PATRON",
    licenseStatus: recovery.license_status !== "active" || !recovery.expires_at || recovery.expires_at <= now ? "EXPIRED" : "ACTIVE",
    periodEndsAt: recovery.expires_at ?? null,
    recovered: true
  }, 201);
}

async function restorePatron(request, env) {
  const proof = await verifySignedRequest(request, env, "PATRON_RESTORE");
  if (!proof.ok) return json({ error: proof.error }, proof.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const businessName = typeof body.businessName === "string" ? body.businessName.trim().replace(/\s+/g, " ") : "";
  const email = typeof body.registeredEmail === "string" ? body.registeredEmail.trim().toLowerCase() : "";
  const phone = typeof body.registeredPhone === "string" ? body.registeredPhone.replace(/\D/g, "") : "";
  const identity = await validateBootstrapIdentity(body);
  if (!identity || !businessName || businessName.length > 100 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phone.length < 10 || phone.length > 15 ||
      Object.keys(body).some((key) => !["businessName", "registeredEmail", "registeredPhone", "installationId", "continuityId", "publicKeyBase64", "fingerprint"].includes(key)) ||
      identity.installationId !== proof.challenge.installation_id ||
      identity.fingerprint !== String(proof.challenge.fingerprint).toLowerCase()) {
    return json({ error: "INVALID_RESTORE_DETAILS" }, 400);
  }
  const normalized = businessName.normalize("NFKC").toLocaleLowerCase("es-MX");
  const license = await env.DB.prepare(
    "SELECT id,business_name,status,expires_at FROM licenses WHERE lower(trim(business_name))=lower(trim(?)) AND lower(trim(registered_email))=? AND registered_phone=? AND status IN ('active','expired') LIMIT 1"
  ).bind(businessName, email, phone).first();
  if (!license || license.business_name.normalize("NFKC").toLocaleLowerCase("es-MX") !== normalized) {
    return json({ error: "REGISTERED_DETAILS_NOT_MATCH" }, 404);
  }
  const oldPatron = await env.DB.prepare(
    "SELECT id FROM devices WHERE license_id=? AND device_type='PATRON' AND slot_number=1 AND status='active' AND continuity_id=? LIMIT 1"
  ).bind(license.id, identity.continuityId).first();
  if (!oldPatron) return json({ error: "SAME_PHONE_NOT_VERIFIED" }, 409);
  const pendingRecovery = await env.DB.prepare(
    "SELECT id FROM patron_recovery_payment_requests WHERE license_id=? AND status IN ('pending_payment','authorized') LIMIT 1"
  ).bind(license.id).first();
  if (pendingRecovery) return json({ error: "PAID_RECOVERY_REQUEST_PENDING" }, 409);

  const newDeviceId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE devices SET status='revoked' WHERE id=? AND license_id=? AND device_type='PATRON' AND slot_number=1 AND status='active' AND continuity_id=? AND EXISTS (SELECT 1 FROM licenses WHERE id=? AND status IN ('active','expired')) AND NOT EXISTS (SELECT 1 FROM patron_recovery_payment_requests WHERE license_id=? AND status IN ('pending_payment','authorized'))"
      ).bind(oldPatron.id, license.id, identity.continuityId, license.id, license.id),
      env.DB.prepare(
        "UPDATE pairing_tokens SET revoked_at=? WHERE license_id=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM devices WHERE id=? AND status='revoked')"
      ).bind(now, license.id, oldPatron.id),
      env.DB.prepare(
        "INSERT INTO devices (id,license_id,device_type,installation_id,continuity_id,public_key,fingerprint,slot_number,status,created_at) SELECT ?,?,?,?,?,?, ?,1,'active',? FROM devices old WHERE old.id=? AND old.license_id=? AND old.status='revoked' AND old.continuity_id=? AND EXISTS (SELECT 1 FROM licenses WHERE id=? AND status IN ('active','expired')) AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.license_id=old.license_id AND d.slot_number=1 AND d.status='active')"
      ).bind(newDeviceId, license.id, "PATRON", identity.installationId, identity.continuityId, identity.publicKey, identity.fingerprint, now, oldPatron.id, license.id, identity.continuityId, license.id),
      env.DB.prepare(
        "UPDATE renewal_requests SET patron_device_id=? WHERE license_id=? AND patron_device_id=? AND status IN ('pending_payment','authorized') AND EXISTS (SELECT 1 FROM devices WHERE id=? AND status='active')"
      ).bind(newDeviceId, license.id, oldPatron.id, newDeviceId),
      env.DB.prepare(
        "INSERT INTO audit_log (id,license_id,device_id,actor_type,actor_id,event_type,details_json,created_at) SELECT ?,?,?, 'system','patron_restore','patron_device_restored',?,? WHERE EXISTS (SELECT 1 FROM devices WHERE id=? AND status='active')"
      ).bind(crypto.randomUUID(), license.id, newDeviceId, JSON.stringify({ oldDeviceId: oldPatron.id, samePhone: true }), now, newDeviceId)
    ]);
  } catch {
    return json({ error: "PATRON_RESTORE_CONFLICT" }, 409);
  }
  if ([0, 2, 4].some((index) => (results?.[index]?.meta?.changes ?? 0) !== 1)) {
    return json({ error: "PATRON_RESTORE_CONFLICT" }, 409);
  }
  return json({
    deviceId: newDeviceId,
    slot: "PATRON",
    licenseStatus: license.status === "active" && Number(license.expires_at || 0) > now ? "ACTIVE" : "EXPIRED",
    periodEndsAt: license.expires_at ?? null,
    restored: true
  }, 201);
}

async function createPatronRecovery(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  return json({
    error: "PAID_RECOVERY_REQUIRED",
    message: "La reposición de SENE PATRÓN requiere una solicitud pagada de $500 MXN creada desde la aplicación y verificada por AYUDA."
  }, 410);
}

async function listPatronRecoveries(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  const rows = await env.DB.prepare(
    "SELECT r.id, r.license_id, l.business_name, r.old_patron_device_id, r.reason, r.created_at FROM patron_recovery_requests r JOIN licenses l ON l.id = r.license_id WHERE r.status = 'pending' ORDER BY r.created_at ASC LIMIT 100"
  ).all();
  return json({ items: rows.results || [] });
}

async function reissuePatronRecoveryCode(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const requestId = typeof body.recoveryRequestId === "string" ? body.recoveryRequestId : "";
  const deliveryPhone = typeof body.deliveryPhone === "string" ? body.deliveryPhone.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !deliveryPhone) return json({ error: "INVALID_REQUEST" }, 400);
  if (!(await requireOfficialHelpRecipient(env, deliveryPhone))) return json({ error: "UNOFFICIAL_CODE_RECIPIENT" }, 403);
  const existing = await env.DB.prepare(
    "SELECT code_hash FROM patron_recovery_requests WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM devices WHERE id = patron_recovery_requests.old_patron_device_id AND status = 'active') LIMIT 1"
  ).bind(requestId).first();
  if (!existing?.code_hash) return json({ error: "PATRON_RECOVERY_NOT_REISSUABLE" }, 409);
  const paidRequest = await env.DB.prepare(
    "SELECT id FROM patron_recovery_payment_requests WHERE code_hash = ? AND status = 'authorized' LIMIT 1"
  ).bind(existing.code_hash).first();
  if (!paidRequest) return json({ error: "PAID_RECOVERY_REQUIRED" }, 409);
  const code = makeCode();
  const codeHash = await sha256(code);
  let encryptedCode;
  try { encryptedCode = await encryptPairingToken(code, env); }
  catch { return json({ error: "PATRON_RECOVERY_CODE_ENCRYPTION_NOT_CONFIGURED" }, 503); }
  const now = Math.floor(Date.now() / 1000);
  const statements = [
    env.DB.prepare(
      "UPDATE patron_recovery_requests SET code_hash = ? WHERE id = ? AND status = 'pending' AND code_hash = ? AND EXISTS (SELECT 1 FROM devices WHERE id = patron_recovery_requests.old_patron_device_id AND status = 'active')"
    ).bind(codeHash, requestId, existing.code_hash)
  ];
  if (paidRequest) {
    statements.push(env.DB.prepare(
      "UPDATE patron_recovery_payment_requests SET code_hash = ?, encrypted_code = ? WHERE id = ? AND code_hash = ? AND status = 'authorized'"
    ).bind(codeHash, encryptedCode, paidRequest.id, existing.code_hash));
  }
  statements.push(env.DB.prepare(
    "INSERT INTO audit_log (id, license_id, device_id, actor_type, actor_id, event_type, details_json, created_at) SELECT ?, license_id, old_patron_device_id, 'operator', 'operator', 'patron_recovery_code_reissued', ?, ? FROM patron_recovery_requests WHERE id = ? AND status = 'pending' AND code_hash = ?"
  ).bind(crypto.randomUUID(), JSON.stringify({ recoveryRequestId: requestId, paidRecovery: Boolean(paidRequest) }), now, requestId, codeHash));
  let results;
  try {
    results = await env.DB.batch(statements);
  } catch {
    return json({ error: "PATRON_RECOVERY_NOT_REISSUABLE" }, 409);
  }
  if ((results?.[0]?.meta?.changes ?? 0) !== 1 ||
      (paidRequest && (results?.[1]?.meta?.changes ?? 0) !== 1) ||
      (results?.[results.length - 1]?.meta?.changes ?? 0) !== 1) {
    return json({ error: "PATRON_RECOVERY_NOT_REISSUABLE" }, 409);
  }
  return json({ recoveryRequestId: requestId, recoveryCode: code, expiresAt: null, note: "Código anterior invalidado; el nuevo es de un solo uso." }, 200);
}

async function cancelPatronRecovery(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const requestId = typeof body.recoveryRequestId === "string" ? body.recoveryRequestId : "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return json({ error: "INVALID_REQUEST" }, 400);
  const now = Math.floor(Date.now() / 1000);
  try {
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE patron_recovery_requests SET status = 'cancelled' WHERE id = ? AND status = 'pending'").bind(requestId),
      env.DB.prepare(
        "INSERT INTO audit_log (id, license_id, actor_type, actor_id, event_type, details_json, created_at) SELECT ?, license_id, 'operator', 'operator', 'patron_recovery_cancelled', ?, ? FROM patron_recovery_requests WHERE id = ? AND status = 'cancelled'"
      ).bind(crypto.randomUUID(), JSON.stringify({ recoveryRequestId: requestId }), now, requestId)
    ]);
    if ((results?.[0]?.meta?.changes ?? 0) !== 1 || (results?.[1]?.meta?.changes ?? 0) !== 1) {
      return json({ error: "PATRON_RECOVERY_NOT_PENDING" }, 409);
    }
  } catch {
    return json({ error: "PATRON_RECOVERY_NOT_PENDING" }, 409);
  }
  return json({ recoveryRequestId: requestId, status: "cancelled" });
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function pairingEncryptionKey(env) {
  const raw = typeof env.PAIRING_TOKEN_ENCRYPTION_KEY === "string"
    ? env.PAIRING_TOKEN_ENCRYPTION_KEY.trim() : "";
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error("PAIRING_ENCRYPTION_KEY_NOT_CONFIGURED");
  const bytes = Uint8Array.from(raw.match(/../g), (part) => parseInt(part, 16));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptPairingToken(token, env) {
  const key = await pairingEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array([...iv, ...new Uint8Array(encrypted)]));
}

async function decryptPairingToken(value, env) {
  const key = await pairingEncryptionKey(env);
  const packed = base64UrlToBytes(value);
  if (packed.length < 29) throw new Error("INVALID_ENCRYPTED_PAIRING_TOKEN");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: packed.slice(0, 12) }, key, packed.slice(12)
  );
  return new TextDecoder().decode(plain);
}

async function createPairingToken(request, env) {
  const proof = await verifySignedRequest(request, env, "PATRON_PAIRING_TOKEN");
  if (!proof.ok) return json({ error: proof.error }, proof.status);

  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const slot = body?.slot;
  const operation = body?.operation || "NEW";
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !["slot", "operation"].includes(key)) ||
      !["VENTAS_1", "VENTAS_2"].includes(slot) || !["NEW", "REPLACEMENT"].includes(operation)) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }

  const patron = await env.DB.prepare(
    `SELECT d.id, d.license_id, l.status AS license_status, l.expires_at
       FROM devices d JOIN licenses l ON l.id = d.license_id
      WHERE d.id = ? AND d.device_type = 'PATRON' AND d.slot_number = 1
        AND d.status = 'active' LIMIT 1`
  ).bind(proof.challenge.device_id).first();
  const now = Math.floor(Date.now() / 1000);
  if (!patron) return json({ error: "DEVICE_NOT_REGISTERED" }, 401);
  if (patron.license_status !== "active" || !patron.expires_at || patron.expires_at <= now) {
    return json({ error: "LICENSE_EXPIRED" }, 403);
  }
  const slotNumber = slot === "VENTAS_1" ? 2 : 3;
  const occupied = await env.DB.prepare(
    "SELECT id FROM devices WHERE license_id = ? AND slot_number = ? AND status = 'active' LIMIT 1"
  ).bind(patron.license_id, slotNumber).first();
  if (occupied) return json({ error: "EQUIPMENT_SLOT_ALREADY_LINKED" }, 409);
  if (operation === "REPLACEMENT") {
    const approved = await env.DB.prepare(
      "SELECT id FROM replacement_requests WHERE license_id = ? AND slot_number = ? AND status = 'approved' ORDER BY decided_at DESC LIMIT 1"
    ).bind(patron.license_id, slotNumber).first();
    if (!approved) return json({ error: "REPLACEMENT_NOT_AUTHORIZED" }, 403);
  }

  // Return the same still-pending QR after app restarts; never mint duplicates.
  const pending = await env.DB.prepare(
    `SELECT token_hash, encrypted_token, created_at FROM pairing_tokens
      WHERE license_id = ? AND patron_device_id = ? AND slot_number = ?
        AND operation = ? AND remaining_uses = 1 AND revoked_at IS NULL
        AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`
  ).bind(patron.license_id, patron.id, slotNumber, operation).first();
  if (pending?.encrypted_token) {
    try {
      const token = await decryptPairingToken(pending.encrypted_token, env);
      return json({ qrPayload: `SENEPAIR2:${token}`, slot, remainingUses: 1,
        createdAt: pending.created_at, expiresAt: null, recovered: true });
    } catch {
      return json({ error: "PAIRING_TOKEN_RECOVERY_FAILED" }, 503);
    }
  }

  let token, encryptedToken;
  try {
    token = randomHex(32);
    encryptedToken = await encryptPairingToken(token, env);
  } catch {
    return json({ error: "PAIRING_ENCRYPTION_NOT_CONFIGURED" }, 503);
  }
  const tokenHash = await sha256(token);
  const expiresAt = 253402300799; // No time-based expiry.
  try {
    await env.DB.prepare(
      `INSERT INTO pairing_tokens
       (token_hash, license_id, patron_device_id, remaining_uses, created_at, expires_at,
        slot_number, operation, encrypted_token, consumed_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL)`
    ).bind(tokenHash, patron.license_id, patron.id, now, expiresAt, slotNumber, operation, encryptedToken).run();
  } catch {
    const raced = await env.DB.prepare(
      `SELECT encrypted_token, created_at FROM pairing_tokens
        WHERE license_id = ? AND patron_device_id = ? AND slot_number = ?
          AND operation = ? AND remaining_uses = 1 AND revoked_at IS NULL
          AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`
    ).bind(patron.license_id, patron.id, slotNumber, operation).first();
    if (!raced?.encrypted_token) return json({ error: "SERVICE_UNAVAILABLE" }, 503);
    try { token = await decryptPairingToken(raced.encrypted_token, env); }
    catch { return json({ error: "PAIRING_TOKEN_RECOVERY_FAILED" }, 503); }
    return json({ qrPayload: `SENEPAIR2:${token}`, slot, remainingUses: 1,
      createdAt: raced.created_at, expiresAt: null, recovered: true });
  }
  return json({ qrPayload: `SENEPAIR2:${token}`, slot, remainingUses: 1,
    createdAt: now, expiresAt: null, recovered: false }, 201);
}

async function restoreVentas(request, env) {
  const proof = await verifySignedRequest(request, env, "VENTAS_RESTORE");
  if (!proof.ok) return json({ error: proof.error }, proof.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const businessName = typeof body.businessName === "string" ? body.businessName.trim().replace(/\s+/g, " ") : "";
  const email = typeof body.registeredEmail === "string" ? body.registeredEmail.trim().toLowerCase() : "";
  const phone = typeof body.registeredPhone === "string" ? body.registeredPhone.replace(/\D/g, "") : "";
  const identity = await validateBootstrapIdentity(body);
  if (!identity || !businessName || businessName.length > 100 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phone.length < 10 || phone.length > 15 ||
      Object.keys(body).some((key) => !["businessName", "registeredEmail", "registeredPhone", "installationId", "continuityId", "publicKeyBase64", "fingerprint"].includes(key)) ||
      identity.installationId !== proof.challenge.installation_id ||
      identity.fingerprint !== String(proof.challenge.fingerprint).toLowerCase()) {
    return json({ error: "INVALID_RESTORE_DETAILS" }, 400);
  }
  const normalized = businessName.normalize("NFKC").toLocaleLowerCase("es-MX");
  const license = await env.DB.prepare(
    "SELECT id,business_name,status,expires_at FROM licenses WHERE lower(trim(business_name))=lower(trim(?)) AND lower(trim(registered_email))=? AND registered_phone=? AND status IN ('active','expired') LIMIT 1"
  ).bind(businessName, email, phone).first();
  if (!license || license.business_name.normalize("NFKC").toLocaleLowerCase("es-MX") !== normalized) {
    return json({ error: "REGISTERED_DETAILS_NOT_MATCH" }, 404);
  }
  const oldDevice = await env.DB.prepare(
    "SELECT id,slot_number FROM devices WHERE license_id=? AND device_type='VENTAS' AND status='active' AND continuity_id=? AND slot_number IN (2,3) LIMIT 1"
  ).bind(license.id, identity.continuityId).first();
  if (!oldDevice) return json({ error: "SAME_PHONE_NOT_VERIFIED" }, 409);
  const pendingReplacement = await env.DB.prepare(
    "SELECT id FROM replacement_requests WHERE license_id=? AND slot_number=? AND status='pending' LIMIT 1"
  ).bind(license.id, Number(oldDevice.slot_number)).first();
  if (pendingReplacement) return json({ error: "PAID_REPLACEMENT_PENDING" }, 409);

  const newDeviceId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE devices SET status='revoked' WHERE id=? AND license_id=? AND device_type='VENTAS' AND slot_number=? AND status='active' AND continuity_id=? AND EXISTS (SELECT 1 FROM licenses WHERE id=? AND status IN ('active','expired')) AND NOT EXISTS (SELECT 1 FROM replacement_requests WHERE license_id=? AND slot_number=? AND status='pending')"
      ).bind(oldDevice.id, license.id, Number(oldDevice.slot_number), identity.continuityId, license.id, license.id, Number(oldDevice.slot_number)),
      env.DB.prepare(
        "UPDATE pairing_tokens SET revoked_at=? WHERE license_id=? AND slot_number=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM devices WHERE id=? AND status='revoked')"
      ).bind(now, license.id, Number(oldDevice.slot_number), oldDevice.id),
      env.DB.prepare(
        "INSERT INTO devices (id,license_id,device_type,installation_id,continuity_id,public_key,fingerprint,slot_number,status,created_at) SELECT ?,?,?,?,?,?,?,?,'active',? FROM devices old WHERE old.id=? AND old.license_id=? AND old.status='revoked' AND old.slot_number=? AND old.continuity_id=? AND EXISTS (SELECT 1 FROM licenses WHERE id=? AND status IN ('active','expired')) AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.license_id=old.license_id AND d.slot_number=old.slot_number AND d.status='active')"
      ).bind(newDeviceId, license.id, "VENTAS", identity.installationId, identity.continuityId, identity.publicKey, identity.fingerprint, Number(oldDevice.slot_number), now, oldDevice.id, license.id, Number(oldDevice.slot_number), identity.continuityId, license.id),
      env.DB.prepare(
        "INSERT INTO audit_log (id,license_id,device_id,actor_type,actor_id,event_type,details_json,created_at) SELECT ?,?,?, 'system','ventas_restore','ventas_device_restored',?,? WHERE EXISTS (SELECT 1 FROM devices WHERE id=? AND status='active')"
      ).bind(crypto.randomUUID(), license.id, newDeviceId, JSON.stringify({ oldDeviceId: oldDevice.id, slotNumber: Number(oldDevice.slot_number), samePhone: true }), now, newDeviceId)
    ]);
  } catch {
    return json({ error: "VENTAS_RESTORE_CONFLICT" }, 409);
  }
  if ([0, 2, 3].some((index) => (results?.[index]?.meta?.changes ?? 0) !== 1)) {
    return json({ error: "VENTAS_RESTORE_CONFLICT" }, 409);
  }
  return json({
    deviceId: newDeviceId,
    slot: Number(oldDevice.slot_number) === 2 ? "VENTAS_1" : "VENTAS_2",
    businessName: license.business_name,
    licenseStatus: license.status === "active" && Number(license.expires_at || 0) > now ? "ACTIVE" : "EXPIRED",
    periodEndsAt: license.expires_at ?? null,
    restored: true
  }, 201);
}

async function pairVentas(request, env) {
  const proof = await verifySignedRequest(request, env, "VENTAS_PAIR");
  if (!proof.ok) return json({ error: proof.error }, proof.status);

  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const identity = await validateBootstrapIdentity(body);
  const qrPayload = typeof body.qrToken === "string" ? body.qrToken.trim() : "";
  if (!identity || identity.installationId !== proof.challenge.installation_id ||
      identity.fingerprint !== String(proof.challenge.fingerprint).toLowerCase() ||
      !/^[0-9a-f]{64}$/i.test(qrPayload)) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }

  const tokenHash = await sha256(qrPayload);
  const deviceId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO devices
         (id, license_id, device_type, installation_id, continuity_id,
          public_key, fingerprint, slot_number, status, created_at)
         SELECT ?, p.license_id, 'VENTAS', ?, ?, ?, ?, p.slot_number, 'active', ?
           FROM pairing_tokens p
           JOIN licenses l ON l.id = p.license_id
           JOIN devices patron ON patron.id = p.patron_device_id
          WHERE p.token_hash = ? AND p.remaining_uses = 1
            AND p.revoked_at IS NULL AND p.consumed_at IS NULL
            AND p.operation IN ('NEW','REPLACEMENT') AND p.slot_number IN (2,3)
            AND patron.status = 'active' AND patron.device_type = 'PATRON'
            AND l.status = 'active' AND l.expires_at > ?
            AND NOT EXISTS (SELECT 1 FROM devices existing
              WHERE existing.license_id = p.license_id
                AND existing.slot_number = p.slot_number AND existing.status = 'active')
            AND NOT EXISTS (SELECT 1 FROM devices duplicate
              WHERE duplicate.license_id = p.license_id AND duplicate.fingerprint = ?)`
      ).bind(deviceId, identity.installationId, body.continuityId.toLowerCase(),
        identity.publicKey, identity.fingerprint, now, tokenHash, now, identity.fingerprint),
      env.DB.prepare(
        `UPDATE pairing_tokens SET remaining_uses = 0, consumed_at = ?
          WHERE token_hash = ? AND remaining_uses = 1 AND revoked_at IS NULL
            AND consumed_at IS NULL AND operation IN ('NEW','REPLACEMENT')
            AND EXISTS (SELECT 1 FROM devices d
              WHERE d.id = ? AND d.license_id = pairing_tokens.license_id
                AND d.slot_number = pairing_tokens.slot_number)`
      ).bind(now, tokenHash, deviceId)
    ]);
    if ((results?.[0]?.meta?.changes ?? 0) !== 1 ||
        (results?.[1]?.meta?.changes ?? 0) !== 1) {
      return json({ error: "PAIRING_TOKEN_INVALID_OR_SLOT_OCCUPIED" }, 409);
    }
  } catch {
    return json({ error: "PAIRING_CONFLICT_OR_DATABASE_ERROR" }, 409);
  }

  const registered = await env.DB.prepare(
    "SELECT slot_number, license_id FROM devices WHERE id = ? LIMIT 1"
  ).bind(deviceId).first();
  const license = await env.DB.prepare(
    "SELECT business_name, expires_at FROM licenses WHERE id = ? LIMIT 1"
  ).bind(registered.license_id).first();
  return json({ deviceId, slot: registered.slot_number === 2 ? "VENTAS_1" : "VENTAS_2",
    businessName: license.business_name, licenseStatus: "ACTIVE", periodEndsAt: license.expires_at }, 201);
}

function constantTimeTextEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

async function requireOperator(request, env) {
  const expected = env.OPERATOR_TOKEN;
  const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (typeof expected === "string" && expected.length >= 32 &&
      constantTimeTextEqual(supplied, expected)) return true;
  // The mobile SENE ADMIN app authenticates with revocable HMAC sessions;
  // legacy server automation may continue using OPERATOR_TOKEN.
  return Boolean(await verifyAdminSession(request, env));
}

async function renewalPatronContext(proof, env) {
  const deviceId = proof.challenge.device_id;
  const row = await env.DB.prepare(
    "SELECT d.id, d.license_id, d.device_type, d.slot_number, d.status AS device_status, l.status AS license_status FROM devices d JOIN licenses l ON l.id = d.license_id WHERE d.id = ? LIMIT 1"
  ).bind(deviceId).first();
  if (!row || row.device_status !== "active" || row.device_type !== "PATRON" || row.slot_number !== 1) {
    return { error: "DEVICE_NOT_REGISTERED", status: 401 };
  }
  if (!["active", "expired"].includes(row.license_status)) {
    return { error: "LICENSE_NOT_RENEWABLE", status: 403 };
  }
  const quotaError = await consumeWeeklyQuota(env, deviceId);
  if (quotaError) return quotaError;
  return { deviceId, licenseId: row.license_id, deviceType: row.device_type, slotNumber: row.slot_number };
}

async function createPatronRecoveryPaymentRequest(request, env) {
  const proof = await verifySignedRequest(request, env, "PATRON_RECOVERY_REQUEST");
  if (!proof.ok) return json({ error: proof.error }, proof.status);
  let body; try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const businessName = typeof body.businessName === "string" ? body.businessName.trim().replace(/\s+/g, " ") : "";
  const email = typeof body.registeredEmail === "string" ? body.registeredEmail.trim().toLowerCase() : "";
  const phone = typeof body.registeredPhone === "string" ? body.registeredPhone.replace(/\D/g, "") : "";
  if (!businessName || businessName.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phone.length < 10 || phone.length > 15 ||
      Object.keys(body).some((key) => !["businessName","registeredEmail","registeredPhone","installationId","continuityId","publicKeyBase64","fingerprint"].includes(key)) ||
      !/^[0-9a-f-]{36}$/i.test(proof.challenge.installation_id) || !/^[0-9a-f]{64}$/i.test(proof.challenge.fingerprint || "")) return json({ error: "INVALID_RECOVERY_DETAILS" }, 400);
  const normalized = businessName.normalize("NFKC").toLocaleLowerCase("es-MX");
  const license = await env.DB.prepare("SELECT id,business_name,registered_email,registered_phone FROM licenses WHERE lower(trim(business_name))=lower(trim(?)) AND lower(trim(registered_email))=? AND registered_phone=? AND status IN ('active','expired') LIMIT 1").bind(businessName,email,phone).first();
  if (!license || license.business_name.normalize("NFKC").toLocaleLowerCase("es-MX") !== normalized) return json({ error: "REGISTERED_DETAILS_NOT_MATCH" }, 404);
  const oldPatron = await env.DB.prepare("SELECT id FROM devices WHERE license_id=? AND device_type='PATRON' AND slot_number=1 AND status='active' LIMIT 1").bind(license.id).first();
  if (!oldPatron) return json({ error: "REGISTERED_PATRON_NOT_FOUND" }, 409);
  const existing = await env.DB.prepare("SELECT id,status,created_at,installation_id,fingerprint,registered_email,registered_phone FROM patron_recovery_payment_requests WHERE license_id=? AND status IN ('pending_payment','authorized') LIMIT 1").bind(license.id).first();
  if (existing) {
    if (existing.installation_id !== proof.challenge.installation_id ||
        existing.registered_email !== email || existing.registered_phone !== phone) {
      return json({ error: "RECOVERY_REQUEST_BOUND_TO_OTHER_DEVICE" }, 409);
    }
    if (String(existing.fingerprint).toLowerCase() !== String(proof.challenge.fingerprint).toLowerCase()) {
      const rebound = await env.DB.prepare(
        "UPDATE patron_recovery_payment_requests SET fingerprint=? WHERE id=? AND installation_id=? AND fingerprint=? AND status IN ('pending_payment','authorized')"
      ).bind(proof.challenge.fingerprint.toLowerCase(), existing.id, proof.challenge.installation_id, existing.fingerprint).run();
      if ((rebound.meta?.changes ?? 0) !== 1) return json({ error: "RECOVERY_IDENTITY_REBIND_CONFLICT" }, 409);
    }
    return json({ requestId:existing.id,folio:existing.id,status:existing.status,createdAt:existing.created_at,amountCents:50000,currency:"MXN",duplicate:true });
  }
  const id=crypto.randomUUID(), now=Math.floor(Date.now()/1000);
  try {
    const created = await env.DB.prepare(
      "INSERT INTO patron_recovery_payment_requests (id,license_id,old_patron_device_id,installation_id,fingerprint,registered_email,registered_phone,status,created_at) SELECT ?,?,?,?,?,?,?,'pending_payment',? WHERE EXISTS (SELECT 1 FROM devices WHERE id=? AND license_id=? AND device_type='PATRON' AND slot_number=1 AND status='active')"
    ).bind(id,license.id,oldPatron.id,proof.challenge.installation_id,proof.challenge.fingerprint.toLowerCase(),email,phone,now,oldPatron.id,license.id).run();
    if ((created.meta?.changes ?? 0) !== 1) return json({ error: "REGISTERED_PATRON_NOT_FOUND" }, 409);
  } catch {
    const raced=await env.DB.prepare("SELECT id,status,created_at,installation_id,fingerprint,registered_email,registered_phone FROM patron_recovery_payment_requests WHERE license_id=? AND status IN ('pending_payment','authorized') LIMIT 1").bind(license.id).first();
    if(raced) {
      if (raced.installation_id !== proof.challenge.installation_id ||
          raced.registered_email !== email || raced.registered_phone !== phone) {
        return json({ error: "RECOVERY_REQUEST_BOUND_TO_OTHER_DEVICE" }, 409);
      }
      if (String(raced.fingerprint).toLowerCase() !== String(proof.challenge.fingerprint).toLowerCase()) {
        const rebound = await env.DB.prepare(
          "UPDATE patron_recovery_payment_requests SET fingerprint=? WHERE id=? AND installation_id=? AND fingerprint=? AND status IN ('pending_payment','authorized')"
        ).bind(proof.challenge.fingerprint.toLowerCase(), raced.id, proof.challenge.installation_id, raced.fingerprint).run();
        if ((rebound.meta?.changes ?? 0) !== 1) return json({ error: "RECOVERY_IDENTITY_REBIND_CONFLICT" }, 409);
      }
      return json({requestId:raced.id,folio:raced.id,status:raced.status,createdAt:raced.created_at,amountCents:50000,currency:"MXN",duplicate:true});
    }
    return json({error:"RECOVERY_REQUEST_FAILED"},503);
  }
  return json({requestId:id,folio:id,status:"pending_payment",createdAt:now,amountCents:50000,currency:"MXN",businessName:license.business_name,
    instructions:`Reposición de SENE PATRÓN: realiza un pago de $500 MXN. En el concepto o referencia escribe exactamente el folio: ${id}. Envía el comprobante a un número oficial de AYUDA por WhatsApp e incluye el mismo folio. El código se entrega únicamente después de verificar el pago.`},201);
}

async function listOperatorPatronRecoveryPayments(request, env) {
  if (!(await requireOperator(request, env))) return json({error:"UNAUTHORIZED"},401);
  const rows=await env.DB.prepare("SELECT r.id,r.license_id,l.business_name,r.registered_email,r.registered_phone,r.created_at,r.installation_id,r.fingerprint,r.status,r.payment_reference,r.delivery_phone,r.authorized_at FROM patron_recovery_payment_requests r JOIN licenses l ON l.id=r.license_id WHERE r.status IN ('pending_payment','authorized') ORDER BY r.created_at ASC LIMIT 100").all();
  return json({items:rows.results||[]});
}

async function authorizePatronRecoveryPayment(request, env) {
  if (!(await requireOperator(request, env))) return json({error:"UNAUTHORIZED"},401);
  let body; try { body=await request.json(); } catch { return json({error:"INVALID_REQUEST"},400); }
  const requestId=typeof body.requestId==="string"?body.requestId:"";
  const reference=typeof body.paymentReference==="string"?body.paymentReference.trim().slice(0,120):"";
  const deliveryPhone=typeof body.deliveryPhone==="string"?body.deliveryPhone.trim():"";
  if (!/^[0-9a-f-]{36}$/i.test(requestId)||!reference||!deliveryPhone) return json({error:"INVALID_REQUEST"},400);
  if (!(await requireOfficialHelpRecipient(env,deliveryPhone))) return json({error:"UNOFFICIAL_CODE_RECIPIENT"},403);
  const row=await env.DB.prepare("SELECT * FROM patron_recovery_payment_requests WHERE id=? LIMIT 1").bind(requestId).first();
  if (!row) return json({error:"RECOVERY_NOT_FOUND"},404);
  const normalizedDeliveryPhone=normalizeOfficialPhone(deliveryPhone);
  if (row.status==="authorized") {
    if (row.payment_reference!==reference ||
        normalizeOfficialPhone(row.delivery_phone||"")!==normalizedDeliveryPhone ||
        !row.encrypted_code) return json({error:"RECOVERY_ALREADY_AUTHORIZED"},409);
    try {
      const existingCode=await decryptPairingToken(row.encrypted_code,env);
      return json({requestId,recoveryCode:existingCode,amountCents:50000,currency:"MXN",reused:true,
        note:"Se recuperó el mismo código de un solo uso. Entregar exclusivamente por AYUDA oficial."});
    } catch { return json({error:"RECOVERY_CODE_RECOVERY_FAILED"},503); }
  }
  if (row.status!=="pending_payment") return json({error:"RECOVERY_NOT_PENDING"},409);
  const oldPatron=await env.DB.prepare("SELECT id FROM devices WHERE id=? AND license_id=? AND device_type='PATRON' AND slot_number=1 AND status='active' LIMIT 1").bind(row.old_patron_device_id,row.license_id).first();
  if (!oldPatron) return json({error:"OLD_PATRON_DEVICE_NOT_FOUND"},409);
  const code=makeCode(), hash=await sha256(code), now=Math.floor(Date.now()/1000), recoveryId=crypto.randomUUID();
  let encryptedCode;
  try { encryptedCode=await encryptPairingToken(code,env); }
  catch { return json({error:"PATRON_RECOVERY_CODE_ENCRYPTION_NOT_CONFIGURED"},503); }
  const results=await env.DB.batch([
    env.DB.prepare("INSERT INTO patron_recovery_requests (id,license_id,old_patron_device_id,code_hash,reason,status,created_at,created_by) SELECT ?,p.license_id,p.old_patron_device_id,?,?,'pending',?,'operator' FROM patron_recovery_payment_requests p JOIN devices d ON d.id=p.old_patron_device_id AND d.license_id=p.license_id WHERE p.id=? AND p.license_id=? AND p.status='pending_payment' AND p.old_patron_device_id=? AND d.device_type='PATRON' AND d.slot_number=1 AND d.status='active'").bind(recoveryId,hash,"Reposición SENE PATRÓN",now,requestId,row.license_id,row.old_patron_device_id),
    env.DB.prepare("UPDATE patron_recovery_payment_requests SET status='authorized',code_hash=?,encrypted_code=?,delivery_phone=?,payment_reference=?,authorized_at=? WHERE id=? AND license_id=? AND status='pending_payment' AND EXISTS (SELECT 1 FROM patron_recovery_requests WHERE id=? AND license_id=? AND code_hash=? AND status='pending')").bind(hash,encryptedCode,normalizedDeliveryPhone,reference,now,requestId,row.license_id,recoveryId,row.license_id,hash),
    env.DB.prepare("INSERT INTO audit_log (id,license_id,device_id,actor_type,actor_id,event_type,details_json,created_at) SELECT ?,?,?, 'operator','operator','patron_recovery_payment_authorized',?,? WHERE EXISTS (SELECT 1 FROM patron_recovery_payment_requests WHERE id=? AND status='authorized' AND code_hash=?) AND EXISTS (SELECT 1 FROM patron_recovery_requests WHERE id=? AND status='pending' AND code_hash=?)").bind(crypto.randomUUID(),row.license_id,row.old_patron_device_id,JSON.stringify({requestId,recoveryRequestId:recoveryId,paymentReference:reference,amountCents:50000}),now,requestId,hash,recoveryId,hash)
  ]);
  if (results.some(x=>(x?.meta?.changes??0)!==1)) return json({error:"RECOVERY_AUTHORIZATION_CONFLICT"},409);
  return json({requestId,recoveryRequestId:recoveryId,recoveryCode:code,amountCents:50000,currency:"MXN",
    note:"Código de un solo uso. Entregar exclusivamente por los números oficiales de AYUDA tras verificar el pago."},201);
}

async function createPatronRegistrationRequest(request, env) {
  const proof = await verifySignedRequest(request, env, "PATRON_REGISTRATION_REQUEST");
  if (!proof.ok) return json({ error: proof.error }, proof.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const businessName = typeof body.businessName === "string" ? body.businessName.trim().replace(/\s+/g, " ") : "";
  const registeredEmail = typeof body.registeredEmail === "string" ? body.registeredEmail.trim().toLowerCase() : "";
  const registeredPhone = typeof body.registeredPhone === "string" ? body.registeredPhone.replace(/\D/g, "") : "";
  if (!businessName || businessName.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registeredEmail) || registeredPhone.length < 10 || registeredPhone.length > 15 ||
      Object.keys(body).some((key) => !["businessName","registeredEmail","registeredPhone","installationId","continuityId","publicKeyBase64","fingerprint"].includes(key)) ||
      !/^[0-9a-f-]{36}$/i.test(proof.challenge.installation_id) ||
      !/^[0-9a-f]{64}$/i.test(proof.challenge.fingerprint || "")) {
    return json({ error: "INVALID_BUSINESS_NAME_OR_IDENTITY" }, 400);
  }
  const normalizedName = businessName.normalize("NFKC").toLocaleLowerCase("es-MX");
  const now = Math.floor(Date.now() / 1000);
  const reservationCutoff = now - 48 * 60 * 60;
  // Release expired pending reservations in the database so the partial unique
  // indexes no longer block a fresh request from the same name or installation.
  // Authorized payments are deliberately preserved beyond the 48-hour window.
  await env.DB.prepare(
    "UPDATE registration_requests SET status='cancelled', cancelled_at=? WHERE status='pending_payment' AND created_at <= ?"
  ).bind(now, reservationCutoff).run();
  const existingForDevice = await env.DB.prepare(
    "SELECT id, business_name, registered_email, registered_phone, fingerprint, status, created_at FROM registration_requests WHERE installation_id = ? AND (status = 'authorized' OR (status = 'pending_payment' AND created_at > ?)) ORDER BY created_at DESC LIMIT 1"
  ).bind(proof.challenge.installation_id, reservationCutoff).first();
  if (existingForDevice) {
    if (existingForDevice.business_name.normalize("NFKC").toLocaleLowerCase("es-MX") !== normalizedName || existingForDevice.registered_email !== registeredEmail || existingForDevice.registered_phone !== registeredPhone) {
      return json({ error: "DEVICE_HAS_DIFFERENT_PENDING_REGISTRATION" }, 409);
    }
    if (String(existingForDevice.fingerprint).toLowerCase() !== proof.challenge.fingerprint.toLowerCase()) {
      const rebound = await env.DB.prepare(
        "UPDATE registration_requests SET fingerprint=? WHERE id=? AND installation_id=? AND fingerprint=? AND status IN ('pending_payment','authorized')"
      ).bind(proof.challenge.fingerprint.toLowerCase(), existingForDevice.id, proof.challenge.installation_id, existingForDevice.fingerprint).run();
      if ((rebound.meta?.changes ?? 0) !== 1) return json({ error: "REGISTRATION_IDENTITY_REBIND_CONFLICT" }, 409);
    }
    const existingExpiresAt = Number(existingForDevice.created_at) + 48 * 60 * 60;
    return json({ requestId: existingForDevice.id, folio: existingForDevice.id, businessName: existingForDevice.business_name,
      status: existingForDevice.status, createdAt: Number(existingForDevice.created_at),
      expiresAt: existingExpiresAt, serverTime: now, reservationSeconds: 48 * 60 * 60,
      amountCents: 58000, currency: "MXN", duplicate: true });
  }
  const activeName = await env.DB.prepare(
    "SELECT id FROM licenses WHERE lower(trim(business_name)) = lower(trim(?)) AND status IN ('pending','active','expired','suspended') LIMIT 1"
  ).bind(businessName).first();
  if (activeName) return json({ error: "BUSINESS_NAME_ALREADY_REGISTERED" }, 409);
  const openName = await env.DB.prepare(
    "SELECT id FROM registration_requests WHERE normalized_name = ? AND (status = 'authorized' OR (status = 'pending_payment' AND created_at > ?)) LIMIT 1"
  ).bind(normalizedName, reservationCutoff).first();
  if (openName) return json({ error: "BUSINESS_NAME_REGISTRATION_PENDING" }, 409);
  const id = crypto.randomUUID();
  const expiresAt = now + 48 * 60 * 60;
  try {
    await env.DB.prepare(
      "INSERT INTO registration_requests (id,business_name,normalized_name,installation_id,fingerprint,status,created_at,registered_email,registered_phone) VALUES (?,?,?,?,?,'pending_payment',?,?,?)"
    ).bind(id,businessName,normalizedName,proof.challenge.installation_id,proof.challenge.fingerprint.toLowerCase(),now,registeredEmail,registeredPhone).run();
  } catch {
    const raced = await env.DB.prepare(
      "SELECT id,status,created_at FROM registration_requests WHERE normalized_name = ? AND (status = 'authorized' OR (status = 'pending_payment' AND created_at > ?)) LIMIT 1"
    ).bind(normalizedName, reservationCutoff).first();
    if (raced) return json({ error: "BUSINESS_NAME_REGISTRATION_PENDING", requestId: raced.id }, 409);
    return json({ error: "REGISTRATION_REQUEST_FAILED" }, 503);
  }
  return json({
    requestId: id, folio: id, businessName, status: "pending_payment", createdAt: now,
    expiresAt, serverTime: now, reservationSeconds: 48 * 60 * 60,
    amountCents: 58000, currency: "MXN", package: "1_PATRON_2_VENTAS",
    instructions: `Realiza el pago inicial de $580 MXN. En el concepto o referencia escribe exactamente el folio de solicitud: ${id}. Conserva el comprobante y envíalo a un número oficial de AYUDA. El folio identifica tu solicitud; enviar el comprobante no confirma el pago. El código se entrega únicamente después de verificar el pago.`
  }, 201);
}

function normalizeOfficialPhone(value) {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

async function requireOfficialHelpRecipient(env, suppliedPhone) {
  const supplied = normalizeOfficialPhone(suppliedPhone);
  if (!supplied || supplied.length < 10) return false;
  const row = await env.DB.prepare(
    "SELECT help_phone_1, help_phone_2 FROM official_support_contacts WHERE id = 1 LIMIT 1"
  ).first();
  if (!row) return false;
  const official = [normalizeOfficialPhone(row.help_phone_1), normalizeOfficialPhone(row.help_phone_2)]
    .filter((phone) => phone.length >= 10);
  return official.includes(supplied);
}

async function registerLegacyLicenseContacts(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const licenseId = typeof body.licenseId === "string" ? body.licenseId : "";
  const email = typeof body.registeredEmail === "string" ? body.registeredEmail.trim().toLowerCase() : "";
  const phone = typeof body.registeredPhone === "string" ? body.registeredPhone.replace(/\D/g, "") : "";
  const verificationNote = typeof body.verificationNote === "string" ? body.verificationNote.trim().slice(0, 200) : "";
  if (!/^[0-9a-f-]{36}$/i.test(licenseId) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      phone.length < 10 || phone.length > 15 || verificationNote.length < 8 ||
      Object.keys(body).some((key) => !["licenseId", "registeredEmail", "registeredPhone", "verificationNote"].includes(key))) {
    return json({ error: "INVALID_REGISTERED_CONTACTS" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const details = JSON.stringify({
    contactUpdate: "operator_verified_legacy_license",
    emailDomain: email.split("@")[1],
    phoneLast4: phone.slice(-4),
    verificationNote
  });
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE licenses SET registered_email=?,registered_phone=? WHERE id=? AND status IN ('active','expired') AND (registered_email IS NULL OR trim(registered_email)='') AND (registered_phone IS NULL OR trim(registered_phone)='')"
      ).bind(email, phone, licenseId),
      env.DB.prepare(
        "INSERT INTO audit_log (id,license_id,actor_type,actor_id,event_type,details_json,created_at) SELECT ?,id,'operator','operator','legacy_license_contacts_registered',?,? FROM licenses WHERE id=? AND registered_email=? AND registered_phone=?"
      ).bind(crypto.randomUUID(), details, now, licenseId, email, phone)
    ]);
  } catch {
    return json({ error: "CONTACT_REGISTRATION_FAILED" }, 503);
  }
  if ((results?.[0]?.meta?.changes ?? 0) !== 1 || (results?.[1]?.meta?.changes ?? 0) !== 1) {
    return json({ error: "LICENSE_NOT_ELIGIBLE_OR_CONTACTS_ALREADY_SET" }, 409);
  }
  return json({ licenseId, contactsRegistered: true, recoveryAvailable: true }, 200);
}

async function listOperatorLicenses(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  const limitRaw = Number(new URL(request.url).searchParams.get("limit") || 100);
  const limit = Number.isSafeInteger(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 100;
  const rows = await env.DB.prepare(
    `SELECT l.id,l.business_name,l.status,l.max_devices,l.expires_at,l.created_at,
            l.setup_paid_at,l.first_rent_paid_at,
            (SELECT COUNT(*) FROM devices d WHERE d.license_id=l.id AND d.status='active') AS active_devices,
            (SELECT COUNT(*) FROM devices d WHERE d.license_id=l.id AND d.device_type='PATRON' AND d.slot_number=1 AND d.status='active') AS active_patron_devices
       FROM licenses l ORDER BY l.created_at DESC,l.id DESC LIMIT ?`
  ).bind(limit).all();
  return json({ items: rows.results || [], serverTime: Math.floor(Date.now() / 1000) });
}

async function listOperatorAudit(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit") || 100);
  const limit = Number.isSafeInteger(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 100;
  const licenseId = url.searchParams.get("licenseId");
  if (licenseId && !/^[0-9a-f-]{36}$/i.test(licenseId)) return json({ error: "INVALID_LICENSE_ID" }, 400);
  const rows = licenseId
    ? await env.DB.prepare(
        "SELECT id,license_id,device_id,actor_type,actor_id,event_type,details_json,created_at FROM audit_log WHERE actor_type='operator' AND license_id=? ORDER BY created_at DESC,id DESC LIMIT ?"
      ).bind(licenseId, limit).all()
    : await env.DB.prepare(
        "SELECT id,license_id,device_id,actor_type,actor_id,event_type,details_json,created_at FROM audit_log WHERE actor_type='operator' ORDER BY created_at DESC,id DESC LIMIT ?"
      ).bind(limit).all();
  return json({ items: rows.results || [], serverTime: Math.floor(Date.now() / 1000) });
}

async function listOperatorRegistrations(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  const now = Math.floor(Date.now() / 1000);
  const reservationCutoff = now - 48 * 60 * 60;
  // La bandeja administrativa no debe conservar solicitudes cuya reserva ya venció.
  await env.DB.prepare(
    "UPDATE registration_requests SET status='cancelled', cancelled_at=? WHERE status='pending_payment' AND created_at <= ?"
  ).bind(now, reservationCutoff).run();
  const rows = await env.DB.prepare(
    "SELECT id,business_name,registered_email,registered_phone,status,created_at,installation_id,fingerprint FROM registration_requests WHERE status='pending_payment' AND created_at > ? ORDER BY created_at ASC LIMIT 100"
  ).bind(reservationCutoff).all();
  return json({ items: rows.results || [], serverTime: now, reservationSeconds: 48 * 60 * 60 });
}

async function authorizePatronRegistration(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const reference = typeof body.paymentReference === "string" ? body.paymentReference.trim().slice(0,120) : "";
  const deliveryPhone = typeof body.deliveryPhone === "string" ? body.deliveryPhone.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !reference || !deliveryPhone) return json({ error: "INVALID_REQUEST" }, 400);
  if (!(await requireOfficialHelpRecipient(env, deliveryPhone))) {
    return json({ error: "UNOFFICIAL_CODE_RECIPIENT" }, 403);
  }
  const row = await env.DB.prepare(
    "SELECT id,business_name,registered_email,registered_phone,status,created_at FROM registration_requests WHERE id=? LIMIT 1"
  ).bind(requestId).first();
  if (!row || row.status !== "pending_payment") return json({ error: "REGISTRATION_NOT_PENDING" }, 409);
  const now = Math.floor(Date.now() / 1000);
  const reservationCutoff = now - 48 * 60 * 60;
  if (Number(row.created_at) <= reservationCutoff) {
    await env.DB.prepare(
      "UPDATE registration_requests SET status='cancelled', cancelled_at=? WHERE id=? AND status='pending_payment' AND created_at <= ?"
    ).bind(now, requestId, reservationCutoff).run();
    return json({ error: "REGISTRATION_RESERVATION_EXPIRED" }, 409);
  }
  const licenseId = crypto.randomUUID();
  const code = makeCode();
  const codeHash = await sha256(code);
  const results = await env.DB.batch([
    // Cada alta depende de que la solicitud siga pendiente; evita licencias duplicadas
    // si dos operadores confirman simultáneamente el mismo comprobante.
    env.DB.prepare(
      "INSERT INTO licenses (id,label,business_name,registered_email,registered_phone,status,max_devices,activation_code_hash,created_at) SELECT ?,?,?,?,?, 'pending',3,?,? WHERE EXISTS (SELECT 1 FROM registration_requests WHERE id=? AND status='pending_payment' AND created_at > ?)"
    ).bind(licenseId,row.business_name,row.business_name,row.registered_email,row.registered_phone,codeHash,now,requestId,reservationCutoff),
    env.DB.prepare(
      "UPDATE registration_requests SET status='authorized',license_id=?,code_hash=?,payment_reference=?,authorized_at=? WHERE id=? AND status='pending_payment' AND created_at > ? AND EXISTS (SELECT 1 FROM licenses WHERE id=? AND activation_code_hash=?)"
    ).bind(licenseId,codeHash,reference,now,requestId,reservationCutoff,licenseId,codeHash),
    env.DB.prepare(
      "INSERT INTO payments (id,license_id,payment_type,amount_cents,currency,status,reference,idempotency_key,created_at,confirmed_at,confirmed_by) SELECT ?,?,'SETUP',50000,'MXN','CONFIRMED',?,?,?,?,'operator' WHERE EXISTS (SELECT 1 FROM registration_requests WHERE id=? AND status='authorized' AND license_id=? AND code_hash=?)"
    ).bind(crypto.randomUUID(),licenseId,reference,"registration-setup:"+requestId,now,now,requestId,licenseId,codeHash),
    env.DB.prepare(
      "INSERT INTO payments (id,license_id,payment_type,amount_cents,currency,status,reference,idempotency_key,created_at,confirmed_at,confirmed_by) SELECT ?,?,'FIRST_RENT',8000,'MXN','CONFIRMED',?,?,?,?,'operator' WHERE EXISTS (SELECT 1 FROM registration_requests WHERE id=? AND status='authorized' AND license_id=? AND code_hash=?)"
    ).bind(crypto.randomUUID(),licenseId,reference,"registration-rent:"+requestId,now,now,requestId,licenseId,codeHash),
    env.DB.prepare(
      "UPDATE licenses SET setup_paid_at=?,first_rent_paid_at=? WHERE id=? AND status='pending' AND EXISTS (SELECT 1 FROM payments WHERE license_id=? AND payment_type='SETUP' AND idempotency_key=?) AND EXISTS (SELECT 1 FROM payments WHERE license_id=? AND payment_type='FIRST_RENT' AND idempotency_key=?)"
    ).bind(now,now,licenseId,licenseId,"registration-setup:"+requestId,licenseId,"registration-rent:"+requestId),
    env.DB.prepare(
      "INSERT INTO audit_log (id,license_id,actor_type,actor_id,event_type,details_json,created_at) SELECT ?,?,'operator','operator','patron_registration_authorized',?,? WHERE EXISTS (SELECT 1 FROM registration_requests WHERE id=? AND status='authorized' AND license_id=? AND code_hash=?) AND EXISTS (SELECT 1 FROM licenses WHERE id=? AND setup_paid_at IS NOT NULL AND first_rent_paid_at IS NOT NULL)"
    ).bind(crypto.randomUUID(),licenseId,JSON.stringify({requestId,paymentReference:reference,totalCents:58000}),now,requestId,licenseId,codeHash,licenseId)
  ]);
  if (results.some((item) => (item?.meta?.changes ?? 0) !== 1)) {
    return json({ error: "REGISTRATION_AUTHORIZATION_CONFLICT" }, 409);
  }
  return json({ requestId, licenseId, businessName: row.business_name, activationCode: code,
    paymentStatus: "CONFIRMED", totalCents: 58000, currency: "MXN",
    note: "Código de un solo uso. Entregar exclusivamente a los números oficiales de AYUDA después de verificar el comprobante." }, 201);
}

async function createRenewalRequest(request, env) {
  const proof = await verifySignedRequest(request, env, "PATRON_RENEWAL_REQUEST");
  if (!proof.ok) return json({ error: proof.error }, proof.status);
  const ctx = await renewalPatronContext(proof, env);
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const existing = await env.DB.prepare(
    "SELECT id, status, created_at FROM renewal_requests WHERE license_id = ? AND status IN ('pending_payment','authorized') ORDER BY created_at DESC LIMIT 1"
  ).bind(ctx.licenseId).first();
  if (existing) return json({ requestId: existing.id, folio: existing.id, status: existing.status, createdAt: existing.created_at, amountCents: 8000, currency: "MXN", duplicate: true, instructions: `Renovación SENE: paga $80 MXN. En el concepto o referencia escribe exactamente el folio: ${existing.id}. Envía el comprobante a AYUDA e incluye el mismo folio.` });
  const license = await env.DB.prepare(
    "SELECT business_name FROM licenses WHERE id = ? LIMIT 1"
  ).bind(ctx.licenseId).first();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      "INSERT INTO renewal_requests (id, license_id, patron_device_id, business_name, status, created_at) VALUES (?, ?, ?, ?, 'pending_payment', ?)"
    ).bind(id, ctx.licenseId, ctx.deviceId, license?.business_name || null, now).run();
  } catch {
    const raced = await env.DB.prepare(
      "SELECT id, status, created_at FROM renewal_requests WHERE license_id = ? AND status IN ('pending_payment','authorized') ORDER BY created_at DESC LIMIT 1"
    ).bind(ctx.licenseId).first();
    if (raced) return json({ requestId: raced.id, folio: raced.id, status: raced.status, createdAt: raced.created_at, amountCents: 8000, currency: "MXN", duplicate: true, instructions: `Renovación SENE: paga $80 MXN. En el concepto o referencia escribe exactamente el folio: ${raced.id}. Envía el comprobante a AYUDA e incluye el mismo folio.` });
    return json({ error: "SERVICE_UNAVAILABLE" }, 503);
  }
  return json({
    requestId: id, folio: id, status: "pending_payment", createdAt: now,
    amountCents: 8000, currency: "MXN",
    instructions: `Renovación SENE: paga $80 MXN. En el concepto o referencia escribe exactamente el folio: ${id}. Envía el comprobante a un número oficial de AYUDA e incluye el mismo folio. Después espera la validación y el código de autorización.`
  }, 201);
}


async function createOperatorLicense(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const businessName = typeof body.businessName === "string" ? body.businessName.trim() : "";
  if (!businessName || businessName.length > 100) return json({ error: "INVALID_BUSINESS_NAME" }, 400);
  const licenseId = crypto.randomUUID();
  const activationCode = makeCode();
  const codeHash = await sha256(activationCode);
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO licenses (id, label, business_name, status, max_devices, activation_code_hash, created_at) VALUES (?, ?, ?, 'pending', 3, ?, ?)"
      ).bind(licenseId, businessName, businessName, codeHash, now),
      env.DB.prepare(
        "INSERT INTO audit_log (id, license_id, actor_type, actor_id, event_type, details_json, created_at) VALUES (?, ?, 'operator', 'operator', 'license_created', ?, ?)"
      ).bind(crypto.randomUUID(), licenseId, JSON.stringify({ businessName }), now)
    ]);
  } catch {
    return json({ error: "LICENSE_CREATE_FAILED" }, 503);
  }
  return json({
    licenseId, businessName, activationCode,
    initialPaymentCents: 58000, currency: "MXN",
    package: "1_PATRON_2_VENTAS", maxDevices: 3, validityDays: 30,
    note: "Código de un solo uso. Entrégalo después de confirmar el pago inicial de $580 MXN."
  }, 201);
}

async function reissueActivationCode(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const licenseId = typeof body.licenseId === "string" ? body.licenseId : "";
  const deliveryPhone = typeof body.deliveryPhone === "string" ? body.deliveryPhone.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(licenseId) || !deliveryPhone) return json({ error: "INVALID_REQUEST" }, 400);
  if (!(await requireOfficialHelpRecipient(env, deliveryPhone))) return json({ error: "UNOFFICIAL_CODE_RECIPIENT" }, 403);
  const current = await env.DB.prepare(
    "SELECT activation_code_hash FROM licenses WHERE id = ? AND status = 'pending' AND setup_paid_at IS NOT NULL AND first_rent_paid_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM devices WHERE license_id = ? AND slot_number = 1 AND status = 'active') LIMIT 1"
  ).bind(licenseId, licenseId).first();
  if (!current) return json({ error: "LICENSE_NOT_ELIGIBLE_FOR_CODE_REISSUE" }, 409);
  const registration = await env.DB.prepare(
    "SELECT id, code_hash FROM registration_requests WHERE license_id = ? AND status = 'authorized' LIMIT 1"
  ).bind(licenseId).first();
  if (registration && registration.code_hash !== current.activation_code_hash) {
    return json({ error: "ACTIVATION_REGISTRATION_CODE_MISMATCH" }, 409);
  }
  const code = makeCode();
  const codeHash = await sha256(code);
  const now = Math.floor(Date.now() / 1000);
  const statements = [
    env.DB.prepare(
      "UPDATE licenses SET activation_code_hash = ? WHERE id = ? AND status = 'pending' AND activation_code_hash IS ? AND setup_paid_at IS NOT NULL AND first_rent_paid_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM devices WHERE license_id = ? AND slot_number = 1 AND status = 'active')"
    ).bind(codeHash, licenseId, current.activation_code_hash ?? null, licenseId)
  ];
  if (registration) {
    statements.push(env.DB.prepare(
      "UPDATE registration_requests SET code_hash = ? WHERE id = ? AND license_id = ? AND status = 'authorized' AND code_hash = ?"
    ).bind(codeHash, registration.id, licenseId, registration.code_hash));
  }
  statements.push(env.DB.prepare(
    "INSERT INTO audit_log (id, license_id, actor_type, actor_id, event_type, details_json, created_at) SELECT ?, ?, 'operator', 'operator', 'activation_code_reissued', ?, ? WHERE EXISTS (SELECT 1 FROM licenses WHERE id = ? AND activation_code_hash = ?) AND (? = 0 OR EXISTS (SELECT 1 FROM registration_requests WHERE id = ? AND license_id = ? AND status = 'authorized' AND code_hash = ?))"
  ).bind(crypto.randomUUID(), licenseId, JSON.stringify({ reason: "operator_reissue", registrationBound: Boolean(registration) }), now, licenseId, codeHash, registration ? 1 : 0, registration?.id ?? "", licenseId, codeHash));
  let results;
  try {
    results = await env.DB.batch(statements);
  } catch {
    return json({ error: "ACTIVATION_CODE_REISSUE_FAILED" }, 503);
  }
  if ((results?.[0]?.meta?.changes ?? 0) !== 1 ||
      (registration && (results?.[1]?.meta?.changes ?? 0) !== 1) ||
      (results?.[results.length - 1]?.meta?.changes ?? 0) !== 1) {
    return json({ error: "LICENSE_NOT_ELIGIBLE_FOR_CODE_REISSUE" }, 409);
  }
  return json({ licenseId, activationCode: code, expiresAt: null, note: "Código anterior invalidado. Código nuevo de un solo uso; entrégalo solo tras verificar los pagos." }, 200);
}

async function reissueRenewalCode(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const deliveryPhone = typeof body.deliveryPhone === "string" ? body.deliveryPhone.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !deliveryPhone) return json({ error: "INVALID_REQUEST" }, 400);
  if (!(await requireOfficialHelpRecipient(env, deliveryPhone))) return json({ error: "UNOFFICIAL_CODE_RECIPIENT" }, 403);
  const code = makeCode();
  const codeHash = await sha256(code);
  const now = Math.floor(Date.now() / 1000);
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE renewal_requests SET code_hash = ?, authorized_at = ?, authorized_by = 'operator' WHERE id = ? AND status = 'authorized' AND EXISTS (SELECT 1 FROM payments WHERE license_id = renewal_requests.license_id AND payment_type = 'MONTHLY_RENT' AND status = 'CONFIRMED' AND idempotency_key = 'renewal:' || renewal_requests.id)"
      ).bind(codeHash, now, requestId),
      env.DB.prepare(
        "INSERT INTO audit_log (id, license_id, actor_type, actor_id, event_type, details_json, created_at) SELECT ?, license_id, 'operator', 'operator', 'renewal_code_reissued', ?, ? FROM renewal_requests WHERE id = ? AND status = 'authorized' AND code_hash = ?"
      ).bind(crypto.randomUUID(), JSON.stringify({ requestId }), now, requestId, codeHash)
    ]);
  } catch {
    return json({ error: "RENEWAL_CODE_REISSUE_FAILED" }, 503);
  }
  if ((results?.[0]?.meta?.changes ?? 0) !== 1 || (results?.[1]?.meta?.changes ?? 0) !== 1) {
    return json({ error: "RENEWAL_NOT_ELIGIBLE_FOR_CODE_REISSUE" }, 409);
  }
  return json({ requestId, authorizationCode: code, expiresAt: null, note: "Código anterior invalidado. Código nuevo de un solo uso." }, 200);
}

async function confirmInitialPayment(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const licenseId = typeof body.licenseId === "string" ? body.licenseId : "";
  const reference = typeof body.paymentReference === "string" ? body.paymentReference.trim().slice(0, 120) : "";
  if (!/^[0-9a-f-]{36}$/i.test(licenseId) || !reference) return json({ error: "INVALID_REQUEST" }, 400);
  const license = await env.DB.prepare(
    "SELECT status, setup_paid_at, first_rent_paid_at FROM licenses WHERE id = ? LIMIT 1"
  ).bind(licenseId).first();
  if (!license) return json({ error: "LICENSE_NOT_FOUND" }, 404);
  if (license.setup_paid_at && license.first_rent_paid_at) {
    return json({ licenseId, paymentStatus: "CONFIRMED", duplicate: true });
  }
  if (license.status !== "pending" || license.setup_paid_at || license.first_rent_paid_at) {
    return json({ error: "INITIAL_PAYMENT_NOT_CONFIRMABLE" }, 409);
  }
  const now = Math.floor(Date.now() / 1000);
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO payments (id, license_id, payment_type, amount_cents, currency, status, reference, idempotency_key, created_at, confirmed_at, confirmed_by) VALUES (?, ?, 'SETUP', 50000, 'MXN', 'CONFIRMED', ?, ?, ?, ?, 'operator')"
      ).bind(crypto.randomUUID(), licenseId, reference, "initial-setup:" + licenseId, now, now),
      env.DB.prepare(
        "INSERT INTO payments (id, license_id, payment_type, amount_cents, currency, status, reference, idempotency_key, created_at, confirmed_at, confirmed_by) VALUES (?, ?, 'FIRST_RENT', 8000, 'MXN', 'CONFIRMED', ?, ?, ?, ?, 'operator')"
      ).bind(crypto.randomUUID(), licenseId, reference, "initial-rent:" + licenseId, now, now),
      env.DB.prepare(
        "UPDATE licenses SET setup_paid_at = ?, first_rent_paid_at = ? WHERE id = ? AND status = 'pending' AND setup_paid_at IS NULL AND first_rent_paid_at IS NULL"
      ).bind(now, now, licenseId),
      env.DB.prepare(
        "INSERT INTO audit_log (id, license_id, actor_type, actor_id, event_type, details_json, created_at) VALUES (?, ?, 'operator', 'operator', 'initial_payment_confirmed', ?, ?)"
      ).bind(crypto.randomUUID(), licenseId, JSON.stringify({ paymentReference: reference, totalCents: 58000 }), now)
    ]);
  } catch {
    const raced = await env.DB.prepare(
      "SELECT setup_paid_at, first_rent_paid_at FROM licenses WHERE id = ? LIMIT 1"
    ).bind(licenseId).first();
    if (raced?.setup_paid_at && raced?.first_rent_paid_at) {
      return json({ licenseId, paymentStatus: "CONFIRMED", duplicate: true });
    }
    return json({ error: "INITIAL_PAYMENT_CONFLICT" }, 409);
  }
  if ((results?.[2]?.meta?.changes ?? 0) !== 1) return json({ error: "INITIAL_PAYMENT_CONFLICT" }, 409);
  return json({ licenseId, paymentStatus: "CONFIRMED", totalCents: 58000, currency: "MXN", activationCodeCanBeDelivered: true }, 200);
}

async function listOperatorRenewals(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const rows = await env.DB.prepare(
    "SELECT id, license_id, business_name, status, created_at, authorized_at FROM renewal_requests WHERE status='pending_payment' OR (status='authorized' AND created_at >= ?) ORDER BY created_at ASC LIMIT 100"
  ).bind(cutoff).all();
  return json({ items: rows.results || [] });
}

async function authorizeRenewal(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const reference = typeof body.paymentReference === "string" ? body.paymentReference.trim().slice(0, 120) : "";
  const deliveryPhone = typeof body.deliveryPhone === "string" ? body.deliveryPhone.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !reference || !deliveryPhone) return json({ error: "INVALID_REQUEST" }, 400);
  if (!(await requireOfficialHelpRecipient(env, deliveryPhone))) {
    return json({ error: "UNOFFICIAL_CODE_RECIPIENT" }, 403);
  }
  const row = await env.DB.prepare(
    "SELECT r.id, r.license_id, r.status, l.expires_at FROM renewal_requests r JOIN licenses l ON l.id = r.license_id WHERE r.id = ? LIMIT 1"
  ).bind(requestId).first();
  if (!row || row.status !== "pending_payment") return json({ error: "RENEWAL_NOT_PENDING" }, 409);
  const code = makeCode();
  const codeHash = await sha256(code);
  const now = Math.floor(Date.now() / 1000);
  const paymentId = crypto.randomUUID();
  let result;
  try {
    result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE renewal_requests SET status = 'authorized', code_hash = ?, authorized_at = ?, authorized_by = 'operator', payment_reference = ? WHERE id = ? AND status = 'pending_payment'"
    ).bind(codeHash, now, reference, requestId),
    env.DB.prepare(
      "INSERT INTO payments (id, license_id, payment_type, amount_cents, currency, status, reference, idempotency_key, created_at, confirmed_at, confirmed_by) SELECT ?, ?, 'MONTHLY_RENT', 8000, 'MXN', 'CONFIRMED', ?, ?, ?, ?, 'operator' WHERE EXISTS (SELECT 1 FROM renewal_requests WHERE id = ? AND status = 'authorized' AND code_hash = ?)"
    ).bind(paymentId, row.license_id, reference, "renewal:" + requestId, now, now, requestId, codeHash),
    env.DB.prepare(
      "INSERT INTO audit_log (id, license_id, actor_type, actor_id, event_type, details_json, created_at) SELECT ?, ?, 'operator', 'operator', 'renewal_authorized', ?, ? WHERE EXISTS (SELECT 1 FROM renewal_requests WHERE id = ? AND status = 'authorized' AND code_hash = ?)"
    ).bind(crypto.randomUUID(), row.license_id, JSON.stringify({ requestId, paymentReference: reference }), now, requestId, codeHash)
    ]);
  } catch {
    return json({ error: "RENEWAL_AUTHORIZATION_CONFLICT" }, 409);
  }
  if ((result?.[0]?.meta?.changes ?? 0) !== 1 ||
      (result?.[1]?.meta?.changes ?? 0) !== 1 ||
      (result?.[2]?.meta?.changes ?? 0) !== 1) {
    return json({ error: "RENEWAL_AUTHORIZATION_CONFLICT" }, 409);
  }
  return json({ requestId, authorizationCode: code, expiresAt: null, note: "Código de un solo uso, sin caducidad temporal. Entrégalo al cliente únicamente después de verificar el pago recibido." }, 201);
}


async function cancelRenewal(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return json({ error: "INVALID_REQUEST" }, 400);
  const now = Math.floor(Date.now() / 1000);
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE renewal_requests SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status IN ('pending_payment','authorized')"
      ).bind(now, requestId),
      env.DB.prepare(
        "INSERT INTO audit_log (id, license_id, actor_type, actor_id, event_type, details_json, created_at) SELECT ?, license_id, 'operator', 'operator', 'renewal_cancelled', ?, ? FROM renewal_requests WHERE id = ? AND status = 'cancelled' AND cancelled_at = ?"
      ).bind(crypto.randomUUID(), JSON.stringify({ requestId }), now, requestId, now)
    ]);
  } catch {
    return json({ error: "SERVICE_UNAVAILABLE" }, 503);
  }
  if ((results?.[0]?.meta?.changes ?? 0) !== 1) return json({ error: "RENEWAL_NOT_CANCELLABLE" }, 409);
  return json({ requestId, status: "cancelled" });
}

async function redeemRenewal(request, env) {
  const proof = await verifySignedRequest(request, env, "PATRON_RENEWAL_REDEEM");
  if (!proof.ok) return json({ error: proof.error }, proof.status);
  const ctx = await renewalPatronContext(proof, env);
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const code = typeof body.authorizationCode === "string" ? body.authorizationCode.trim().toUpperCase() : "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !/^[A-HJ-NP-Z2-9]{12}$/.test(code)) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const codeHash = await sha256(code);
  const now = Math.floor(Date.now() / 1000);
  const license = await env.DB.prepare(
    "SELECT expires_at, status FROM licenses WHERE id = ? LIMIT 1"
  ).bind(ctx.licenseId).first();
  if (!license || !["active", "expired"].includes(license.status)) {
    return json({ error: "LICENSE_NOT_RENEWABLE" }, 403);
  }
  const nextExpiry = Math.max(Number(license.expires_at || 0), now) + 30 * 86400;
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE renewal_requests SET status = 'consumed', consumed_at = ? WHERE id = ? AND license_id = ? AND patron_device_id = ? AND status = 'authorized' AND code_hash = ?"
    ).bind(now, requestId, ctx.licenseId, ctx.deviceId, codeHash),
    env.DB.prepare(
      "UPDATE licenses SET status = 'active', expires_at = ?, activated_at = COALESCE(activated_at, ?) WHERE id = ? AND EXISTS (SELECT 1 FROM renewal_requests WHERE id = ? AND license_id = ? AND status = 'consumed' AND consumed_at = ?)"
    ).bind(nextExpiry, now, ctx.licenseId, requestId, ctx.licenseId, now)
  ]);
  if ((results?.[0]?.meta?.changes ?? 0) !== 1 || (results?.[1]?.meta?.changes ?? 0) !== 1) {
    return json({ error: "RENEWAL_CODE_INVALID_OR_USED" }, 409);
  }
  return json({ requestId, licenseStatus: "ACTIVE", periodEndsAt: nextExpiry, renewedDays: 30 }, 200);
}


async function patronDevicesList(request, env) {
  const checked = await verifyBusinessProof(request, env, "PATRON_DEVICES_LIST");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "PATRON");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const rows = await env.DB.prepare(
    "SELECT id, slot_number, created_at, last_seen_at FROM devices WHERE license_id = ? AND device_type = 'VENTAS' AND status = 'active' ORDER BY slot_number"
  ).bind(ctx.licenseId).all();
  return json({
    items: (rows.results || []).map((row) => ({
      deviceId: row.id,
      slot: row.slot_number === 2 ? "VENTAS_1" : "VENTAS_2",
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at
    }))
  });
}

async function createReplacementRequest(request, env) {
  const checked = await verifyBusinessProof(request, env, "PATRON_REPLACEMENT_REQUEST");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "PATRON");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const oldDeviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
  if (!/^[0-9a-f-]{36}$/i.test(oldDeviceId) || !reason ||
      Object.keys(body).some((key) => !["deviceId", "reason"].includes(key))) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const oldDevice = await env.DB.prepare(
    "SELECT id, device_type, slot_number, status FROM devices WHERE id = ? AND license_id = ? LIMIT 1"
  ).bind(oldDeviceId, ctx.licenseId).first();
  if (!oldDevice || oldDevice.device_type !== "VENTAS" || ![2, 3].includes(oldDevice.slot_number)) {
    return json({ error: "DEVICE_NOT_FOUND", message: "Solo se puede solicitar el reemplazo de Equipo 1 o Equipo 2." }, 404);
  }
  if (oldDevice.status !== "active") return json({ error: "DEVICE_NOT_ACTIVE" }, 409);

  const existing = await env.DB.prepare(
    "SELECT r.id, r.status, r.created_at, p.status AS payment_status FROM replacement_requests r JOIN replacement_payment_requests p ON p.replacement_request_id=r.id WHERE r.old_device_id=? AND p.status IN ('pending_payment','authorized') ORDER BY r.created_at DESC LIMIT 1"
  ).bind(oldDeviceId).first();
  if (existing) return json({
    requestId: existing.id, folio: existing.id, status: existing.payment_status, amountCents: 50000,
    currency: "MXN", createdAt: Number(existing.created_at), duplicate: true,
    instructions: `Reposición de equipo: paga $500 MXN. En el concepto o referencia escribe exactamente el folio: ${existing.id}. Envía el comprobante a AYUDA e incluye el mismo folio.`
  });

  const requestId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO replacement_requests (id,license_id,old_device_id,slot_number,reason,status,created_at) SELECT ?,?,?,?,?, 'pending', ? WHERE EXISTS (SELECT 1 FROM devices WHERE id=? AND license_id=? AND status='active')"
      ).bind(requestId, ctx.licenseId, oldDeviceId, oldDevice.slot_number, reason, now, oldDeviceId, ctx.licenseId),
      env.DB.prepare(
        "INSERT INTO replacement_payment_requests (id,replacement_request_id,license_id,old_device_id,slot_number,status,created_at) SELECT ?,?,?,?,?, 'pending_payment', ? WHERE EXISTS (SELECT 1 FROM replacement_requests WHERE id=? AND status='pending')"
      ).bind(paymentId, requestId, ctx.licenseId, oldDeviceId, oldDevice.slot_number, now, requestId),
      env.DB.prepare(
        "INSERT INTO audit_log (id,license_id,device_id,actor_type,actor_id,event_type,details_json,created_at) SELECT ?,?,?,'patron',?,'device_replacement_payment_requested',?,? WHERE EXISTS (SELECT 1 FROM replacement_payment_requests WHERE id=? AND status='pending_payment')"
      ).bind(crypto.randomUUID(), ctx.licenseId, oldDeviceId, ctx.deviceId, JSON.stringify({ requestId, slotNumber: oldDevice.slot_number, amountCents: 50000 }), now, paymentId)
    ]);
    if (results.some((x) => (x?.meta?.changes ?? 0) !== 1)) throw new Error("insert conflict");
  } catch {
    const raced = await env.DB.prepare(
      "SELECT r.id,r.status,r.created_at,p.status AS payment_status FROM replacement_requests r JOIN replacement_payment_requests p ON p.replacement_request_id=r.id WHERE r.old_device_id=? AND p.status IN ('pending_payment','authorized') ORDER BY r.created_at DESC LIMIT 1"
    ).bind(oldDeviceId).first();
    if (raced) return json({ requestId: raced.id, folio: raced.id, status: raced.payment_status, amountCents: 50000, currency: "MXN", createdAt: Number(raced.created_at), duplicate: true, instructions: `Reposición de equipo: paga $500 MXN. En el concepto o referencia escribe exactamente el folio: ${raced.id}. Envía el comprobante a AYUDA e incluye el mismo folio.` });
    return json({ error: "REPLACEMENT_REQUEST_CONFLICT" }, 409);
  }
  return json({
    requestId, folio: requestId, deviceId: oldDeviceId,
    slot: oldDevice.slot_number === 2 ? "VENTAS_1" : "VENTAS_2",
    status: "pending_payment", amountCents: 50000, currency: "MXN",
    createdAt: now,
    instructions: `Reposición de equipo: paga $500 MXN. En el concepto o referencia escribe exactamente el folio: ${requestId}. Envía el comprobante a AYUDA e incluye el mismo folio. El equipo anterior seguirá activo hasta canjear el código.`
  }, 201);
}

async function listOperatorReplacements(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  const rows = await env.DB.prepare(
    "SELECT r.id,r.license_id,l.business_name,r.old_device_id,r.slot_number,r.reason,r.created_at,p.id AS payment_request_id,p.status AS payment_status,p.payment_reference,p.delivery_phone,p.authorized_at FROM replacement_requests r JOIN replacement_payment_requests p ON p.replacement_request_id=r.id JOIN licenses l ON l.id=r.license_id WHERE p.status IN ('pending_payment','authorized') ORDER BY r.created_at ASC LIMIT 100"
  ).all();
  return json({ items: rows.results || [] });
}

async function authorizeOperatorReplacement(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const paymentReference = typeof body.paymentReference === "string" ? body.paymentReference.trim().slice(0,120) : "";
  const deliveryPhone = typeof body.deliveryPhone === "string" ? body.deliveryPhone.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !paymentReference || !deliveryPhone ||
      Object.keys(body).some((key) => !["requestId","paymentReference","deliveryPhone"].includes(key))) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  if (!(await requireOfficialHelpRecipient(env, deliveryPhone))) return json({ error: "UNOFFICIAL_CODE_RECIPIENT" }, 403);
  const row = await env.DB.prepare(
    "SELECT p.*,r.status AS request_status FROM replacement_payment_requests p JOIN replacement_requests r ON r.id=p.replacement_request_id WHERE p.replacement_request_id=? LIMIT 1"
  ).bind(requestId).first();
  if (!row) return json({ error: "REPLACEMENT_NOT_FOUND" }, 404);
  if (row.status === "authorized") {
    if (row.payment_reference !== paymentReference ||
        normalizeOfficialPhone(row.delivery_phone || "") !== normalizeOfficialPhone(deliveryPhone) ||
        !row.encrypted_code) {
      return json({ error: "REPLACEMENT_ALREADY_AUTHORIZED" }, 409);
    }
    try {
      const existingCode = await decryptPairingToken(row.encrypted_code, env);
      return json({ requestId, authorizationCode: existingCode, amountCents: 50000,
        currency: "MXN", reused: true,
        note: "Se reutilizó el mismo código de un solo uso. Entregar únicamente al número oficial AYUDA." });
    } catch {
      return json({ error: "REPLACEMENT_CODE_RECOVERY_FAILED" }, 503);
    }
  }
  if (row.status !== "pending_payment" || row.request_status !== "pending") return json({ error: "REPLACEMENT_NOT_PENDING" }, 409);
  const oldDevice = await env.DB.prepare(
    "SELECT id FROM devices WHERE id=? AND license_id=? AND device_type='VENTAS' AND slot_number=? AND status='active' LIMIT 1"
  ).bind(row.old_device_id,row.license_id,row.slot_number).first();
  if (!oldDevice) return json({ error: "OLD_DEVICE_NOT_ACTIVE" }, 409);

  const code = makeCode();
  const codeHash = await sha256(code);
  let encryptedCode;
  try { encryptedCode = await encryptPairingToken(code, env); }
  catch { return json({ error: "REPLACEMENT_CODE_ENCRYPTION_NOT_CONFIGURED" }, 503); }
  const normalizedDeliveryPhone = normalizeOfficialPhone(deliveryPhone);
  const now = Math.floor(Date.now()/1000);
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE replacement_payment_requests SET status='authorized',code_hash=?,encrypted_code=?,delivery_phone=?,payment_reference=?,authorized_at=? WHERE id=? AND status='pending_payment' AND EXISTS (SELECT 1 FROM devices WHERE id=? AND status='active')"
    ).bind(codeHash,encryptedCode,normalizedDeliveryPhone,paymentReference,now,row.id,row.old_device_id),
    env.DB.prepare(
      "INSERT INTO audit_log (id,license_id,device_id,actor_type,actor_id,event_type,details_json,created_at) SELECT ?,?,?,'operator','operator','device_replacement_payment_authorized',?,? WHERE EXISTS (SELECT 1 FROM replacement_payment_requests WHERE id=? AND status='authorized' AND code_hash=?)"
    ).bind(crypto.randomUUID(),row.license_id,row.old_device_id,JSON.stringify({requestId,amountCents:50000,paymentReference}),now,row.id,codeHash)
  ]);
  if (results.some((x)=>(x?.meta?.changes??0)!==1)) return json({error:"REPLACEMENT_AUTHORIZATION_CONFLICT"},409);
  return json({requestId,authorizationCode:code,amountCents:50000,currency:"MXN",
    note:"Código de un solo uso. Entregar únicamente al número oficial AYUDA después de verificar el pago. El equipo anterior sigue activo hasta el canje."},201);
}

async function redeemReplacement(request, env) {
  const checked = await verifyBusinessProof(request, env, "PATRON_REPLACEMENT_REDEEM");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "PATRON");
  if (ctx.error) return json({error:ctx.error},ctx.status);
  let body;
  try { body=JSON.parse(proof.bodyText); } catch { return json({error:"INVALID_REQUEST"},400); }
  const requestId=typeof body.requestId==="string"?body.requestId:"";
  const code=typeof body.authorizationCode==="string"?body.authorizationCode.trim().toUpperCase():"";
  if (!/^[0-9a-f-]{36}$/i.test(requestId)||!/^[A-HJ-NP-Z2-9]{12}$/.test(code)||
      Object.keys(body).some((key)=>!["requestId","authorizationCode"].includes(key))) {
    return json({error:"INVALID_REQUEST"},400);
  }
  const codeHash=await sha256(code);
  const row=await env.DB.prepare(
    "SELECT p.id,p.replacement_request_id,p.old_device_id,p.slot_number,p.status,r.status AS request_status FROM replacement_payment_requests p JOIN replacement_requests r ON r.id=p.replacement_request_id WHERE p.replacement_request_id=? AND p.license_id=? AND p.code_hash=? LIMIT 1"
  ).bind(requestId,ctx.licenseId,codeHash).first();
  if (!row||row.status!=="authorized"||row.request_status!=="pending") return json({error:"REPLACEMENT_CODE_INVALID_OR_USED"},409);
  const now=Math.floor(Date.now()/1000);
  const results=await env.DB.batch([
    env.DB.prepare(
      "UPDATE replacement_payment_requests SET status='consumed',consumed_at=? WHERE id=? AND status='authorized' AND code_hash=? AND EXISTS (SELECT 1 FROM devices WHERE id=? AND license_id=? AND device_type='VENTAS' AND slot_number=? AND status='active')"
    ).bind(now,row.id,codeHash,row.old_device_id,ctx.licenseId,row.slot_number),
    env.DB.prepare(
      "UPDATE devices SET status='revoked' WHERE id=? AND license_id=? AND device_type='VENTAS' AND slot_number=? AND status='active' AND EXISTS (SELECT 1 FROM replacement_payment_requests WHERE id=? AND status='consumed')"
    ).bind(row.old_device_id,ctx.licenseId,row.slot_number,row.id),
    env.DB.prepare(
      "UPDATE replacement_requests SET status='approved',decided_at=?,decided_by='operator' WHERE id=? AND status='pending' AND EXISTS (SELECT 1 FROM replacement_payment_requests WHERE id=? AND status='consumed') AND EXISTS (SELECT 1 FROM devices WHERE id=? AND status='revoked')"
    ).bind(now,requestId,row.id,row.old_device_id),
    env.DB.prepare(
      "UPDATE pairing_tokens SET revoked_at=? WHERE license_id=? AND revoked_at IS NULL AND (slot_number=? OR slot_number IS NULL) AND EXISTS (SELECT 1 FROM replacement_requests WHERE id=? AND status='approved')"
    ).bind(now,ctx.licenseId,row.slot_number,requestId),
    env.DB.prepare(
      "INSERT INTO audit_log (id,license_id,device_id,actor_type,actor_id,event_type,details_json,created_at) SELECT ?,?,?,'patron',?,'device_replacement_code_redeemed',?,? WHERE EXISTS (SELECT 1 FROM replacement_requests WHERE id=? AND status='approved')"
    ).bind(crypto.randomUUID(),ctx.licenseId,row.old_device_id,ctx.deviceId,JSON.stringify({requestId,slotNumber:row.slot_number}),now,requestId)
  ]);
  // Pairing-token revocation may legitimately affect zero rows when no token is open.
  // The payment, old device, request, and audit records must each change exactly once.
  if ([0,1,2,4].some((index)=>(results[index]?.meta?.changes??0)!==1)) {
    return json({error:"REPLACEMENT_REDEEM_CONFLICT"},409);
  }
  return json({requestId,status:"consumed",slot:row.slot_number===2?"VENTAS_1":"VENTAS_2",
    oldDeviceRevoked:true,nextStep:"Genera un QR de reemplazo para el mismo espacio y vincula el nuevo equipo."});
}

async function decideOperatorReplacement(request, env, decision) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  if (decision !== "reject") return json({
    error: "PAYMENT_WORKFLOW_REQUIRED",
    message: "La aprobación requiere validar el pago de $500 MXN y emitir un código de un solo uso."
  }, 410);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId) ||
      Object.keys(body).some((key) => key !== "requestId")) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const row = await env.DB.prepare(
    "SELECT id, license_id, old_device_id, slot_number FROM replacement_requests WHERE id = ? AND status = 'pending' LIMIT 1"
  ).bind(requestId).first();
  if (!row) return json({ error: "REPLACEMENT_NOT_PENDING" }, 409);
  const now = Math.floor(Date.now() / 1000);
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE replacement_requests SET status='rejected',decided_at=?,decided_by='operator' WHERE id=? AND status='pending'"
      ).bind(now, requestId),
      env.DB.prepare(
        "UPDATE replacement_payment_requests SET status='cancelled' WHERE replacement_request_id=? AND status IN ('pending_payment','authorized')"
      ).bind(requestId),
      env.DB.prepare(
        "INSERT INTO audit_log (id,license_id,device_id,actor_type,actor_id,event_type,details_json,created_at) SELECT ?,?,old_device_id,'operator','operator','device_replacement_rejected',?,? FROM replacement_requests WHERE id=? AND status='rejected' AND decided_at=?"
      ).bind(crypto.randomUUID(), row.license_id, JSON.stringify({ requestId }), now, requestId, now)
    ]);
    if ((results?.[0]?.meta?.changes ?? 0) !== 1 ||
        (results?.[2]?.meta?.changes ?? 0) !== 1) {
      return json({ error: "REPLACEMENT_CONFLICT" }, 409);
    }
    return json({ requestId, status: "rejected", paymentCancelled: (results?.[1]?.meta?.changes ?? 0) === 1 });
  } catch {
    return json({ error: "SERVICE_UNAVAILABLE" }, 503);
  }
}

async function createCorrectionRequest(request, env) {
  const checked = await verifyBusinessProof(request, env, "VENTAS_CORRECTION_CREATE");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "VENTAS");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const saleId = typeof body.saleId === "string" ? body.saleId.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const allowedReasons = new Set([
    "Devolución", "Ajuste de precio", "Eliminación de producto",
    "Corrección de cantidad", "Producto equivocado", "Producto omitido", "Otro"
  ]);
  const allowedCashReasons = new Set([
    "Devolución al cliente", "Diferencia por precio vigente", "Cantidad corregida",
    "Producto eliminado o incorrecto", "Producto omitido", "Otro"
  ]);
  const reasons = Array.isArray(body.reasons) ? [...new Set(body.reasons)] : [reason];
  const planHash = typeof body.planHash === "string" ? body.planHash.toLowerCase() : "";
  const cashImpact = body.cashImpact === true;
  const cashReason = typeof body.cashReason === "string" ? body.cashReason.trim() : "";
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
  // El servidor recibe categorías y hash; nunca renglones, precios, cantidades ni importes.
  if (!saleId || saleId.length > 120 || !allowedReasons.has(reason) ||
      !reasons.length || reasons.length > 7 || reasons.some((item) => !allowedReasons.has(item)) ||
      !/^[a-f0-9]{64}$/.test(planHash) ||
      (cashImpact ? !allowedCashReasons.has(cashReason) : cashReason !== "") ||
      !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) return json({ error: "INVALID_REQUEST" }, 400);
  const existing = await env.DB.prepare(
    "SELECT id, status, created_at, sale_id, plan_hash FROM correction_requests WHERE ventas_device_id = ? AND idempotency_key = ? LIMIT 1"
  ).bind(ctx.deviceId, idempotencyKey).first();
  if (existing) {
    if (existing.plan_hash !== planHash) return json({ error: "IDEMPOTENCY_PLAN_MISMATCH" }, 409);
    return json({ requestId: existing.id, saleId: existing.sale_id, status: existing.status, createdAt: existing.created_at, planHash: existing.plan_hash, duplicate: true });
  }
  const activeForSale = await env.DB.prepare(
    "SELECT id, status FROM correction_requests WHERE ventas_device_id = ? AND sale_id = ? AND status IN ('pending', 'approved', 'consumed') LIMIT 1"
  ).bind(ctx.deviceId, saleId).first();
  if (activeForSale) return json({ error: "CORRECTION_ALREADY_EXISTS", status: activeForSale.status }, 409);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO correction_requests (id, license_id, ventas_device_id, sale_id, reason, reasons_json, cash_impact, cash_reason, plan_hash, status, created_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)"
      ).bind(id, ctx.licenseId, ctx.deviceId, saleId, reason, JSON.stringify(reasons), cashImpact ? 1 : 0, cashReason || null, planHash, now, idempotencyKey),
      env.DB.prepare(
        "INSERT INTO audit_log (id, license_id, device_id, actor_type, actor_id, event_type, details_json, created_at) VALUES (?, ?, ?, 'ventas', ?, 'correction_requested', ?, ?)"
      ).bind(crypto.randomUUID(), ctx.licenseId, ctx.deviceId, ctx.deviceId, JSON.stringify({ requestId: id, saleId, reasons, cashImpact, cashReason: cashReason || null }), now)
    ]);
  } catch {
    const raced = await env.DB.prepare(
      "SELECT id, status, created_at, sale_id, plan_hash FROM correction_requests WHERE ventas_device_id = ? AND idempotency_key = ? LIMIT 1"
    ).bind(ctx.deviceId, idempotencyKey).first();
    if (raced && raced.plan_hash === planHash) return json({ requestId: raced.id, saleId: raced.sale_id, status: raced.status, createdAt: raced.created_at, planHash: raced.plan_hash, duplicate: true });
    return json({ error: "CORRECTION_REQUEST_CONFLICT" }, 409);
  }
  return json({ requestId: id, saleId, status: "pending", createdAt: now, planHash }, 201);
}

async function patronCorrectionsInbox(request, env) {
  const checked = await verifyBusinessProof(request, env, "PATRON_CORRECTIONS_INBOX");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "PATRON");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const slot = body.slot === "VENTAS_1" ? 2 : body.slot === "VENTAS_2" ? 3 : null;
  const status = body.status === "all" ? "all" : "pending";
  if (!slot) return json({ error: "INVALID_REQUEST" }, 400);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE correction_requests SET seen_at = ? WHERE status = 'pending' AND seen_at IS NULL AND ventas_device_id IN (SELECT id FROM devices WHERE license_id = ? AND slot_number = ? AND status = 'active')"
  ).bind(now, ctx.licenseId, slot).run();
  const rows = await env.DB.prepare(
    "SELECT r.id, r.sale_id, r.reason, r.reasons_json, r.cash_impact, r.cash_reason, r.plan_hash, r.status, r.created_at, r.decided_at FROM correction_requests r JOIN devices d ON d.id = r.ventas_device_id WHERE r.license_id = ? AND d.slot_number = ? AND (? = 'all' OR r.status = 'pending') ORDER BY r.created_at DESC LIMIT 100"
  ).bind(ctx.licenseId, slot, status).all();
  const counts = await env.DB.prepare(
    "SELECT d.slot_number, (SELECT COUNT(*) FROM work_requests w WHERE w.ventas_device_id = d.id AND w.status = 'pending') + (SELECT COUNT(*) FROM correction_requests c WHERE c.ventas_device_id = d.id AND c.status = 'pending') AS pending_count FROM devices d WHERE d.license_id = ? AND d.device_type = 'VENTAS' AND d.status = 'active' ORDER BY d.slot_number"
  ).bind(ctx.licenseId).all();
  const pendingByTeam = { VENTAS_1: 0, VENTAS_2: 0 };
  for (const row of (counts.results || [])) {
    if (row.slot_number === 2) pendingByTeam.VENTAS_1 = Number(row.pending_count);
    if (row.slot_number === 3) pendingByTeam.VENTAS_2 = Number(row.pending_count);
  }
  const items = (rows.results || []).map((r) => ({
    requestId: r.id, saleId: r.sale_id, reason: r.reason,
    reasons: (() => { try { return JSON.parse(r.reasons_json || "[]"); } catch { return [r.reason]; } })(),
    cashImpact: Number(r.cash_impact) === 1, cashReason: r.cash_reason || "",
    planHash: r.plan_hash, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at
  }));
  const cursor = Math.max(0, ...items.map((r) => Number(r.decidedAt || r.createdAt || 0)));
  const stream = "PATRON_CORRECTIONS_" + (slot === 2 ? "VENTAS_1" : "VENTAS_2");
  const payload = { slot: slot === 2 ? "VENTAS_1" : "VENTAS_2", pendingByTeam, items, cursor };
  return json(await recordUniversalDelivery(env, ctx, stream, payload));
}

async function decideCorrectionRequest(request, env) {
  const checked = await verifyBusinessProof(request, env, "PATRON_CORRECTION_DECISION");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "PATRON");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const decision = body.decision === "approve" ? "approved" : body.decision === "reject" ? "rejected" : "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !decision) return json({ error: "INVALID_REQUEST" }, 400);
  const row = await env.DB.prepare(
    "SELECT id, license_id, ventas_device_id, sale_id, plan_hash FROM correction_requests WHERE id = ? AND license_id = ? AND status = 'pending' LIMIT 1"
  ).bind(requestId, ctx.licenseId).first();
  if (!row) return json({ error: "CORRECTION_NOT_PENDING" }, 409);
  const now = Math.floor(Date.now() / 1000);
  const grantId = decision === "approved" ? crypto.randomUUID() : null;
  try {
    const statements = [
      env.DB.prepare(
        "UPDATE correction_requests SET status = ?, decided_at = ? WHERE id = ? AND license_id = ? AND status = 'pending'"
      ).bind(decision, now, requestId, ctx.licenseId)
    ];
    if (decision === "approved") statements.push(env.DB.prepare(
      "INSERT INTO correction_grants (id, request_id, license_id, ventas_device_id, sale_id, plan_hash, uses_allowed, uses_consumed, created_at) SELECT ?, id, license_id, ventas_device_id, sale_id, plan_hash, 1, 0, ? FROM correction_requests WHERE id = ? AND status = 'approved' AND decided_at = ?"
    ).bind(grantId, now, requestId, now));
    statements.push(env.DB.prepare(
      "INSERT INTO audit_log (id, license_id, device_id, actor_type, actor_id, event_type, details_json, created_at) SELECT ?, ?, ?, 'patron', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM correction_requests WHERE id = ? AND status = ? AND decided_at = ?)"
    ).bind(crypto.randomUUID(), ctx.licenseId, row.ventas_device_id, ctx.deviceId, decision === "approved" ? "correction_approved" : "correction_rejected", JSON.stringify({ requestId, saleId: row.sale_id, grantId }), now, requestId, decision, now));
    const results = await env.DB.batch(statements);
    if ((results?.[0]?.meta?.changes ?? 0) !== 1 ||
        (decision === "approved" && (results?.[1]?.meta?.changes ?? 0) !== 1)) {
      return json({ error: "CORRECTION_DECISION_CONFLICT" }, 409);
    }
  } catch {
    return json({ error: "CORRECTION_DECISION_CONFLICT" }, 409);
  }
  return json({ requestId, saleId: row.sale_id, status: decision, grantId, planHash: row.plan_hash, usesAllowed: decision === "approved" ? 1 : 0, decidedAt: now });
}

async function consumeCorrectionGrant(request, env) {
  const checked = await verifyBusinessProof(request, env, "VENTAS_CORRECTION_CONSUME");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "VENTAS");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const grantId = typeof body.grantId === "string" ? body.grantId : "";
  const saleId = typeof body.saleId === "string" ? body.saleId.trim() : "";
  const planHash = typeof body.planHash === "string" ? body.planHash.toLowerCase() : "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !/^[0-9a-f-]{36}$/i.test(grantId) || !saleId || !/^[a-f0-9]{64}$/.test(planHash)) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  // Idempotencia de recuperación: si el consumo ya se confirmó en D1 pero
  // la respuesta HTTPS se perdió, el mismo equipo puede repetir la petición.
  // Solo se reconoce el mismo permiso ya consumido para la misma venta,
  // licencia y dispositivo; nunca se restaura ni se vuelve a consumir.
  let priorConsumption;
  try {
    priorConsumption = await env.DB.prepare(
      `SELECT g.consumed_at
         FROM correction_grants g
         JOIN correction_requests r ON r.id = g.request_id
        WHERE g.id = ? AND g.request_id = ? AND g.license_id = ?
          AND g.ventas_device_id = ? AND g.sale_id = ? AND g.plan_hash = ?
          AND g.uses_allowed = 1 AND g.uses_consumed = 1
          AND r.id = ? AND r.license_id = ? AND r.ventas_device_id = ?
          AND r.sale_id = ? AND r.plan_hash = ? AND r.status = 'consumed'
        LIMIT 1`
    ).bind(grantId, requestId, ctx.licenseId, ctx.deviceId, saleId, planHash,
      requestId, ctx.licenseId, ctx.deviceId, saleId, planHash).first();
  } catch {
    return json({ error: "CORRECTION_GRANT_CHECK_FAILED" }, 503);
  }
  if (priorConsumption) {
    return json({
      authorized: true, requestId, grantId, saleId, planHash,
      consumedAt: Number(priorConsumption.consumed_at),
      usesRemaining: 0, idempotentReplay: true
    });
  }

  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE correction_grants SET uses_consumed = 1, consumed_at = ? WHERE id = ? AND request_id = ? AND license_id = ? AND ventas_device_id = ? AND sale_id = ? AND plan_hash = ? AND uses_allowed = 1 AND uses_consumed = 0 AND EXISTS (SELECT 1 FROM correction_requests WHERE id = ? AND status = 'approved' AND sale_id = ? AND plan_hash = ?)"
      ).bind(now, grantId, requestId, ctx.licenseId, ctx.deviceId, saleId, planHash, requestId, saleId, planHash),
      env.DB.prepare(
        "UPDATE correction_requests SET status = 'consumed' WHERE id = ? AND license_id = ? AND ventas_device_id = ? AND sale_id = ? AND status = 'approved' AND EXISTS (SELECT 1 FROM correction_grants WHERE id = ? AND uses_consumed = 1 AND consumed_at = ?)"
      ).bind(requestId, ctx.licenseId, ctx.deviceId, saleId, grantId, now),
      env.DB.prepare(
        "INSERT INTO audit_log (id, license_id, device_id, actor_type, actor_id, event_type, details_json, created_at) SELECT ?, ?, ?, 'ventas', ?, 'correction_grant_consumed', ?, ? WHERE EXISTS (SELECT 1 FROM correction_requests WHERE id = ? AND status = 'consumed')"
      ).bind(crypto.randomUUID(), ctx.licenseId, ctx.deviceId, ctx.deviceId, JSON.stringify({ requestId, grantId, saleId }), now, requestId)
    ]);
  } catch {
    return json({ error: "CORRECTION_GRANT_CONFLICT" }, 409);
  }
  if ((results?.[0]?.meta?.changes ?? 0) !== 1 || (results?.[1]?.meta?.changes ?? 0) !== 1) {
    return json({ error: "GRANT_ALREADY_CONSUMED_OR_MISMATCH" }, 409);
  }
  return json({ authorized: true, requestId, grantId, saleId, planHash, consumedAt: now, usesRemaining: 0 });
}

async function deviceSession(request, env) {
  const proof = await verifySignedRequest(request, env, "DEVICE_AUTH");
  if (!proof.ok) return json({ error: proof.error }, proof.status);

  let body;
  try { body = JSON.parse(proof.bodyText); } catch {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }

  const deviceId = proof.challenge.device_id;
  const row = await env.DB.prepare(
    `SELECT d.id AS device_id, d.device_type, d.slot_number, d.status AS device_status,
            l.id AS license_id, l.business_name, l.status AS license_status, l.expires_at,
            (SELECT COUNT(*) FROM devices v WHERE v.license_id = l.id AND v.device_type = 'VENTAS' AND v.status = 'active') AS linked_ventas_count
       FROM devices d JOIN licenses l ON l.id = d.license_id
      WHERE d.id = ? LIMIT 1`
  ).bind(deviceId).first();

  if (!row || row.device_status !== "active") {
    return json({ error: "DEVICE_NOT_REGISTERED" }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  let licenseStatus = row.license_status;
  if (row.expires_at !== null && row.expires_at !== undefined && row.expires_at <= now &&
      licenseStatus === "active") {
    licenseStatus = "expired";
  }

  const weekKey = mexicoCityIsoWeek(now);
  const usage = await env.DB.prepare(
    "SELECT used FROM weekly_usage WHERE device_id = ? AND week_key = ? LIMIT 1"
  ).bind(deviceId, weekKey).first();
  const used = Math.max(0, Math.min(20, Number(usage?.used ?? 0)));

  await env.DB.prepare(
    "UPDATE devices SET last_seen_at = ? WHERE id = ? AND status = 'active'"
  ).bind(now, deviceId).run();

  let payroll = null;
  if (row.device_type === "VENTAS" && [2, 3].includes(Number(row.slot_number))) {
    const settings = await env.DB.prepare(
      "SELECT payment_day, payment_dates_json FROM payroll_settings WHERE license_id = ? AND slot_number = ? LIMIT 1"
    ).bind(row.license_id, Number(row.slot_number)).first();
    const mexicoDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date(now * 1000));
    let paymentDates = [];
    try { paymentDates = JSON.parse(settings?.payment_dates_json || "[]"); } catch { paymentDates = []; }
    const paymentDay = settings?.payment_day === null || settings?.payment_day === undefined
      ? null : Number(settings.payment_day);
    const configured = Boolean(settings) && (paymentDay !== null || (Array.isArray(paymentDates) && paymentDates.length > 0));
    const dueToday = configured && (
      (paymentDay !== null && paymentDay === Number(mexicoDate.slice(8, 10))) ||
      (Array.isArray(paymentDates) && paymentDates.includes(mexicoDate))
    );
    payroll = { configured, dueToday, mexicoDate, paymentDay, paymentDates: Array.isArray(paymentDates) ? paymentDates : [] };
  }

  return json({
    deviceId,
    role: row.device_type,
    businessName: row.business_name ?? null,
    slot: row.device_type === "PATRON" ? "PATRON" : `VENTAS_${row.slot_number - 1}`,
    licenseStatus: licenseStatus === "active" ? "ACTIVE" : licenseStatus.toUpperCase(),
    serverTime: now,
    periodEndsAt: row.expires_at ?? null,
    linkedVentasCount: Number(row.linked_ventas_count || 0),
    weeklyQuota: { limit: 20, used, remaining: Math.max(0, 20 - used), weekKey },
    payroll
  });
}



const WORK_REQUEST_TYPES = new Set([
  "LOAN", "CONSUMPTION", "ABSENCE_PERMISSION", "LATE_ARRIVAL",
  "SCHEDULE_CHANGE", "VACATION", "INCIDENT", "SHORTAGE",
  "REST_DAY_CHANGE", "SALARY_ADVANCE", "DAMAGED_EQUIPMENT", "SUGGESTION"
]);

async function signedDeviceContext(proof, expectedType, consumeQuota = true) {
  const deviceId = proof.challenge.device_id;
  const row = await proof.env.DB.prepare(
    "SELECT d.id, d.device_type, d.slot_number, d.license_id, d.status, l.status AS license_status, l.expires_at FROM devices d JOIN licenses l ON l.id = d.license_id WHERE d.id = ? LIMIT 1"
  ).bind(deviceId).first();
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.status !== "active" || (expectedType && row.device_type !== expectedType)) {
    return { error: "DEVICE_NOT_REGISTERED", status: 401 };
  }
  if (row.license_status !== "active" || !row.expires_at || row.expires_at <= now) {
    return { error: "LICENSE_EXPIRED", status: 403 };
  }
  if (consumeQuota) {
    const quotaError = await consumeWeeklyQuota(proof.env, deviceId);
    if (quotaError) return quotaError;
  }
  return { deviceId, licenseId: row.license_id, deviceType: row.device_type, slotNumber: row.slot_number };
}

async function verifyBusinessProof(request, env, purpose) {
  const proof = await verifySignedRequest(request, env, purpose);
  if (!proof.ok) return { response: json({ error: proof.error }, proof.status) };
  proof.env = env;
  return { proof };
}

async function createWorkRequest(request, env) {
  const checked = await verifyBusinessProof(request, env, "VENTAS_REQUEST");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "VENTAS");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const type = typeof body.type === "string" ? body.type : "";
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
  if (!WORK_REQUEST_TYPES.has(type) || !/^[0-9a-f-]{36}$/i.test(idempotencyKey) ||
      !body.details || typeof body.details !== "object" || Array.isArray(body.details)) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const detailsJson = JSON.stringify(body.details);
  if (detailsJson.length > 8192) return json({ error: "REQUEST_TOO_LARGE" }, 413);
  const existing = await env.DB.prepare(
    "SELECT id, status, created_at FROM work_requests WHERE ventas_device_id = ? AND idempotency_key = ? LIMIT 1"
  ).bind(ctx.deviceId, idempotencyKey).first();
  if (existing) return json({ requestId: existing.id, status: existing.status, createdAt: existing.created_at, duplicate: true });
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      "INSERT INTO work_requests (id, license_id, ventas_device_id, request_type, details_json, status, created_at, idempotency_key) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)"
    ).bind(id, ctx.licenseId, ctx.deviceId, type, detailsJson, now, idempotencyKey).run();
  } catch {
    const raced = await env.DB.prepare(
      "SELECT id, status, created_at FROM work_requests WHERE ventas_device_id = ? AND idempotency_key = ? LIMIT 1"
    ).bind(ctx.deviceId, idempotencyKey).first();
    if (raced) return json({ requestId: raced.id, status: raced.status, createdAt: raced.created_at, duplicate: true });
    return json({ error: "SERVICE_UNAVAILABLE" }, 503);
  }
  return json({ requestId: id, status: "pending", createdAt: now }, 201);
}

async function patronRequestsInbox(request, env) {
  const checked = await verifyBusinessProof(request, env, "PATRON_REQUESTS_INBOX");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "PATRON");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const slot = body.slot === "VENTAS_1" || body.slot === "VENTAS_2" ? body.slot : null;
  if (!slot) return json({ error: "INVALID_TEAM_SLOT" }, 400);
  const status = body.status === "all" ? "all" : "pending";
  const slotNumber = slot === "VENTAS_1" ? 2 : 3;
  if (slotNumber !== null) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "UPDATE work_requests SET seen_at = ? WHERE status = 'pending' AND seen_at IS NULL AND ventas_device_id IN (SELECT id FROM devices WHERE license_id = ? AND slot_number = ? AND status = 'active')"
    ).bind(now, ctx.licenseId, slotNumber).run();
  }
  const rows = await env.DB.prepare(
    "SELECT r.id, r.request_type, r.details_json, r.status, r.created_at, r.decided_at, d.slot_number FROM work_requests r JOIN devices d ON d.id = r.ventas_device_id WHERE r.license_id = ? AND (? IS NULL OR d.slot_number = ?) AND (? = 'all' OR r.status = 'pending') ORDER BY r.created_at DESC LIMIT 100"
  ).bind(ctx.licenseId, slotNumber, slotNumber, status).all();
  const correctionSeenAt = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE correction_requests SET seen_at = ? WHERE status = 'pending' AND seen_at IS NULL AND ventas_device_id IN (SELECT id FROM devices WHERE license_id = ? AND slot_number = ? AND status = 'active')"
  ).bind(correctionSeenAt, ctx.licenseId, slotNumber).run();
  const correctionRows = await env.DB.prepare(
    "SELECT r.id, r.sale_id, r.reason, r.status, r.created_at, r.decided_at FROM correction_requests r JOIN devices d ON d.id = r.ventas_device_id WHERE r.license_id = ? AND d.slot_number = ? AND (? = 'all' OR r.status = 'pending') ORDER BY r.created_at DESC LIMIT 100"
  ).bind(ctx.licenseId, slotNumber, status).all();
  const counts = await env.DB.prepare(
    "SELECT d.slot_number, (SELECT COUNT(*) FROM work_requests r WHERE r.ventas_device_id = d.id AND r.status = 'pending') + (SELECT COUNT(*) FROM correction_requests c WHERE c.ventas_device_id = d.id AND c.status = 'pending') AS pending_count FROM devices d WHERE d.license_id = ? AND d.device_type = 'VENTAS' AND d.status = 'active' ORDER BY d.slot_number"
  ).bind(ctx.licenseId).all();
  const pendingByTeam = { VENTAS_1: 0, VENTAS_2: 0 };
  for (const row of (counts.results || [])) {
    if (row.slot_number === 2) pendingByTeam.VENTAS_1 = Number(row.pending_count);
    if (row.slot_number === 3) pendingByTeam.VENTAS_2 = Number(row.pending_count);
  }
  const items = (rows.results || []).map((r) => ({
    requestId: r.id, type: r.request_type, details: JSON.parse(r.details_json),
    status: r.status, createdAt: r.created_at, decidedAt: r.decided_at,
    slot: r.slot_number === 2 ? "VENTAS_1" : "VENTAS_2"
  }));
  const corrections = (correctionRows.results || []).map((r) => ({
    requestId: r.id, saleId: r.sale_id, reason: r.reason, status: r.status,
    createdAt: r.created_at, decidedAt: r.decided_at
  }));
  const cursor = Math.max(0,
    ...items.map((r) => Number(r.decidedAt || r.createdAt || 0)),
    ...corrections.map((r) => Number(r.decidedAt || r.createdAt || 0))
  );
  const stream = "PATRON_REQUESTS_" + slot;
  const payload = { pendingByTeam, items, corrections, cursor };
  return json(await recordUniversalDelivery(env, ctx, stream, payload));
}

async function ventasPayrollSettingsGet(request, env) {
  const checked = await verifyBusinessProof(request, env, "VENTAS_PAYROLL_SETTINGS_GET");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "VENTAS");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const device = await env.DB.prepare(
    "SELECT slot_number FROM devices WHERE id = ? AND license_id = ? AND device_type = 'VENTAS' AND status = 'active' LIMIT 1"
  ).bind(ctx.deviceId, ctx.licenseId).first();
  if (!device || ![2, 3].includes(Number(device.slot_number))) return json({ error: "DEVICE_SLOT_INVALID" }, 403);
  const row = await env.DB.prepare(
    "SELECT salary_cents, payment_day, payment_dates_json, updated_at FROM payroll_settings WHERE license_id = ? AND slot_number = ? LIMIT 1"
  ).bind(ctx.licenseId, Number(device.slot_number)).first();
  const lastReport = await env.DB.prepare(
    "SELECT period_key, created_at FROM payroll_reports WHERE ventas_device_id = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(ctx.deviceId).first();
  if (!row) return json({
    configured: false, settings: null,
    lastReportPeriodKey: lastReport?.period_key || null,
    lastReportCreatedAt: Number(lastReport?.created_at || 0)
  });
  let paymentDates;
  try { paymentDates = JSON.parse(row.payment_dates_json || "[]"); } catch { return json({ error: "PAYROLL_SETTINGS_INVALID" }, 503); }
  if (!Array.isArray(paymentDates) || paymentDates.some((date) =>
    typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    return json({ error: "PAYROLL_SETTINGS_INVALID" }, 503);
  }
  return json({
    configured: true,
    settings: {
      slot: Number(device.slot_number) === 2 ? "VENTAS_1" : "VENTAS_2",
      salaryCents: Number(row.salary_cents),
      paymentDay: row.payment_day === null ? null : Number(row.payment_day),
      paymentDates,
      updatedAt: Number(row.updated_at)
    },
    lastReportPeriodKey: lastReport?.period_key || null,
    lastReportCreatedAt: Number(lastReport?.created_at || 0)
  });
}

async function patronPayrollSettingsGet(request, env) {
  const checked = await verifyBusinessProof(request, env, "PATRON_PAYROLL_SETTINGS_GET");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "PATRON");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const rows = await env.DB.prepare(
    "SELECT slot_number, salary_cents, payment_day, payment_dates_json, updated_at FROM payroll_settings WHERE license_id = ? ORDER BY slot_number"
  ).bind(ctx.licenseId).all();
  const settings = { VENTAS_1: null, VENTAS_2: null };
  for (const row of (rows.results || [])) {
    settings[row.slot_number === 2 ? "VENTAS_1" : "VENTAS_2"] = {
      salaryCents: Number(row.salary_cents),
      paymentDay: row.payment_day === null ? null : Number(row.payment_day),
      paymentDates: JSON.parse(row.payment_dates_json || "[]"),
      updatedAt: Number(row.updated_at)
    };
  }
  return json({ settings, serverTime: Math.floor(Date.now() / 1000) });
}

async function patronPayrollSettingsSet(request, env) {
  const checked = await verifyBusinessProof(request, env, "PATRON_PAYROLL_SETTINGS_SET");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "PATRON");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const slot = body.slot === "VENTAS_1" ? 2 : body.slot === "VENTAS_2" ? 3 : null;
  const salaryCents = body.salaryCents;
  const paymentDay = body.paymentDay === null || body.paymentDay === undefined ? null : body.paymentDay;
  const paymentDates = body.paymentDates;
  if (!slot || !Number.isSafeInteger(salaryCents) || salaryCents <= 0 || salaryCents > 1000000000 ||
      (paymentDay !== null && (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31)) ||
      !Array.isArray(paymentDates) || paymentDates.length > 60 ||
      paymentDates.some((date) => typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date + "T00:00:00Z")) ||
        new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date)) {
    return json({ error: "INVALID_PAYROLL_SETTINGS" }, 400);
  }
  if (paymentDay === null && paymentDates.length === 0) {
    return json({ error: "PAYMENT_DATE_REQUIRED" }, 400);
  }
  const uniqueDates = [...new Set(paymentDates)].sort();
  const now = Math.floor(Date.now() / 1000);
  const settingsJson = JSON.stringify({ slot: slot === 2 ? "VENTAS_1" : "VENTAS_2", salaryCents, paymentDay, paymentDates: uniqueDates });
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO payroll_settings (license_id, slot_number, salary_cents, payment_day, payment_dates_json, updated_at, updated_by_device_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(license_id, slot_number) DO UPDATE SET salary_cents=excluded.salary_cents, payment_day=excluded.payment_day, payment_dates_json=excluded.payment_dates_json, updated_at=excluded.updated_at, updated_by_device_id=excluded.updated_by_device_id"
    ).bind(ctx.licenseId, slot, salaryCents, paymentDay, JSON.stringify(uniqueDates), now, ctx.deviceId),
    env.DB.prepare(
      "INSERT INTO audit_log (id, license_id, device_id, actor_type, actor_id, event_type, details_json, created_at) VALUES (?, ?, ?, 'patron', ?, 'payroll_settings_updated', ?, ?)"
    ).bind(crypto.randomUUID(), ctx.licenseId, ctx.deviceId, ctx.deviceId, settingsJson, now)
  ]);
  return json({
    slot: slot === 2 ? "VENTAS_1" : "VENTAS_2",
    salaryCents,
    paymentDay,
    paymentDates: uniqueDates,
    updatedAt: now
  });
}

async function patronNotifications(request, env) {
  const checked = await verifyBusinessProof(request, env, "PATRON_NOTIFICATIONS");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "PATRON");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  // El contador representa pendientes reales, no solo avisos sin leer.
  // Abrir una bandeja marca elementos como vistos, pero no debe volver rojo
  // el equipo mientras sigan existiendo solicitudes o correcciones pendientes.
  const rows = await env.DB.prepare(
    "SELECT d.slot_number, (SELECT COUNT(*) FROM work_requests w WHERE w.ventas_device_id = d.id AND w.status = 'pending') + (SELECT COUNT(*) FROM correction_requests c WHERE c.ventas_device_id = d.id AND c.status = 'pending') AS pending_count FROM devices d WHERE d.license_id = ? AND d.device_type = 'VENTAS' AND d.status = 'active' ORDER BY d.slot_number"
  ).bind(ctx.licenseId).all();
  const pendingByTeam = { VENTAS_1: 0, VENTAS_2: 0 };
  for (const row of (rows.results || [])) {
    if (row.slot_number === 2) pendingByTeam.VENTAS_1 = Number(row.pending_count);
    if (row.slot_number === 3) pendingByTeam.VENTAS_2 = Number(row.pending_count);
  }
  const cursorRow = await env.DB.prepare(
    `SELECT MAX(value) AS cursor FROM (
       SELECT MAX(COALESCE(decided_at,created_at)) AS value FROM work_requests WHERE license_id=?
       UNION ALL
       SELECT MAX(COALESCE(decided_at,created_at)) AS value FROM correction_requests WHERE license_id=?
     )`
  ).bind(ctx.licenseId, ctx.licenseId).first();
  const payload = {
    pendingByTeam,
    cursor: Number(cursorRow?.cursor || 0),
    serverTime: Math.floor(Date.now() / 1000)
  };
  return json(await recordUniversalDelivery(env, ctx, "PATRON_NOTIFICATIONS", payload));
}

async function decideWorkRequest(request, env) {
  const checked = await verifyBusinessProof(request, env, "PATRON_REQUEST_DECISION");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "PATRON");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const decision = body.decision === "approve" ? "approved" : body.decision === "reject" ? "rejected" : "";
  if (!requestId || !decision) return json({ error: "INVALID_REQUEST" }, 400);
  const decisionData = body.decisionDetails && typeof body.decisionDetails === "object" && !Array.isArray(body.decisionDetails)
    ? body.decisionDetails : {};
  if (decisionData.deduction !== undefined) {
    if (!decisionData.deduction || typeof decisionData.deduction !== "object" ||
        typeof decisionData.deduction.authorized !== "boolean") return json({ error: "INVALID_DEDUCTION" }, 400);
    if (!decisionData.deduction.authorized) delete decisionData.deduction.amountCents;
    else if (!Number.isSafeInteger(decisionData.deduction.amountCents) ||
        decisionData.deduction.amountCents <= 0 || decisionData.deduction.amountCents > 100000000) {
      return json({ error: "INVALID_DEDUCTION" }, 400);
    }
  }
  const pendingRequest = await env.DB.prepare(
    "SELECT request_type, details_json FROM work_requests WHERE id = ? AND license_id = ? AND status = 'pending' LIMIT 1"
  ).bind(requestId, ctx.licenseId).first();
  if (!pendingRequest) return json({ error: "REQUEST_NOT_PENDING_OR_NOT_FOUND" }, 409);
  if (decisionData.deduction?.authorized === true) {
    if (decision !== "approved") return json({ error: "DEDUCTION_REQUIRES_APPROVAL" }, 400);
    if (!new Set(["LOAN", "CONSUMPTION", "ABSENCE_PERMISSION", "LATE_ARRIVAL", "SALARY_ADVANCE"]).has(pendingRequest.request_type)) {
      return json({ error: "DEDUCTION_NOT_ALLOWED_FOR_REQUEST_TYPE" }, 400);
    }
    let requestedDetails = {};
    try { requestedDetails = JSON.parse(pendingRequest.details_json || "{}"); } catch { return json({ error: "REQUEST_DATA_INVALID" }, 503); }
    const requestedCents = Number(requestedDetails.amountCents || 0);
    if (Number.isSafeInteger(requestedCents) && requestedCents > 0 &&
        decisionData.deduction.amountCents > requestedCents) {
      return json({ error: "DEDUCTION_EXCEEDS_REQUESTED_AMOUNT" }, 400);
    }
  }
  const decisionJson = JSON.stringify(decisionData);
  if (decisionJson.length > 4096) return json({ error: "REQUEST_TOO_LARGE" }, 413);
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    "UPDATE work_requests SET status = ?, decision_json = ?, decided_at = ?, decided_by_device_id = ? WHERE id = ? AND license_id = ? AND status = 'pending'"
  ).bind(decision, decisionJson, now, ctx.deviceId, requestId, ctx.licenseId).run();
  if ((result.meta?.changes ?? 0) !== 1) return json({ error: "REQUEST_NOT_PENDING_OR_NOT_FOUND" }, 409);
  return json({ requestId, status: decision, decidedAt: now, decisionDetails: decisionData });
}

async function ventasRequestHistory(request, env) {
  const checked = await verifyBusinessProof(request, env, "VENTAS_REQUEST_HISTORY");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "VENTAS");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const work = await env.DB.prepare(
    "SELECT id, request_type, details_json, status, decision_json, created_at, decided_at FROM work_requests WHERE ventas_device_id = ? ORDER BY created_at DESC LIMIT 200"
  ).bind(ctx.deviceId).all();
  const corrections = await env.DB.prepare(
    "SELECT r.id, r.sale_id, r.reason, r.reasons_json, r.cash_impact, r.cash_reason, r.plan_hash, r.status, r.created_at, r.decided_at, g.id AS grant_id FROM correction_requests r LEFT JOIN correction_grants g ON g.request_id = r.id WHERE r.ventas_device_id = ? ORDER BY r.created_at DESC LIMIT 100"
  ).bind(ctx.deviceId).all();
  return json({
    items: (work.results || []).map((row) => ({
      requestId: row.id,
      type: row.request_type,
      details: JSON.parse(row.details_json || "{}"),
      status: row.status,
      decisionDetails: row.decision_json ? JSON.parse(row.decision_json) : {},
      createdAt: Number(row.created_at),
      decidedAt: row.decided_at === null ? null : Number(row.decided_at)
    })),
    corrections: (corrections.results || []).map((row) => ({
      requestId: row.id,
      saleId: row.sale_id,
      reason: row.reason,
      reasons: (() => { try { return JSON.parse(row.reasons_json || "[]"); } catch { return [row.reason]; } })(),
      cashImpact: Number(row.cash_impact) === 1,
      cashReason: row.cash_reason || "",
      planHash: row.plan_hash,
      grantId: row.grant_id || null,
      status: row.status,
      createdAt: Number(row.created_at),
      decidedAt: row.decided_at === null ? null : Number(row.decided_at)
    }))
  });
}

async function ventasRequestUpdates(request, env) {
  const checked = await verifyBusinessProof(request, env, "VENTAS_REQUEST_UPDATES");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "VENTAS");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const since = Number.isSafeInteger(body.since) && body.since > 0 ? body.since : 0;
  const rows = await env.DB.prepare(
    "SELECT id, request_type, status, decision_json, created_at, decided_at FROM work_requests WHERE ventas_device_id = ? AND decided_at IS NOT NULL AND decided_at > ? ORDER BY decided_at ASC LIMIT 100"
  ).bind(ctx.deviceId, since).all();
  const correctionRows = await env.DB.prepare(
    "SELECT r.id, r.sale_id, r.reason, r.reasons_json, r.cash_impact, r.cash_reason, r.plan_hash, r.status, r.created_at, r.decided_at, g.id AS grant_id FROM correction_requests r LEFT JOIN correction_grants g ON g.request_id = r.id WHERE r.ventas_device_id = ? AND r.decided_at IS NOT NULL AND r.decided_at > ? ORDER BY r.decided_at ASC LIMIT 100"
  ).bind(ctx.deviceId, since).all();
  const items = (rows.results || []).map((r) => ({
    requestId: r.id, type: r.request_type, status: r.status,
    decisionDetails: r.decision_json ? JSON.parse(r.decision_json) : {},
    createdAt: r.created_at, decidedAt: r.decided_at
  }));
  const corrections = (correctionRows.results || []).map((r) => ({
    requestId: r.id, saleId: r.sale_id, reason: r.reason,
    reasons: (() => { try { return JSON.parse(r.reasons_json || "[]"); } catch { return [r.reason]; } })(),
    cashImpact: Number(r.cash_impact) === 1, cashReason: r.cash_reason || "",
    planHash: r.plan_hash, grantId: r.grant_id || null,
    status: r.status, createdAt: r.created_at, decidedAt: r.decided_at
  }));
  const cursor = Math.max(0,
    ...items.map((r) => Number(r.decidedAt || r.createdAt || 0)),
    ...corrections.map((r) => Number(r.decidedAt || r.createdAt || 0))
  );
  const payload = { items, corrections, cursor };
  return json(await recordUniversalDelivery(env, ctx, "VENTAS_REQUEST_UPDATES", payload));
}

async function saveReport(request, env, purpose, table, keyField, keyName) {
  const checked = await verifyBusinessProof(request, env, purpose);
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "VENTAS");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const key = typeof body[keyField] === "string" ? body[keyField].trim() : "";
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(key) || !body.report || typeof body.report !== "object" || Array.isArray(body.report)) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const reportJson = JSON.stringify(body.report);
  if (reportJson.length > 16384) return json({ error: "REQUEST_TOO_LARGE" }, 413);
  if (table === "payroll_reports") {
    const device = await env.DB.prepare(
      "SELECT slot_number FROM devices WHERE id = ? AND license_id = ? AND device_type = 'VENTAS' AND status = 'active' LIMIT 1"
    ).bind(ctx.deviceId, ctx.licenseId).first();
    if (!device || ![2, 3].includes(Number(device.slot_number))) return json({ error: "DEVICE_SLOT_INVALID" }, 403);
    const settings = await env.DB.prepare(
      "SELECT payment_day, payment_dates_json FROM payroll_settings WHERE license_id = ? AND slot_number = ? LIMIT 1"
    ).bind(ctx.licenseId, Number(device.slot_number)).first();
    if (!settings) return json({ error: "PAYROLL_NOT_CONFIGURED" }, 403);
    const mexicoDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
    if (key !== mexicoDate) return json({ error: "INVALID_PAYROLL_PERIOD" }, 400);
    const dayOfMonth = Number(mexicoDate.slice(8, 10));
    let paymentDates = [];
    try { paymentDates = JSON.parse(settings.payment_dates_json || "[]"); } catch { return json({ error: "PAYROLL_SETTINGS_INVALID" }, 503); }
    const isPaymentDate = (settings.payment_day !== null && Number(settings.payment_day) === dayOfMonth) ||
      (Array.isArray(paymentDates) && paymentDates.includes(mexicoDate));
    if (!isPaymentDate) return json({ error: "PAYROLL_NOT_DUE", nextPaymentDay: settings.payment_day ?? null });
  }
  const existing = await env.DB.prepare(
    "SELECT id, created_at, report_json FROM " + table + " WHERE ventas_device_id = ? AND " + keyName + " = ? LIMIT 1"
  ).bind(ctx.deviceId, key).first();
  if (existing) return json({
    reportId: existing.id, createdAt: existing.created_at, duplicate: true,
    report: JSON.parse(existing.report_json)
  });
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      "INSERT INTO " + table + " (id, license_id, ventas_device_id, " + keyName + ", report_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, ctx.licenseId, ctx.deviceId, key, reportJson, now).run();
  } catch {
    const raced = await env.DB.prepare(
      "SELECT id, created_at, report_json FROM " + table + " WHERE ventas_device_id = ? AND " + keyName + " = ? LIMIT 1"
    ).bind(ctx.deviceId, key).first();
    if (raced) return json({
      reportId: raced.id, createdAt: raced.created_at, duplicate: true,
      report: JSON.parse(raced.report_json)
    });
    return json({ error: "SERVICE_UNAVAILABLE" }, 503);
  }
  return json({ reportId: id, createdAt: now }, 201);
}

async function patronReportsInbox(request, env) {
  const checked = await verifyBusinessProof(request, env, "PATRON_REPORTS_INBOX");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "PATRON");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const slot = body.slot === "VENTAS_1" ? 2 : body.slot === "VENTAS_2" ? 3 : null;
  if (!slot) return json({ error: "INVALID_REQUEST" }, 400);
  const shifts = await env.DB.prepare(
    "SELECT id, shift_key, report_json, created_at FROM shift_reports WHERE license_id = ? AND ventas_device_id IN (SELECT id FROM devices WHERE license_id = ? AND slot_number = ?) ORDER BY created_at DESC LIMIT 50"
  ).bind(ctx.licenseId, ctx.licenseId, slot).all();
  const payroll = await env.DB.prepare(
    "SELECT id, period_key, report_json, created_at FROM payroll_reports WHERE license_id = ? AND ventas_device_id IN (SELECT id FROM devices WHERE license_id = ? AND slot_number = ?) ORDER BY created_at DESC LIMIT 50"
  ).bind(ctx.licenseId, ctx.licenseId, slot).all();
  const payrollRows = payroll.results || [];
  let payrollEntries = [];
  if (payrollRows.length > 0) {
    const previousReportAt = payrollRows.length > 1 ? Number(payrollRows[1].created_at) : 0;
    const latestReportAt = Number(payrollRows[0].created_at);
    const entries = await env.DB.prepare(
      "SELECT id, request_type, details_json, status, decision_json, created_at, decided_at FROM work_requests WHERE license_id = ? AND ventas_device_id IN (SELECT id FROM devices WHERE license_id = ? AND slot_number = ?) AND ((created_at > ? AND created_at <= ?) OR (decided_at > ? AND decided_at <= ?) OR (status = 'pending' AND created_at <= ?)) ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 500"
    ).bind(ctx.licenseId, ctx.licenseId, slot, previousReportAt, latestReportAt, previousReportAt, latestReportAt, latestReportAt).all();
    payrollEntries = (entries.results || []).map((r) => ({
      requestId: r.id,
      type: r.request_type,
      details: JSON.parse(r.details_json || "{}"),
      status: r.status,
      decisionDetails: r.decision_json ? JSON.parse(r.decision_json) : {},
      createdAt: Number(r.created_at),
      decidedAt: r.decided_at === null ? 0 : Number(r.decided_at)
    }));
  }
  const shiftReports = (shifts.results || []).map((r) => ({ reportId: r.id, shiftKey: r.shift_key, report: JSON.parse(r.report_json), createdAt: r.created_at }));
  const payrollReports = payrollRows.map((r) => ({ reportId: r.id, periodKey: r.period_key, report: JSON.parse(r.report_json), createdAt: r.created_at }));
  const cursor = Math.max(0,
    ...shiftReports.map((r) => Number(r.createdAt || 0)),
    ...payrollReports.map((r) => Number(r.createdAt || 0)),
    ...payrollEntries.map((r) => Number(r.decidedAt || r.createdAt || 0))
  );
  const stream = "PATRON_REPORTS_" + (slot === 2 ? "VENTAS_1" : "VENTAS_2");
  const payload = { slot: slot === 2 ? "VENTAS_1" : "VENTAS_2", shiftReports, payrollReports, payrollEntries, cursor };
  return json(await recordUniversalDelivery(env, ctx, stream, payload));
}



function mexicoLocalDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

function validIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

async function saveDailyInventory(request, env) {
  const checked = await verifyBusinessProof(request, env, "VENTAS_DAILY_INVENTORY");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "VENTAS");
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((k) => !["inventoryDate", "snapshot"].includes(k)) ||
      !validIsoDate(body.inventoryDate) || !body.snapshot ||
      typeof body.snapshot !== "object" || Array.isArray(body.snapshot)) {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const today = mexicoLocalDate();
  const cutoff = new Date(today + "T00:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() - 6);
  const earliest = cutoff.toISOString().slice(0, 10);
  if (body.inventoryDate > today || body.inventoryDate < earliest) {
    return json({ error: "INVENTORY_DATE_OUT_OF_RANGE", serverDate: today }, 400);
  }
  const snapshotJson = JSON.stringify(body.snapshot);
  if (snapshotJson.length > 32768) return json({ error: "REQUEST_TOO_LARGE" }, 413);
  const device = await env.DB.prepare(
    "SELECT slot_number FROM devices WHERE id=? AND license_id=? AND device_type='VENTAS' AND status='active' LIMIT 1"
  ).bind(ctx.deviceId, ctx.licenseId).first();
  if (!device || ![2, 3].includes(Number(device.slot_number))) return json({ error: "DEVICE_SLOT_INVALID" }, 403);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `INSERT INTO daily_inventory_snapshots
       (id, license_id, ventas_device_id, inventory_date, snapshot_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ventas_device_id, inventory_date) DO UPDATE
         SET snapshot_json=excluded.snapshot_json, updated_at=excluded.updated_at`
    ).bind(id, ctx.licenseId, ctx.deviceId, body.inventoryDate, snapshotJson, now).run();
  } catch {
    return json({ error: "INVENTORY_SAVE_FAILED" }, 503);
  }
  const saved = await env.DB.prepare(
    "SELECT id, updated_at FROM daily_inventory_snapshots WHERE ventas_device_id=? AND inventory_date=? LIMIT 1"
  ).bind(ctx.deviceId, body.inventoryDate).first();
  return json({ inventoryId: saved?.id || id, inventoryDate: body.inventoryDate,
    slot: Number(device.slot_number) === 2 ? "VENTAS_1" : "VENTAS_2",
    updatedAt: Number(saved?.updated_at || now), received: true });
}

async function createOrReadPaydayBundle(request, env) {
  const checked = await verifyBusinessProof(request, env, "PATRON_PAYDAY_BUNDLE");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "PATRON", false);
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((k) => k !== "paymentDate") ||
      !validIsoDate(body.paymentDate) || body.paymentDate !== mexicoLocalDate()) {
    return json({ error: "INVALID_PAYDAY_DATE", serverDate: mexicoLocalDate() }, 400);
  }
  const settingsRows = await env.DB.prepare(
    "SELECT slot_number, payment_day, payment_dates_json FROM payroll_settings WHERE license_id=? AND slot_number IN (2,3)"
  ).bind(ctx.licenseId).all();
  const dayOfMonth = Number(body.paymentDate.slice(8, 10));
  const dueSlots = [];
  for (const setting of (settingsRows.results || [])) {
    let dates = [];
    try { dates = JSON.parse(setting.payment_dates_json || "[]"); } catch { return json({ error: "PAYROLL_SETTINGS_INVALID" }, 503); }
    const due = (setting.payment_day !== null && Number(setting.payment_day) === dayOfMonth) ||
      (Array.isArray(dates) && dates.includes(body.paymentDate));
    if (due) dueSlots.push(Number(setting.slot_number));
  }
  if (dueSlots.length === 0) return json({ error: "PAYROLL_NOT_DUE" }, 403);
  const existing = await env.DB.prepare(
    "SELECT id, payload_json, status, created_at FROM payday_deliveries WHERE license_id=? AND payment_date=? LIMIT 1"
  ).bind(ctx.licenseId, body.paymentDate).first();
  if (existing?.status === "acked") return json({
    deliveryId: existing.id, paymentDate: body.paymentDate,
    status: existing.status, duplicate: true, payload: null, payloadCompacted: true,
    createdAt: Number(existing.created_at)
  });
  const start = new Date(body.paymentDate + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() - 6);
  const earliest = start.toISOString().slice(0, 10);
  const inventoryRows = await env.DB.prepare(
    `SELECT s.id, s.inventory_date, s.snapshot_json, s.updated_at, d.slot_number
       FROM daily_inventory_snapshots s JOIN devices d ON d.id=s.ventas_device_id
      WHERE s.license_id=? AND d.status IN ('active','revoked')
        AND d.device_type='VENTAS' AND d.slot_number IN (2,3)
        AND s.inventory_date>=? AND s.inventory_date<=?
      ORDER BY d.slot_number ASC, s.inventory_date DESC, s.updated_at DESC`
  ).bind(ctx.licenseId, earliest, body.paymentDate).all();
  const latestBySlot = new Map();
  for (const row of (inventoryRows.results || [])) {
    if (dueSlots.includes(Number(row.slot_number)) && !latestBySlot.has(Number(row.slot_number))) latestBySlot.set(Number(row.slot_number), row);
  }
  const payrollRows = await env.DB.prepare(
    `SELECT p.id, p.period_key, p.report_json, p.created_at, d.slot_number
       FROM payroll_reports p JOIN devices d ON d.id=p.ventas_device_id
      WHERE p.license_id=? AND p.period_key=? AND d.device_type='VENTAS'
        AND d.slot_number IN (${dueSlots.map(() => "?").join(",")})
      ORDER BY d.slot_number`
  ).bind(ctx.licenseId, body.paymentDate, ...dueSlots).all();
  const receivedPayrollSlots = new Set((payrollRows.results || []).map((row) => Number(row.slot_number)));
  const payload = {
    paymentDate: body.paymentDate,
    dueTeams: dueSlots.map((slot) => slot === 2 ? "VENTAS_1" : "VENTAS_2"),
    missingPayrollTeams: dueSlots.filter((slot) => !receivedPayrollSlots.has(slot))
      .map((slot) => slot === 2 ? "VENTAS_1" : "VENTAS_2"),
    inventories: dueSlots.map((slot) => {
      const row = latestBySlot.get(slot);
      return row ? { slot: slot === 2 ? "VENTAS_1" : "VENTAS_2",
        inventoryDate: row.inventory_date, updatedAt: Number(row.updated_at),
        inventoryId: row.id, snapshot: JSON.parse(row.snapshot_json) } : null;
    }).filter(Boolean),
    missingInventoryTeams: dueSlots.filter((slot) => !latestBySlot.has(slot))
      .map((slot) => slot === 2 ? "VENTAS_1" : "VENTAS_2"),
    payrollReports: (payrollRows.results || []).map((row) => ({
      slot: Number(row.slot_number) === 2 ? "VENTAS_1" : "VENTAS_2",
      reportId: row.id, periodKey: row.period_key,
      report: JSON.parse(row.report_json), createdAt: Number(row.created_at)
    }))
  };
  const payloadJson = JSON.stringify(payload);
  if (payloadJson.length > 131072) return json({ error: "PAYDAY_BUNDLE_TOO_LARGE" }, 413);
  const now = Math.floor(Date.now() / 1000);
  if (existing?.status === "pending") {
    // A pending delivery is immutable: retries must receive the exact payload
    // that was first issued, otherwise an ACK could authorize deleting a newer
    // inventory snapshot that the device never durably stored.
    return json({
      deliveryId: existing.id, paymentDate: body.paymentDate, status: "pending",
      duplicate: true, payload: JSON.parse(existing.payload_json),
      createdAt: Number(existing.created_at)
    });
  }
  const deliveryId = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO payday_deliveries (id,license_id,payment_date,payload_json,status,created_at) VALUES (?,?,?,?,'pending',?)"
    ).bind(deliveryId, ctx.licenseId, body.paymentDate, payloadJson, now).run();
  } catch {
    const raced = await env.DB.prepare(
      "SELECT id,payload_json,status,created_at FROM payday_deliveries WHERE license_id=? AND payment_date=? LIMIT 1"
    ).bind(ctx.licenseId, body.paymentDate).first();
    if (!raced) return json({ error: "PAYDAY_BUNDLE_CREATE_FAILED" }, 503);
    return json({ deliveryId: raced.id, paymentDate: body.paymentDate, status: raced.status,
      duplicate: true, payload: JSON.parse(raced.payload_json), createdAt: Number(raced.created_at) });
  }
  return json({ deliveryId, paymentDate: body.paymentDate, status: "pending",
    duplicate: false, payload, createdAt: now }, 201);
}

async function acknowledgePaydayBundle(request, env) {
  const checked = await verifyBusinessProof(request, env, "PATRON_PAYDAY_ACK");
  if (checked.response) return checked.response;
  const { proof } = checked;
  const ctx = await signedDeviceContext(proof, "PATRON", false);
  if (ctx.error) return json({ error: ctx.error }, ctx.status);
  let body;
  try { body = JSON.parse(proof.bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const deliveryId = typeof body?.deliveryId === "string" ? body.deliveryId : "";
  if (!/^[0-9a-f-]{36}$/i.test(deliveryId) ||
      Object.keys(body || {}).some((k) => k !== "deliveryId")) return json({ error: "INVALID_REQUEST" }, 400);
  const delivery = await env.DB.prepare(
    "SELECT id,payment_date,status FROM payday_deliveries WHERE id=? AND license_id=? LIMIT 1"
  ).bind(deliveryId, ctx.licenseId).first();
  if (!delivery) return json({ error: "PAYDAY_DELIVERY_NOT_FOUND" }, 404);
  const now = Math.floor(Date.now() / 1000);
  if (delivery.status === "acked") {
    const receipt = JSON.stringify({
      deliveryId, paymentDate: delivery.payment_date,
      status: "acked", acknowledgedAt: now
    });
    try {
      await env.DB.prepare(
        "UPDATE payday_deliveries SET payload_json=? WHERE id=? AND license_id=? AND status='acked'"
      ).bind(receipt, deliveryId, ctx.licenseId).run();
    } catch {
      return json({ error: "PAYDAY_ACK_COMPACTION_FAILED" }, 503);
    }
    return json({ deliveryId, status: "acked", duplicate: true,
      acknowledgedAt: now, payloadCompacted: true });
  }
  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE payday_deliveries SET status='acked',acked_at=? WHERE id=? AND license_id=? AND status='pending'"
      ).bind(now, deliveryId, ctx.licenseId),
      env.DB.prepare(
        `DELETE FROM daily_inventory_snapshots
          WHERE license_id=? AND inventory_date<=?
            AND ventas_device_id IN (
              SELECT s.ventas_device_id FROM daily_inventory_snapshots s
               WHERE s.id IN (
                 SELECT json_extract(j.value, '$.inventoryId')
                   FROM payday_deliveries p, json_each(p.payload_json, '$.inventories') j
                  WHERE p.id=? AND p.license_id=?
               )
            )`
      ).bind(ctx.licenseId, delivery.payment_date, deliveryId, ctx.licenseId)
    ]);
  } catch {
    return json({ error: "PAYDAY_ACK_FAILED" }, 503);
  }
  const confirmed = await env.DB.prepare(
    "SELECT status FROM payday_deliveries WHERE id=? AND license_id=? LIMIT 1"
  ).bind(deliveryId, ctx.licenseId).first();
  if (confirmed?.status !== "acked") return json({ error: "PAYDAY_ACK_NOT_CONFIRMED" }, 503);
  const receipt = JSON.stringify({
    deliveryId, paymentDate: delivery.payment_date,
    status: "acked", acknowledgedAt: now
  });
  try {
    await env.DB.prepare(
      "UPDATE payday_deliveries SET payload_json=? WHERE id=? AND license_id=? AND status='acked'"
    ).bind(receipt, deliveryId, ctx.licenseId).run();
  } catch {
    return json({ error: "PAYDAY_ACK_COMPACTION_FAILED" }, 503);
  }
  return json({ deliveryId, status: "acked", duplicate: false, acknowledgedAt: now,
    inventoriesCleaned: true, payloadCompacted: true });
}

function validateOfficialContacts(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const allowed = ["officialEmail", "helpPhone1", "helpPhone2"];
  if (Object.keys(body).some((key) => !allowed.includes(key)) ||
      allowed.some((key) => typeof body[key] !== "string")) return null;
  const officialEmail = body.officialEmail.trim().toLowerCase();
  const helpPhone1 = body.helpPhone1.trim();
  const helpPhone2 = body.helpPhone2.trim();
  if (officialEmail.length > 254 ||
      !/^[\x21-\x7E]+$/.test(officialEmail) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(officialEmail) ||
      !/^\+[1-9][0-9]{7,14}$/.test(helpPhone1) ||
      !/^\+[1-9][0-9]{7,14}$/.test(helpPhone2) ||
      helpPhone1 === helpPhone2) return null;
  return { officialEmail, helpPhone1, helpPhone2 };
}

async function signOfficialContacts(row, env) {
  if (typeof env.CONTACTS_SIGNING_PRIVATE_JWK !== "string" ||
      env.CONTACTS_SIGNING_PRIVATE_JWK.length > 4096) {
    return { error: "CONTACTS_SIGNING_NOT_CONFIGURED" };
  }
  let jwk;
  try { jwk = JSON.parse(env.CONTACTS_SIGNING_PRIVATE_JWK); } catch {
    return { error: "CONTACTS_SIGNING_KEY_INVALID" };
  }
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string") {
    return { error: "CONTACTS_SIGNING_KEY_INVALID" };
  }
  const payload = {
    revision: Number(row.revision),
    officialEmail: row.official_email,
    helpPhone1: row.help_phone_1,
    helpPhone2: row.help_phone_2,
    registeredAt: Number(row.registered_at),
    updatedAt: Number(row.updated_at)
  };
  const canonical = JSON.stringify(payload);
  const privateKey = await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(canonical)
  );
  return {
    payload,
    signature: base64Url(signature),
    algorithm: "ECDSA_P256_SHA256",
    keyId: "sene-official-contacts-v1"
  };
}

async function getOfficialSupportContacts(_request, env) {
  const row = await env.DB.prepare(
    "SELECT revision, official_email, help_phone_1, help_phone_2, registered_at, updated_at FROM official_support_contacts WHERE id=1 LIMIT 1"
  ).first();
  if (!row) return json({ error: "OFFICIAL_CONTACTS_NOT_REGISTERED" }, 404);
  const signed = await signOfficialContacts(row, env);
  if (signed.error) return json({ error: signed.error }, 503);
  return json(signed);
}

async function registerOfficialSupportContacts(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const contacts = validateOfficialContacts(body);
  if (!contacts) return json({ error: "INVALID_OFFICIAL_CONTACTS" }, 400);
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      "INSERT INTO official_support_contacts (id, official_email, help_phone_1, help_phone_2, revision, registered_at, updated_at, updated_by) VALUES (1, ?, ?, ?, 1, ?, ?, 'operator-console')"
    ).bind(contacts.officialEmail, contacts.helpPhone1, contacts.helpPhone2, now, now).run();
  } catch {
    const exists = await env.DB.prepare(
      "SELECT id FROM official_support_contacts WHERE id=1 LIMIT 1"
    ).first();
    if (exists) return json({ error: "OFFICIAL_CONTACTS_ALREADY_REGISTERED" }, 409);
    return json({ error: "OFFICIAL_CONTACTS_REGISTRATION_FAILED" }, 503);
  }
  return getOfficialSupportContacts(request, env);
}

async function updateOfficialSupportContacts(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_JSON" }, 400); }
  if (!body || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
    return json({ error: "INVALID_EXPECTED_REVISION" }, 400);
  }
  const contacts = validateOfficialContacts({
    officialEmail: body.officialEmail,
    helpPhone1: body.helpPhone1,
    helpPhone2: body.helpPhone2
  });
  if (!contacts || Object.keys(body).some((key) =>
    !["expectedRevision", "officialEmail", "helpPhone1", "helpPhone2"].includes(key))) {
    return json({ error: "INVALID_OFFICIAL_CONTACTS" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    "UPDATE official_support_contacts SET official_email=?, help_phone_1=?, help_phone_2=?, revision=revision+1, updated_at=MAX(?, updated_at+1), updated_by='operator-console' WHERE id=1 AND revision=?"
  ).bind(contacts.officialEmail, contacts.helpPhone1, contacts.helpPhone2, now, body.expectedRevision).run();
  if (!result.meta || result.meta.changes !== 1) {
    const row = await env.DB.prepare(
      "SELECT revision FROM official_support_contacts WHERE id=1 LIMIT 1"
    ).first();
    return json({ error: row ? "REVISION_CONFLICT" : "OFFICIAL_CONTACTS_NOT_REGISTERED",
      currentRevision: row ? Number(row.revision) : null }, row ? 409 : 404);
  }
  return getOfficialSupportContacts(request, env);
}

function operatorReplacementPanelResponse() {
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>SENE · Operador · Reposiciones</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#07111f;color:#edf5ff}
body{margin:0;padding:22px;max-width:980px;margin-inline:auto}
header{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.mark{width:42px;height:42px;border-radius:13px;background:linear-gradient(135deg,#1677e8,#16b981);display:grid;place-items:center;font-weight:900}
h1{font-size:22px;margin:0}p{color:#a8bdd3}
.panel,.item{background:#101f32;border:1px solid #263b55;border-radius:16px;padding:16px;margin:14px 0}
input,button{font:inherit;border-radius:10px;padding:12px;border:1px solid #36516e}
input{background:#081727;color:white;width:100%;box-sizing:border-box;margin:6px 0 12px}
button{background:#0879df;color:white;border:0;font-weight:700;cursor:pointer}
button.secondary{background:#29415d}button:disabled{opacity:.5;cursor:wait}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.small{font-size:13px;color:#a8bdd3}.status{color:#6ee7b7;font-weight:700}.error{color:#fda4af}
.code{font-size:22px;letter-spacing:3px;font-weight:800;color:#6ee7b7;overflow-wrap:anywhere}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
.hidden{display:none}
</style></head><body>
<header><div class="mark">S</div><div><h1>SENE · Panel de operador</h1><div class="small">Validación de reposiciones · $500 MXN</div></div></header>
<section class="panel" id="login">
<h2>Acceso privado</h2><p>Introduce el secreto de operador configurado en Cloudflare. No se guarda en el navegador.</p>
<input id="token" type="password" autocomplete="off" placeholder="OPERATOR_TOKEN">
<button id="connect">Entrar al panel</button><div id="loginMsg" class="small"></div>
</section>
<section id="app" class="hidden">
<div class="panel"><div class="grid"><div><strong>Solicitudes</strong><div id="count" class="code">0</div></div><div><strong>Importe</strong><div class="code">$500 MXN</div></div></div>
<div class="actions"><button id="refresh" class="secondary">Actualizar solicitudes</button><button id="logout" class="secondary">Cerrar sesión</button></div><div id="msg" class="small" aria-live="polite"></div></div>
<div class="panel"><h2>Reposición SENE PATRÓN</h2><div id="patronItems"></div></div>
<div id="items"></div>
</section>
<script>
(()=> {
 let operatorToken="";
 const $=id=>document.getElementById(id);
 const headers=()=>({"Authorization":"Bearer "+operatorToken,"Content-Type":"application/json"});
 const message=(value,error=false)=>{ $("msg").textContent=value; $("msg").className=error?"error":"small"; };
 async function api(path,options={}) {
   const response=await fetch(path,{...options,headers:{...headers(),...(options.headers||{})},cache:"no-store"});
   const data=await response.json().catch(()=>({error:"RESPUESTA_INVALIDA"}));
   if(!response.ok) throw new Error(data.message||data.error||("HTTP "+response.status));
   return data;
 }
 function node(tag,cls,txt){const el=document.createElement(tag);if(cls)el.className=cls;if(txt!==undefined)el.textContent=txt;return el;}
 async function load(){
   message("Consultando solicitudes…");
   try{
     const data=await api("/v1/operator/replacements/pending");
     $("count").textContent=String((data.items||[]).length);
     const list=$("items");list.replaceChildren();
     for(const row of (data.items||[])){
       const card=node("article","item");
       card.append(node("h2","",row.business_name||"Empresa sin nombre"));
       card.append(node("div","small","Folio: "+row.id));
       card.append(node("div","small","Equipo: "+(row.slot_number===2?"VENTAS 1":"VENTAS 2")+" · Motivo: "+(row.reason||"No especificado")));
       card.append(node("div","small","Solicitud: "+new Date(Number(row.created_at)*1000).toLocaleString("es-MX")));
       card.append(node("div","status",row.payment_status==="authorized"?"Pago autorizado · código recuperable":"Pendiente de validar pago"));
       const grid=node("div","grid");
       const ref=node("input");ref.placeholder="Referencia/comprobante de pago";ref.maxLength=120;ref.value=row.payment_reference||"";
       const phone=node("input");phone.placeholder="Número oficial AYUDA (con lada)";phone.autocomplete="off";phone.value=row.delivery_phone||"";
       grid.append(ref,phone);card.append(grid);
       const actions=node("div","actions");
       const issue=node("button","",row.payment_status==="authorized"?"Recuperar código":"Validar pago y emitir código");
       const copy=node("button","secondary","Copiar código");copy.classList.add("hidden");
       const code=node("div","code");code.classList.add("hidden");
       issue.addEventListener("click",async()=>{
         if(!ref.value.trim()||!phone.value.trim()){message("Captura la referencia de pago y el número oficial AYUDA.",true);return;}
         issue.disabled=true;message("Validando y autorizando…");
         try{
           const result=await api("/v1/operator/replacements/authorize",{method:"POST",body:JSON.stringify({requestId:row.id,paymentReference:ref.value.trim(),deliveryPhone:phone.value.trim()})});
           code.textContent=result.authorizationCode;code.classList.remove("hidden");copy.classList.remove("hidden");
           copy.onclick=()=>navigator.clipboard.writeText(result.authorizationCode).then(()=>message("Código copiado. Entrégalo únicamente al número oficial AYUDA.")).catch(()=>message("No se pudo copiar; selecciona el código manualmente.",true));
           message("Pago autorizado. Código de un solo uso listo; entrégalo únicamente al número oficial AYUDA.");
           issue.textContent="Código recuperado";
           $("count").textContent=""; 
         }catch(e){message(e.message,true);}
         finally{issue.disabled=false;}
       });
       actions.append(issue,copy);card.append(actions,code);list.append(card);
     }
     if(!(data.items||[]).length)list.append(node("div","panel","No hay reposiciones pendientes."));
     await loadPatron();
     message("Solicitudes actualizadas.");
   }catch(e){message(e.message,true);if(e.message==="UNAUTHORIZED")logout();}
 }
 async function loadPatron(){
   const list=$("patronItems");list.replaceChildren();
   try{
     const data=await api("/v1/operator/patron-recovery-payments/pending");
     for(const row of (data.items||[])){
       const card=node("article","item");
       card.append(node("h3","",row.business_name||"Empresa sin nombre"));
       card.append(node("div","small","Folio: "+row.id));
       card.append(node("div","small","Correo registrado: "+(row.registered_email||"—")+" · Teléfono registrado: "+(row.registered_phone||"—")));
       card.append(node("div","status",row.status==="authorized"?"Pago autorizado · código recuperable":"Pendiente de validar pago"));
       const grid=node("div","grid");
       const ref=node("input");ref.placeholder="Referencia/comprobante de pago";ref.maxLength=120;ref.value=row.payment_reference||"";
       const phone=node("input");phone.placeholder="Número oficial AYUDA (con lada)";phone.autocomplete="off";phone.value=row.delivery_phone||"";
       grid.append(ref,phone);card.append(grid);
       const actions=node("div","actions");
       const issue=node("button","",row.status==="authorized"?"Recuperar código":"Validar pago y emitir código");
       const copy=node("button","secondary","Copiar código");copy.classList.add("hidden");
       const code=node("div","code");code.classList.add("hidden");
       issue.addEventListener("click",async()=>{
         if(!ref.value.trim()||!phone.value.trim()){message("Captura la referencia de pago y el número oficial AYUDA.",true);return;}
         issue.disabled=true;message("Validando reposición de PATRÓN…");
         try{
           const result=await api("/v1/operator/patron-recovery-payments/authorize",{method:"POST",body:JSON.stringify({requestId:row.id,paymentReference:ref.value.trim(),deliveryPhone:phone.value.trim()})});
           code.textContent=result.recoveryCode;code.classList.remove("hidden");copy.classList.remove("hidden");
           copy.onclick=()=>navigator.clipboard.writeText(result.recoveryCode).then(()=>message("Código copiado. Entrégalo únicamente por AYUDA oficial.")).catch(()=>message("No se pudo copiar; selecciona el código manualmente.",true));
           issue.textContent="Código recuperado";
           message("Pago de reposición PATRÓN autorizado. Entrega el código únicamente por AYUDA oficial.");
         }catch(e){message(e.message,true);}
         finally{issue.disabled=false;}
       });
       actions.append(issue,copy);card.append(actions,code);list.append(card);
     }
     if(!(data.items||[]).length)list.append(node("div","small","No hay reposiciones de PATRÓN pendientes."));
   }catch(e){message("Bandeja PATRÓN: "+e.message,true);if(e.message==="UNAUTHORIZED")logout();}
 }
 function logout(){
   operatorToken="";$("token").value="";$("app").classList.add("hidden");$("login").classList.remove("hidden");$("items").replaceChildren();$("patronItems").replaceChildren();
 }
 $("connect").addEventListener("click",async()=>{
   operatorToken=$("token").value.trim();
   if(!operatorToken){$("loginMsg").textContent="Introduce el secreto.";return;}
   try{const r=await api("/v1/operator/replacements/pending");$("login").classList.add("hidden");$("app").classList.remove("hidden");$("count").textContent=String((r.items||[]).length);load();}
   catch(e){operatorToken="";$("loginMsg").textContent=e.message;}
 });
 $("refresh").addEventListener("click",load);$("logout").addEventListener("click",logout);
})();
</script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  });
}

async function acknowledgeUniversalDelivery(request, env) {
  const checked = await verifyBusinessProof(request, env, "DELIVERY_ACK");
  if (checked.response) return checked.response;
  const { proof } = checked;
  // ACKs are control receipts: authenticate the device, but do not charge the
  // weekly business-operation quota for retries or acknowledgements.
  const ctx = await signedDeviceContext(proof, null, false);
  if (ctx.error) return json({ error: ctx.error }, ctx.status);

  let body;
  try { body = JSON.parse(proof.bodyText); } catch {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const ackId = typeof body.ackId === "string" ? body.ackId.toLowerCase() : "";
  const deliveryId = typeof body.deliveryId === "string" ? body.deliveryId : "";
  const stream = typeof body.stream === "string" ? body.stream : "";
  const payloadSha256 = typeof body.payloadSha256 === "string" ? body.payloadSha256.toLowerCase() : "";
  const cursor = body.cursor;
  if (!/^[0-9a-f-]{36}$/.test(ackId) ||
      !/^[A-Za-z0-9._:-]{1,120}$/.test(deliveryId) ||
      !/^[A-Z][A-Z0-9_.-]{1,47}$/.test(stream) ||
      !/^[0-9a-f]{64}$/.test(payloadSha256) ||
      deliveryId !== `${stream}:${payloadSha256.slice(0, 48)}` ||
      !Number.isSafeInteger(cursor) || cursor < 0 ||
      (body.recipientDeviceId != null && body.recipientDeviceId !== ctx.deviceId)) {
    return json({ error: "INVALID_ACK" }, 400);
  }

  const requestHash = await sha256(proof.bodyText);
  const byAckId = await env.DB.prepare(
    "SELECT ack_id, device_id, stream, delivery_id, payload_sha256, cursor, request_sha256, acknowledged_at FROM delivery_acknowledgements WHERE ack_id = ? LIMIT 1"
  ).bind(ackId).first();
  if (byAckId) {
    if (byAckId.device_id !== ctx.deviceId || byAckId.request_sha256 !== requestHash) {
      return json({ error: "ACK_ID_CONFLICT" }, 409);
    }
    return json({
      acknowledged: true, duplicate: true, ackId: byAckId.ack_id,
      deliveryId: byAckId.delivery_id, stream: byAckId.stream,
      cursor: Number(byAckId.cursor), acknowledgedAt: Number(byAckId.acknowledged_at)
    });
  }

  const byDelivery = await env.DB.prepare(
    "SELECT ack_id, payload_sha256, cursor, acknowledged_at FROM delivery_acknowledgements WHERE device_id = ? AND stream = ? AND delivery_id = ? LIMIT 1"
  ).bind(ctx.deviceId, stream, deliveryId).first();
  if (byDelivery) {
    if (byDelivery.payload_sha256 !== payloadSha256 || Number(byDelivery.cursor) !== cursor) {
      return json({ error: "DELIVERY_ACK_CONFLICT" }, 409);
    }
    return json({
      acknowledged: true, duplicate: true, ackId: byDelivery.ack_id,
      deliveryId, stream, cursor,
      acknowledgedAt: Number(byDelivery.acknowledged_at)
    });
  }

  const issued = await env.DB.prepare(
    "SELECT payload_sha256,cursor,acknowledged_at FROM delivery_issued WHERE device_id=? AND stream=? AND delivery_id=? LIMIT 1"
  ).bind(ctx.deviceId, stream, deliveryId).first();
  if (!issued || issued.payload_sha256 !== payloadSha256 || Number(issued.cursor) !== cursor) {
    return json({ error: "DELIVERY_NOT_ISSUED" }, 409);
  }

  const cursorRow = await env.DB.prepare(
    "SELECT last_cursor FROM delivery_ack_cursors WHERE device_id=? AND stream=? LIMIT 1"
  ).bind(ctx.deviceId, stream).first();
  const currentCursor = Number(cursorRow?.last_cursor || 0);
  if (cursor < currentCursor) {
    return json({ error: "DELIVERY_CURSOR_REGRESSION", cursor: currentCursor }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO delivery_acknowledgements (ack_id, license_id, device_id, stream, delivery_id, payload_sha256, cursor, request_sha256, acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(ackId, ctx.licenseId, ctx.deviceId, stream, deliveryId, payloadSha256, cursor, requestHash, now),
      env.DB.prepare(
        "INSERT INTO delivery_ack_cursors (device_id,stream,last_cursor,updated_at) VALUES (?,?,?,?) ON CONFLICT(device_id,stream) DO UPDATE SET last_cursor=excluded.last_cursor,updated_at=excluded.updated_at WHERE delivery_ack_cursors.last_cursor<=excluded.last_cursor"
      ).bind(ctx.deviceId, stream, cursor, now),
      env.DB.prepare(
        "UPDATE delivery_issued SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE device_id=? AND stream=? AND delivery_id=? AND payload_sha256=? AND cursor=?"
      ).bind(now, ctx.deviceId, stream, deliveryId, payloadSha256, cursor),
      // Retain unacknowledged deliveries; prune only old, already-acknowledged
      // issue receipts after 90 days to bound the registry without losing data.
      env.DB.prepare(
        "DELETE FROM delivery_issued WHERE acknowledged_at IS NOT NULL AND acknowledged_at < ?"
      ).bind(now - 90 * 86400)
    ]);
    if ((results?.[1]?.meta?.changes ?? 0) !== 1) {
      await env.DB.prepare("DELETE FROM delivery_acknowledgements WHERE ack_id=?").bind(ackId).run();
      return json({ error: "DELIVERY_CURSOR_REGRESSION", cursor: currentCursor }, 409);
    }
  } catch {
    // A concurrent retry may have won the unique-key race. Re-read and
    // accept only an exact replay; never reinterpret a conflicting body.
    const raced = await env.DB.prepare(
      "SELECT ack_id, device_id, payload_sha256, cursor, request_sha256, acknowledged_at FROM delivery_acknowledgements WHERE ack_id = ? OR (device_id = ? AND stream = ? AND delivery_id = ?) LIMIT 1"
    ).bind(ackId, ctx.deviceId, stream, deliveryId).first();
    if (raced && raced.device_id === ctx.deviceId &&
        raced.payload_sha256 === payloadSha256 && Number(raced.cursor) === cursor &&
        (raced.ack_id !== ackId || raced.request_sha256 === requestHash)) {
      return json({
        acknowledged: true, duplicate: true, ackId: raced.ack_id,
        deliveryId, stream, cursor,
        acknowledgedAt: Number(raced.acknowledged_at)
      });
    }
    return json({ error: "ACK_CONFLICT" }, 409);
  }

  return json({
    acknowledged: true, duplicate: false, ackId, deliveryId, stream,
    cursor, acknowledgedAt: now
  });
}

async function handle(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/v1/support/contacts") return getOfficialSupportContacts(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/support/contacts/register") return registerOfficialSupportContacts(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/support/contacts/update") return updateOfficialSupportContacts(request, env);

  if (request.method === "GET" && url.pathname === "/operator/replacements") return operatorReplacementPanelResponse();
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ service: "SENE licensing API", status: "ok", version: 1 });
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/events") return listAdminEvents(request, env);
  if (request.method === "POST" && url.pathname === "/v1/admin/events/ack") return acknowledgeAdminEvents(request, env);
  if (request.method === "POST" && url.pathname === "/v1/admin/login") return adminLogin(request, env);
  if (request.method === "POST" && url.pathname === "/v1/admin/logout") return adminLogout(request, env);
  if (request.method === "POST" && url.pathname === "/v1/challenges") {
    return issueChallenge(request, env);
  }

  if (request.method === "POST" && url.pathname === "/v1/patron/activate") {
    return activatePatron(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/patron/registrations/request") return createPatronRegistrationRequest(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/recovery/request") return createPatronRecoveryPaymentRequest(request, env);
  if (request.method === "GET" && url.pathname === "/v1/operator/patron-recovery-payments/pending") return listOperatorPatronRecoveryPayments(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/patron-recovery-payments/authorize") return authorizePatronRecoveryPayment(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/licenses/register-legacy-contacts") return registerLegacyLicenseContacts(request, env);
  if (request.method === "GET" && url.pathname === "/v1/operator/licenses") return listOperatorLicenses(request, env);
  if (request.method === "GET" && url.pathname === "/v1/operator/audit") return listOperatorAudit(request, env);
  if (request.method === "GET" && url.pathname === "/v1/operator/registrations/pending") return listOperatorRegistrations(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/registrations/authorize") return authorizePatronRegistration(request, env);

  if (request.method === "POST" && url.pathname === "/v1/patron/recover") return recoverPatron(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/restore") return restorePatron(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/patron-recovery/create") return createPatronRecovery(request, env);
  if (request.method === "GET" && url.pathname === "/v1/operator/patron-recovery/pending") return listPatronRecoveries(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/patron-recovery/reissue-code") return reissuePatronRecoveryCode(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/patron-recovery/cancel") return cancelPatronRecovery(request, env);

  if (request.method === "POST" && url.pathname === "/v1/patron/pairing-tokens") {
    return createPairingToken(request, env);
  }

  if (request.method === "POST" && url.pathname === "/v1/ventas/restore") return restoreVentas(request, env);

  if (request.method === "POST" && url.pathname === "/v1/ventas/pair") {
    return pairVentas(request, env);
  }

  if (request.method === "POST" && url.pathname === "/v1/device/session") {
    return deviceSession(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/patron/renewals/request") return createRenewalRequest(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/renewals/redeem") return redeemRenewal(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/devices/replacement-request") return createReplacementRequest(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/devices/replacement-redeem") return redeemReplacement(request, env);
  if (request.method === "GET" && url.pathname === "/v1/operator/replacements/pending") return listOperatorReplacements(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/replacements/authorize") return authorizeOperatorReplacement(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/replacements/approve") return decideOperatorReplacement(request, env, "approve");
  if (request.method === "POST" && url.pathname === "/v1/operator/replacements/reject") return decideOperatorReplacement(request, env, "reject");
  if (request.method === "POST" && url.pathname === "/v1/operator/licenses/create") return json({ error: "LEGACY_ENDPOINT_RETIRED", message: "Usa el registro solicitado desde SENE PATRÓN." }, 410);
  if (request.method === "POST" && url.pathname === "/v1/operator/licenses/confirm-initial-payment") return confirmInitialPayment(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/licenses/reissue-activation-code") return reissueActivationCode(request, env);
  if (request.method === "GET" && url.pathname === "/v1/operator/renewals/pending") return listOperatorRenewals(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/renewals/authorize") return authorizeRenewal(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/renewals/reissue-code") return reissueRenewalCode(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/renewals/cancel") return cancelRenewal(request, env);

  if (request.method === "POST" && url.pathname === "/v1/ventas/requests") return createWorkRequest(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/requests/inbox") return patronRequestsInbox(request, env);
  if (request.method === "POST" && url.pathname === "/v1/ventas/payroll/settings/get") return ventasPayrollSettingsGet(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/payroll/settings/get") return patronPayrollSettingsGet(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/payroll/settings/set") return patronPayrollSettingsSet(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/notifications") return patronNotifications(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/devices/list") return patronDevicesList(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/requests/decision") return decideWorkRequest(request, env);
  if (request.method === "POST" && url.pathname === "/v1/ventas/requests/history") return ventasRequestHistory(request, env);
  if (request.method === "POST" && url.pathname === "/v1/ventas/requests/updates") return ventasRequestUpdates(request, env);
  if (request.method === "POST" && url.pathname === "/v1/ventas/shift-reports") return saveReport(request, env, "VENTAS_SHIFT_REPORT", "shift_reports", "shiftKey", "shift_key");
  if (request.method === "POST" && url.pathname === "/v1/ventas/payroll-reports") return saveReport(request, env, "VENTAS_PAYROLL_REPORT", "payroll_reports", "periodKey", "period_key");
  if (request.method === "POST" && url.pathname === "/v1/patron/reports/inbox") return patronReportsInbox(request, env);
  if (request.method === "POST" && url.pathname === "/v1/ventas/inventory/daily") return saveDailyInventory(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/payday/bundle") return createOrReadPaydayBundle(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/payday/ack") return acknowledgePaydayBundle(request, env);
  if (request.method === "POST" && url.pathname === "/v1/deliveries/ack") return acknowledgeUniversalDelivery(request, env);
  if (request.method === "POST" && url.pathname === "/v1/ventas/corrections") return createCorrectionRequest(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/corrections/inbox") return patronCorrectionsInbox(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/corrections/decision") return decideCorrectionRequest(request, env);
  if (request.method === "POST" && url.pathname === "/v1/ventas/corrections/consume") return consumeCorrectionGrant(request, env);

  // Retired legacy endpoint: it bypassed the official AYUDA contact and payment workflow.
  // Keep an explicit rejection so old clients cannot silently fall through to another flow.
  if (request.method === "POST" && url.pathname === "/admin/licenses") {
    return json({ error: "LEGACY_ENDPOINT_RETIRED", message: "Usa el flujo oficial de licencias y entrega verificada por AYUDA." }, 410);
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
