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

async function requireAdmin(request, env) {
  const supplied = request.headers.get("authorization") || "";
  return Boolean(env.ADMIN_TOKEN && supplied === `Bearer ${env.ADMIN_TOKEN}`);
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
  const newDeviceId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE devices SET status = 'revoked' WHERE id = ? AND license_id = ? AND device_type = 'PATRON' AND slot_number = 1 AND status = 'active' AND EXISTS (SELECT 1 FROM patron_recovery_requests WHERE id = ? AND code_hash = ? AND status = 'pending')"
      ).bind(recovery.old_patron_device_id, recovery.license_id, recovery.id, codeHash),
      env.DB.prepare(
        "UPDATE pairing_tokens SET revoked_at = ? WHERE license_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND status = 'revoked') AND EXISTS (SELECT 1 FROM patron_recovery_requests WHERE id = ? AND code_hash = ? AND status = 'pending')"
      ).bind(now, recovery.license_id, recovery.old_patron_device_id, recovery.id, codeHash),
      env.DB.prepare(
        "INSERT INTO devices (id, license_id, device_type, installation_id, continuity_id, public_key, fingerprint, slot_number, status, created_at) SELECT ?, r.license_id, 'PATRON', ?, ?, ?, ?, 1, 'active', ? FROM patron_recovery_requests r JOIN licenses l ON l.id = r.license_id JOIN devices old ON old.id = r.old_patron_device_id WHERE r.id = ? AND r.code_hash = ? AND r.status = 'pending' AND old.status = 'revoked' AND l.status IN ('active','expired') AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.license_id = r.license_id AND d.slot_number = 1 AND d.status = 'active')"
      ).bind(newDeviceId, identity.installationId, body.continuityId.toLowerCase(), identity.publicKey, identity.fingerprint, now, recovery.id, codeHash),
      // Conserva cualquier solicitud de mensualidad abierta y su código pagado,
      // trasladándolos al nuevo dispositivo PATRÓN dentro de la misma transacción.
      env.DB.prepare(
        "UPDATE renewal_requests SET patron_device_id = ? WHERE license_id = ? AND patron_device_id = ? AND status IN ('pending_payment','authorized') AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND status = 'active')"
      ).bind(newDeviceId, recovery.license_id, recovery.old_patron_device_id, newDeviceId),
      env.DB.prepare(
        "UPDATE patron_recovery_requests SET status = 'consumed', consumed_at = ? WHERE id = ? AND code_hash = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND license_id = patron_recovery_requests.license_id AND device_type = 'PATRON' AND status = 'active')"
      ).bind(now, recovery.id, codeHash, newDeviceId),
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
  if ([0, 2, 4, 5].some((index) => (results?.[index]?.meta?.changes ?? 0) !== 1) ||
      (paidRecovery && (results?.[6]?.meta?.changes ?? 0) !== 1)) {
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
  const businessName = typeof body.businessName === "string" ? body.businessName.trim().replace(/\\s+/g, " ") : "";
  const email = typeof body.registeredEmail === "string" ? body.registeredEmail.trim().toLowerCase() : "";
  const phone = typeof body.registeredPhone === "string" ? body.registeredPhone.replace(/\\D/g, "") : "";
  const identity = await validateBootstrapIdentity(body);
  if (!identity || !businessName || businessName.length > 100 ||
      !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || phone.length < 10 || phone.length > 15 ||
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
  const now = Math.floor(Date.now() / 1000);
  const statements = [
    env.DB.prepare(
      "UPDATE patron_recovery_requests SET code_hash = ? WHERE id = ? AND status = 'pending' AND code_hash = ? AND EXISTS (SELECT 1 FROM devices WHERE id = patron_recovery_requests.old_patron_device_id AND status = 'active')"
    ).bind(codeHash, requestId, existing.code_hash)
  ];
  if (paidRequest) {
    statements.push(env.DB.prepare(
      "UPDATE patron_recovery_payment_requests SET code_hash = ? WHERE id = ? AND code_hash = ? AND status = 'authorized'"
    ).bind(codeHash, paidRequest.id, existing.code_hash));
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
            AND consumed_at IS NULL AND operation = 'NEW'
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
  return typeof expected === "string" && expected.length >= 32 &&
    constantTimeTextEqual(supplied, expected);
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
      Object.keys(body).some((key) => !["businessName","registeredEmail","registeredPhone"].includes(key)) ||
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
    return json({ requestId:existing.id,status:existing.status,createdAt:existing.created_at,amountCents:50000,currency:"MXN",duplicate:true });
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
      return json({requestId:raced.id,status:raced.status,createdAt:raced.created_at,amountCents:50000,currency:"MXN",duplicate:true});
    }
    return json({error:"RECOVERY_REQUEST_FAILED"},503);
  }
  return json({requestId:id,status:"pending_payment",createdAt:now,amountCents:50000,currency:"MXN",businessName:license.business_name,
    instructions:"Reposición de SENE PATRÓN: realiza un pago de $500 MXN. En el concepto escribe únicamente: Reposición SENE PATRÓN. Envía el comprobante a uno de los números oficiales del botón AYUDA por WhatsApp. Después pulsa YA REALICÉ EL PAGO. El código se entrega únicamente después de verificar el pago."},201);
}

async function listOperatorPatronRecoveryPayments(request, env) {
  if (!(await requireOperator(request, env))) return json({error:"UNAUTHORIZED"},401);
  const rows=await env.DB.prepare("SELECT r.id,r.license_id,l.business_name,r.registered_email,r.registered_phone,r.created_at,r.installation_id,r.fingerprint FROM patron_recovery_payment_requests r JOIN licenses l ON l.id=r.license_id WHERE r.status='pending_payment' ORDER BY r.created_at ASC LIMIT 100").all();
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
  if (!row||row.status!=="pending_payment") return json({error:"RECOVERY_NOT_PENDING"},409);
  const oldPatron=await env.DB.prepare("SELECT id FROM devices WHERE id=? AND license_id=? AND device_type='PATRON' AND slot_number=1 AND status='active' LIMIT 1").bind(row.old_patron_device_id,row.license_id).first();
  if (!oldPatron) return json({error:"OLD_PATRON_DEVICE_NOT_FOUND"},409);
  const code=makeCode(), hash=await sha256(code), now=Math.floor(Date.now()/1000), recoveryId=crypto.randomUUID();
  const results=await env.DB.batch([
    // Insertar la autorización solo si la solicitud sigue pendiente y el equipo anterior
    // continúa activo. Evita crear códigos huérfanos si dos operadores autorizan a la vez.
    env.DB.prepare("INSERT INTO patron_recovery_requests (id,license_id,old_patron_device_id,code_hash,reason,status,created_at,created_by) SELECT ?,p.license_id,p.old_patron_device_id,?,?,'pending',?,'operator' FROM patron_recovery_payment_requests p JOIN devices d ON d.id=p.old_patron_device_id AND d.license_id=p.license_id WHERE p.id=? AND p.license_id=? AND p.status='pending_payment' AND p.old_patron_device_id=? AND d.device_type='PATRON' AND d.slot_number=1 AND d.status='active'").bind(recoveryId,hash,"Reposición SENE PATRÓN",now,requestId,row.license_id,row.old_patron_device_id),
    env.DB.prepare("UPDATE patron_recovery_payment_requests SET status='authorized',code_hash=?,payment_reference=?,authorized_at=? WHERE id=? AND license_id=? AND status='pending_payment' AND EXISTS (SELECT 1 FROM patron_recovery_requests WHERE id=? AND license_id=? AND code_hash=? AND status='pending')").bind(hash,reference,now,requestId,row.license_id,recoveryId,row.license_id,hash),
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
      Object.keys(body).some((key) => !["businessName","registeredEmail","registeredPhone"].includes(key)) ||
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
    return json({ requestId: existingForDevice.id, businessName: existingForDevice.business_name,
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
    requestId: id, businessName, status: "pending_payment", createdAt: now,
    expiresAt, serverTime: now, reservationSeconds: 48 * 60 * 60,
    amountCents: 58000, currency: "MXN", package: "1_PATRON_2_VENTAS",
    instructions: "Realiza el pago inicial de $580 MXN. En el concepto escribe únicamente el nombre exacto de tu empresa. Envía el comprobante a uno de los números oficiales de AYUDA por WhatsApp. Después pulsa YA REALICÉ EL PAGO. El código se entrega únicamente después de verificar el pago."
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
  const phone = typeof body.registeredPhone === "string" ? body.registeredPhone.replace(/\\D/g, "") : "";
  const verificationNote = typeof body.verificationNote === "string" ? body.verificationNote.trim().slice(0, 200) : "";
  if (!/^[0-9a-f-]{36}$/i.test(licenseId) ||
      !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) ||
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
  if (existing) return json({ requestId: existing.id, status: existing.status, createdAt: existing.created_at, duplicate: true });
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
    if (raced) return json({ requestId: raced.id, status: raced.status, createdAt: raced.created_at, duplicate: true });
    return json({ error: "SERVICE_UNAVAILABLE" }, 503);
  }
  return json({
    requestId: id, status: "pending_payment", createdAt: now,
    amountCents: 8000, currency: "MXN",
    instructions: "Paga $80 MXN, escribe el nombre exacto de tu empresa en el concepto y envía el comprobante a los canales oficiales de Ayuda. Después espera el código de autorización."
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
  const rows = await env.DB.prepare(
    "SELECT id, license_id, business_name, status, created_at FROM renewal_requests WHERE status = 'pending_payment' ORDER BY created_at ASC LIMIT 100"
  ).all();
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
    requestId: existing.id, status: existing.payment_status, amountCents: 50000,
    currency: "MXN", createdAt: Number(existing.created_at), duplicate: true,
    message: "La solicitud ya existe; conserva el mismo folio y no realices otro pago."
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
    if (raced) return json({ requestId: raced.id, status: raced.payment_status, amountCents: 50000, currency: "MXN", createdAt: Number(raced.created_at), duplicate: true });
    return json({ error: "REPLACEMENT_REQUEST_CONFLICT" }, 409);
  }
  return json({
    requestId, deviceId: oldDeviceId,
    slot: oldDevice.slot_number === 2 ? "VENTAS_1" : "VENTAS_2",
    status: "pending_payment", amountCents: 50000, currency: "MXN",
    createdAt: now,
    message: "Paga $500 MXN y espera la validación. El equipo anterior seguirá activo hasta canjear el código."
  }, 201);
}

async function listOperatorReplacements(request, env) {
  if (!(await requireOperator(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  const rows = await env.DB.prepare(
    "SELECT r.id,r.license_id,l.business_name,r.old_device_id,r.slot_number,r.reason,r.created_at,p.id AS payment_request_id,p.status AS payment_status,p.payment_reference,p.authorized_at FROM replacement_requests r JOIN replacement_payment_requests p ON p.replacement_request_id=r.id JOIN licenses l ON l.id=r.license_id WHERE p.status IN ('pending_payment','authorized') ORDER BY r.created_at ASC LIMIT 100"
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
  // Approval without verified $500 payment and one-time code is forbidden.
  // Keep the legacy route retired so it cannot revoke the old device early.
  if (decision === "approve") return json({
    error: "PAYMENT_WORKFLOW_REQUIRED",
    message: "La reposición requiere validar el pago de $500 MXN y emitir un código de un solo uso."
  }, 410);
  let body;
  try { body = await request.json(); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return json({ error: "INVALID_REQUEST" }, 400);
  const row = await env.DB.prepare(
    "SELECT id, license_id, old_device_id, slot_number FROM replacement_requests WHERE id = ? AND status = 'pending' LIMIT 1"
  ).bind(requestId).first();
  if (!row) return json({ error: "REPLACEMENT_NOT_PENDING" }, 409);
  const now = Math.floor(Date.now() / 1000);
  try {
    let results;
    if (decision === "approve") {
      results = await env.DB.batch([
        env.DB.prepare(
          "UPDATE devices SET status = 'revoked' WHERE id = ? AND license_id = ? AND slot_number = ? AND device_type = 'VENTAS' AND status = 'active'"
        ).bind(row.old_device_id, row.license_id, row.slot_number),
        env.DB.prepare(
          "UPDATE replacement_requests SET status = 'approved', decided_at = ?, decided_by = 'operator' WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND status = 'revoked')"
        ).bind(now, requestId, row.old_device_id),
        env.DB.prepare(
          "UPDATE pairing_tokens SET revoked_at = ? WHERE license_id = ? AND revoked_at IS NULL AND (slot_number = ? OR slot_number IS NULL)"
        ).bind(now, row.license_id, row.slot_number),
        env.DB.prepare(
          "INSERT INTO audit_log (id, license_id, device_id, actor_type, actor_id, event_type, details_json, created_at) SELECT ?, ?, ?, 'operator', 'operator', 'device_replacement_approved', ?, ? WHERE EXISTS (SELECT 1 FROM replacement_requests WHERE id = ? AND status = 'approved')"
        ).bind(crypto.randomUUID(), row.license_id, row.old_device_id, JSON.stringify({ requestId, slotNumber: row.slot_number }), now, requestId)
      ]);
      if ((results?.[0]?.meta?.changes ?? 0) !== 1 || (results?.[1]?.meta?.changes ?? 0) !== 1) {
        return json({ error: "REPLACEMENT_CONFLICT" }, 409);
      }
      return json({ requestId, status: "approved", revokedDeviceId: row.old_device_id, slot: row.slot_number === 2 ? "VENTAS_1" : "VENTAS_2", nextStep: "El PATRÓN debe generar un QR nuevo; el equipo sustituto se vincula ocupando el espacio liberado." });
    }
    results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE replacement_requests SET status = 'rejected', decided_at = ?, decided_by = 'operator' WHERE id = ? AND status = 'pending'"
      ).bind(now, requestId),
      env.DB.prepare(
        "UPDATE replacement_payment_requests SET status='cancelled' WHERE replacement_request_id=? AND status='pending_payment'"
      ).bind(requestId),
      env.DB.prepare(
        "INSERT INTO audit_log (id, license_id, device_id, actor_type, actor_id, event_type, details_json, created_at) SELECT ?, ?, old_device_id, 'operator', 'operator', 'device_replacement_rejected', ?, ? FROM replacement_requests WHERE id = ? AND status = 'rejected' AND decided_at = ?"
      ).bind(crypto.randomUUID(), row.license_id, JSON.stringify({ requestId }), now, requestId, now)
    ]);
    if ((results?.[0]?.meta?.changes ?? 0) !== 1) return json({ error: "REPLACEMENT_CONFLICT" }, 409);
    return json({ requestId, status: "rejected" });
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
  return json({ slot: slot === 2 ? "VENTAS_1" : "VENTAS_2", pendingByTeam, items: (rows.results || []).map((r) => ({
    requestId: r.id, saleId: r.sale_id, reason: r.reason,
    reasons: (() => { try { return JSON.parse(r.reasons_json || "[]"); } catch { return [r.reason]; } })(),
    cashImpact: Number(r.cash_impact) === 1, cashReason: r.cash_reason || "",
    planHash: r.plan_hash, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at
  })) });
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
  const quotaError = await consumeWeeklyQuota(proof.env, deviceId);
  if (quotaError) return quotaError;
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
  return json({
    pendingByTeam,
    items: (rows.results || []).map((r) => ({
      requestId: r.id, type: r.request_type, details: JSON.parse(r.details_json),
      status: r.status, createdAt: r.created_at, decidedAt: r.decided_at,
      slot: r.slot_number === 2 ? "VENTAS_1" : "VENTAS_2"
    })),
    corrections: (correctionRows.results || []).map((r) => ({
      requestId: r.id, saleId: r.sale_id, reason: r.reason, status: r.status,
      createdAt: r.created_at, decidedAt: r.decided_at
    }))
  });
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
  return json({ pendingByTeam, serverTime: Math.floor(Date.now() / 1000) });
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
  return json({
    items: (rows.results || []).map((r) => ({
      requestId: r.id, type: r.request_type, status: r.status,
      decisionDetails: r.decision_json ? JSON.parse(r.decision_json) : {},
      createdAt: r.created_at, decidedAt: r.decided_at
    })),
    corrections: (correctionRows.results || []).map((r) => ({
      requestId: r.id, saleId: r.sale_id, reason: r.reason,
      reasons: (() => { try { return JSON.parse(r.reasons_json || "[]"); } catch { return [r.reason]; } })(),
      cashImpact: Number(r.cash_impact) === 1, cashReason: r.cash_reason || "",
      planHash: r.plan_hash, grantId: r.grant_id || null,
      status: r.status, createdAt: r.created_at, decidedAt: r.decided_at
    }))
  });
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
  return json({
    slot: slot === 2 ? "VENTAS_1" : "VENTAS_2",
    shiftReports: (shifts.results || []).map((r) => ({ reportId: r.id, shiftKey: r.shift_key, report: JSON.parse(r.report_json), createdAt: r.created_at })),
    payrollReports: payrollRows.map((r) => ({ reportId: r.id, periodKey: r.period_key, report: JSON.parse(r.report_json), createdAt: r.created_at })),
    payrollEntries
  });
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

async function handle(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/v1/support/contacts") return getOfficialSupportContacts(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/support/contacts/register") return registerOfficialSupportContacts(request, env);
  if (request.method === "POST" && url.pathname === "/v1/operator/support/contacts/update") return updateOfficialSupportContacts(request, env);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ service: "SENE licensing API", status: "ok", version: 1 });
  }

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
