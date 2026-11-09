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

  // Count every authenticated remote business operation once per device and
  // Mexico City ISO week. Session checks and bootstrap registration are free.
  // The conditional UPSERT is atomic, so concurrent requests cannot exceed 20.
  if (challenge.device_id && challenge.purpose !== "DEVICE_AUTH") {
    const weekKey = mexicoCityIsoWeek(now);
    let quota;
    try {
      quota = await env.DB.prepare(
        `INSERT INTO weekly_usage (id, device_id, week_key, used, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(device_id, week_key) DO UPDATE
           SET used = weekly_usage.used + 1, updated_at = excluded.updated_at
         WHERE weekly_usage.used < 20
         RETURNING used`
      ).bind(crypto.randomUUID(), challenge.device_id, weekKey, now).first();
    } catch {
      return { ok: false, status: 503, error: "QUOTA_CHECK_UNAVAILABLE" };
    }
    if (!quota) {
      return { ok: false, status: 429, error: "WEEKLY_QUOTA_EXCEEDED" };
    }
  }

  return { ok: true, bodyBytes, bodyText: new TextDecoder().decode(bodyBytes), challenge };
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

async function requireAdmin(request, env) {
  const supplied = request.headers.get("authorization") || "";
  return Boolean(env.ADMIN_TOKEN && supplied === `Bearer ${env.ADMIN_TOKEN}`);
}

const CHALLENGE_TARGETS = {
  PATRON_ACTIVATE: ["POST", "/v1/patron/activate"],
  VENTAS_PAIR: ["POST", "/v1/ventas/pair"],
  DEVICE_AUTH: ["POST", "/v1/device/session"],
  PATRON_PAIRING_TOKEN: ["POST", "/v1/patron/pairing-tokens"],
  VENTAS_REQUEST: ["POST", "/v1/ventas/requests"],
  PATRON_REQUESTS_INBOX: ["POST", "/v1/patron/requests/inbox"],
  PATRON_REQUEST_DECISION: ["POST", "/v1/patron/requests/decision"],
  VENTAS_REQUEST_UPDATES: ["POST", "/v1/ventas/requests/updates"],
  VENTAS_SHIFT_REPORT: ["POST", "/v1/ventas/shift-reports"],
  VENTAS_PAYROLL_REPORT: ["POST", "/v1/ventas/payroll-reports"],
  PATRON_REPORTS_INBOX: ["POST", "/v1/patron/reports/inbox"],
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
    return { installationId, fingerprint, publicKey };
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

  if (purpose === "PATRON_ACTIVATE" || purpose === "VENTAS_PAIR") {
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
            AND l.status = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM devices d
               WHERE d.license_id = l.id AND d.slot_number = 1
            )`
      ).bind(
        deviceId, identity.installationId, body.continuityId.toLowerCase(),
        identity.publicKey, identity.fingerprint, now, codeHash
      ),
      env.DB.prepare(
        `UPDATE licenses
            SET activation_code_hash = NULL
          WHERE activation_code_hash = ?
            AND setup_paid_at IS NOT NULL
            AND status = 'pending'
            AND EXISTS (
              SELECT 1 FROM devices d
               WHERE d.id = ? AND d.license_id = licenses.id
            )`
      ).bind(codeHash, deviceId)
    ]);

    if ((results?.[0]?.meta?.changes ?? 0) !== 1 ||
        (results?.[1]?.meta?.changes ?? 0) !== 1) {
      return json({ error: "ACTIVATION_CODE_INVALID" }, 409);
    }
  } catch {
    return json({ error: "ACTIVATION_CONFLICT_OR_DATABASE_ERROR" }, 409);
  }

  return json({
    deviceId,
    slot: "PATRON",
    licenseStatus: "PENDING_PAYMENT",
    periodEndsAt: null
  }, 201);
}

async function createPairingToken(request, env) {
  const proof = await verifySignedRequest(request, env, "PATRON_PAIRING_TOKEN");
  if (!proof.ok) return json({ error: proof.error }, proof.status);

  let body;
  try { body = JSON.parse(proof.bodyText); } catch {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 1 || body.uses !== 2) {
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

  const token = randomHex(32);
  const tokenHash = await sha256(token);
  const expiresAt = now + 86400; // QR valid for 24 hours; activation code remains non-expiring.
  try {
    await env.DB.prepare(
      `INSERT INTO pairing_tokens
       (token_hash, license_id, patron_device_id, remaining_uses, created_at, expires_at)
       VALUES (?, ?, ?, 2, ?, ?)`
    ).bind(tokenHash, patron.license_id, patron.id, now, expiresAt).run();
  } catch {
    return json({ error: "SERVICE_UNAVAILABLE" }, 503);
  }

  return json({
    qrPayload: `SENEPAIR1:${token}`,
    remainingUses: 2,
    expiresAt
  }, 201);
}

async function pairVentas(request, env) {
  const proof = await verifySignedRequest(request, env, "VENTAS_PAIR");
  if (!proof.ok) return json({ error: proof.error }, proof.status);

  let body;
  try { body = JSON.parse(proof.bodyText); } catch {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
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
         SELECT ?, p.license_id, 'VENTAS', ?, ?, ?, ?,
                CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM devices d2
                     WHERE d2.license_id = p.license_id AND d2.slot_number = 2
                       AND d2.status = 'active'
                  ) THEN 2 ELSE 3
                END,
                'active', ?
           FROM pairing_tokens p
           JOIN licenses l ON l.id = p.license_id
           JOIN devices patron ON patron.id = p.patron_device_id
          WHERE p.token_hash = ?
            AND p.remaining_uses > 0 AND p.revoked_at IS NULL AND p.expires_at >= ?
            AND patron.status = 'active' AND patron.device_type = 'PATRON'
            AND l.status = 'active' AND l.expires_at > ?
            AND NOT EXISTS (
              SELECT 1 FROM devices duplicate
               WHERE duplicate.license_id = p.license_id
                 AND duplicate.fingerprint = ?
            )
            AND (
              NOT EXISTS (SELECT 1 FROM devices d3
                           WHERE d3.license_id = p.license_id
                             AND d3.slot_number = 2 AND d3.status = 'active')
              OR NOT EXISTS (SELECT 1 FROM devices d4
                              WHERE d4.license_id = p.license_id
                                AND d4.slot_number = 3 AND d4.status = 'active')
            )`
      ).bind(
        deviceId, identity.installationId, body.continuityId.toLowerCase(),
        identity.publicKey, identity.fingerprint, now,
        tokenHash, now, now, identity.fingerprint
      ),
      env.DB.prepare(
        `UPDATE pairing_tokens
            SET remaining_uses = remaining_uses - 1
          WHERE token_hash = ? AND remaining_uses > 0
            AND revoked_at IS NULL AND expires_at >= ?
            AND EXISTS (SELECT 1 FROM devices d
                         WHERE d.id = ? AND d.license_id = pairing_tokens.license_id)`
      ).bind(tokenHash, now, deviceId)
    ]);

    if ((results?.[0]?.meta?.changes ?? 0) !== 1 ||
        (results?.[1]?.meta?.changes ?? 0) !== 1) {
      return json({ error: "PAIRING_TOKEN_INVALID_OR_FULL" }, 409);
    }
  } catch {
    return json({ error: "PAIRING_CONFLICT_OR_DATABASE_ERROR" }, 409);
  }

  const registered = await env.DB.prepare(
    "SELECT slot_number, license_id FROM devices WHERE id = ? LIMIT 1"
  ).bind(deviceId).first();
  const license = await env.DB.prepare(
    "SELECT expires_at FROM licenses WHERE id = ? LIMIT 1"
  ).bind(registered.license_id).first();

  return json({
    deviceId,
    slot: registered.slot_number === 2 ? "VENTAS_1" : "VENTAS_2",
    licenseStatus: "ACTIVE",
    periodEndsAt: license.expires_at
  }, 201);
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
            l.id AS license_id, l.status AS license_status, l.expires_at
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

  return json({
    deviceId,
    role: row.device_type,
    slot: row.device_type === "PATRON" ? "PATRON" : `VENTAS_${row.slot_number - 1}`,
    licenseStatus: licenseStatus === "active" ? "ACTIVE" : licenseStatus.toUpperCase(),
    serverTime: now,
    periodEndsAt: row.expires_at ?? null,
    weeklyQuota: { limit: 20, used, remaining: Math.max(0, 20 - used), weekKey }
  });
}



const WORK_REQUEST_TYPES = new Set([
  "LOAN", "CONSUMPTION", "ABSENCE_PERMISSION", "LATE_ARRIVAL",
  "SCHEDULE_CHANGE", "VACATION", "INCIDENT", "SHORTAGE",
  "REST_DAY_CHANGE", "SALARY_ADVANCE", "DAMAGED_EQUIPMENT", "SUGGESTION"
]);

async function signedDeviceContext(proof, expectedType) {
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
  const status = body.status === "all" ? "all" : "pending";
  const slotNumber = slot === "VENTAS_1" ? 2 : slot === "VENTAS_2" ? 3 : null;
  const rows = await env.DB.prepare(
    "SELECT r.id, r.request_type, r.details_json, r.status, r.created_at, r.decided_at, d.slot_number FROM work_requests r JOIN devices d ON d.id = r.ventas_device_id WHERE r.license_id = ? AND (? IS NULL OR d.slot_number = ?) AND (? = 'all' OR r.status = 'pending') ORDER BY r.created_at DESC LIMIT 100"
  ).bind(ctx.licenseId, slotNumber, slotNumber, status).all();
  const counts = await env.DB.prepare(
    "SELECT d.slot_number, COUNT(r.id) AS pending_count FROM devices d LEFT JOIN work_requests r ON r.ventas_device_id = d.id AND r.status = 'pending' WHERE d.license_id = ? AND d.device_type = 'VENTAS' AND d.status = 'active' GROUP BY d.slot_number"
  ).bind(ctx.licenseId).all();
  const pendingByTeam = { VENTAS_1: 0, VENTAS_2: 0 };
  for (const row of (counts.results || [])) {
    if (row.slot_number === 2) pendingByTeam.VENTAS_1 = Number(row.pending_count);
    if (row.slot_number === 3) pendingByTeam.VENTAS_2 = Number(row.pending_count);
  }
  return json({
    pendingByTeam,
    items: (rows.results || []).map((r) => ({
      requestId: r.id, type: r.request_type, details: JSON.parse(r.details_json),
      status: r.status, createdAt: r.created_at, decidedAt: r.decided_at,
      slot: r.slot_number === 2 ? "VENTAS_1" : "VENTAS_2"
    }))
  });
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
    else if (!Number.isInteger(decisionData.deduction.amountCents) || decisionData.deduction.amountCents < 0 || decisionData.deduction.amountCents > 100000000) {
      return json({ error: "INVALID_DEDUCTION" }, 400);
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
  return json({ items: (rows.results || []).map((r) => ({
    requestId: r.id, type: r.request_type, status: r.status,
    decisionDetails: r.decision_json ? JSON.parse(r.decision_json) : {},
    createdAt: r.created_at, decidedAt: r.decided_at
  })) });
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
  const existing = await env.DB.prepare(
    "SELECT id, created_at FROM " + table + " WHERE ventas_device_id = ? AND " + keyName + " = ? LIMIT 1"
  ).bind(ctx.deviceId, key).first();
  if (existing) return json({ reportId: existing.id, createdAt: existing.created_at, duplicate: true });
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      "INSERT INTO " + table + " (id, license_id, ventas_device_id, " + keyName + ", report_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, ctx.licenseId, ctx.deviceId, key, reportJson, now).run();
  } catch {
    const raced = await env.DB.prepare(
      "SELECT id, created_at FROM " + table + " WHERE ventas_device_id = ? AND " + keyName + " = ? LIMIT 1"
    ).bind(ctx.deviceId, key).first();
    if (raced) return json({ reportId: raced.id, createdAt: raced.created_at, duplicate: true });
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
  return json({
    slot: slot === 2 ? "VENTAS_1" : "VENTAS_2",
    shiftReports: (shifts.results || []).map((r) => ({ reportId: r.id, shiftKey: r.shift_key, report: JSON.parse(r.report_json), createdAt: r.created_at })),
    payrollReports: (payroll.results || []).map((r) => ({ reportId: r.id, periodKey: r.period_key, report: JSON.parse(r.report_json), createdAt: r.created_at }))
  });
}

async function handle(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ service: "SENE licensing API", status: "ok", version: 1 });
  }

  if (request.method === "POST" && url.pathname === "/v1/challenges") {
    return issueChallenge(request, env);
  }

  if (request.method === "POST" && url.pathname === "/v1/patron/activate") {
    return activatePatron(request, env);
  }

  if (request.method === "POST" && url.pathname === "/v1/patron/pairing-tokens") {
    return createPairingToken(request, env);
  }

  if (request.method === "POST" && url.pathname === "/v1/ventas/pair") {
    return pairVentas(request, env);
  }

  if (request.method === "POST" && url.pathname === "/v1/device/session") {
    return deviceSession(request, env);
  }

  if (request.method === "POST" && url.pathname === "/v1/ventas/requests") return createWorkRequest(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/requests/inbox") return patronRequestsInbox(request, env);
  if (request.method === "POST" && url.pathname === "/v1/patron/requests/decision") return decideWorkRequest(request, env);
  if (request.method === "POST" && url.pathname === "/v1/ventas/requests/updates") return ventasRequestUpdates(request, env);
  if (request.method === "POST" && url.pathname === "/v1/ventas/shift-reports") return saveReport(request, env, "VENTAS_SHIFT_REPORT", "shift_reports", "shiftKey", "shift_key");
  if (request.method === "POST" && url.pathname === "/v1/ventas/payroll-reports") return saveReport(request, env, "VENTAS_PAYROLL_REPORT", "payroll_reports", "periodKey", "period_key");
  if (request.method === "POST" && url.pathname === "/v1/patron/reports/inbox") return patronReportsInbox(request, env);

  // Temporary operator scaffold only. Do not expose this token in either APK.
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
