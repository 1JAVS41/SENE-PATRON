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
  VENTAS_PAIR: ["POST", "/v1/ventas/pair"],
  DEVICE_AUTH: ["POST", "/v1/device/session"],
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

async function handle(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ service: "SENE licensing API", status: "ok", version: 1 });
  }

  if (request.method === "POST" && url.pathname === "/v1/challenges") {
    return issueChallenge(request, env);
  }

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
