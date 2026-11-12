import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import worker from "../src/worker.mjs";

const bytesToHex = (value) => Buffer.from(value).toString("hex");
const sha256 = async (value) => bytesToHex(await webcrypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(value)
));
const derInteger = (raw) => {
  let value = Buffer.from(raw);
  while (value.length > 1 && value[0] === 0) value = value.subarray(1);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return Buffer.concat([Buffer.from([0x02, value.length]), value]);
};
const rawEcdsaToDer = (raw) => {
  const r = derInteger(raw.subarray(0, 32));
  const s = derInteger(raw.subarray(32, 64));
  const body = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};

const pair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
);
const spki = new Uint8Array(await webcrypto.subtle.exportKey("spki", pair.publicKey));
const deviceId = "device-ack-test-01";
const device = {
  id: deviceId, installation_id: "123e4567-e89b-42d3-a456-426614174000",
  fingerprint: await sha256(Buffer.from(spki).toString("base64")),
  public_key: spki, status: "active", device_type: "VENTAS",
  slot_number: 1, license_id: "license-ack-test"
};
const license = { status: "active", expires_at: Math.floor(Date.now() / 1000) + 86400 };
const challenges = new Map();
const acknowledgements = new Map();
const deliveries = new Map();
const cursors = new Map();
const db = {
  prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() {
        if (sql.includes("FROM devices WHERE id = ?")) return args[0] === deviceId ? device : null;
        if (sql.includes("FROM challenges WHERE id = ?")) return challenges.get(args[0]) ?? null;
        if (sql.includes("JOIN licenses l ON l.id = d.license_id")) {
          return args[0] === deviceId ? { ...device, license_status: license.status, expires_at: license.expires_at } : null;
        }
        if (sql.includes("FROM delivery_acknowledgements WHERE ack_id = ?")) return acknowledgements.get(args[0]) ?? null;
        if (sql.includes("FROM delivery_acknowledgements WHERE device_id = ?")) {
          return deliveries.get([args[0], args[1], args[2]].join("|")) ?? null;
        }
        if (sql.includes("FROM delivery_ack_cursors")) {
          return cursors.get([args[0], args[1]].join("|")) ?? null;
        }
        throw new Error("Unexpected first query: " + sql);
      },
      async run() {
        if (sql.includes("INSERT INTO challenges")) {
          const [id, nonce, purpose, installation_id, created_at, expires_at,
            device_id, fingerprint, target_method, target_path, body_sha256, signing_message] = args;
          challenges.set(id, { id, nonce, purpose, installation_id, created_at,
            expires_at, consumed_at: null, device_id, fingerprint, target_method,
            target_path, body_sha256, signing_message });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE challenges SET consumed_at")) {
          const row = challenges.get(args[1]);
          if (!row || row.consumed_at !== null) return { meta: { changes: 0 } };
          row.consumed_at = args[0];
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO delivery_acknowledgements")) {
          const [ack_id, license_id, device_id, stream, delivery_id,
            payload_sha256, cursor, request_sha256, acknowledged_at] = args;
          const row = { ack_id, license_id, device_id, stream, delivery_id,
            payload_sha256, cursor, request_sha256, acknowledged_at };
          acknowledgements.set(ack_id, row);
          deliveries.set([device_id, stream, delivery_id].join("|"), row);
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO delivery_ack_cursors")) {
          const [device_id, stream, cursor, updated_at] = args;
          const key = [device_id, stream].join("|");
          const current = cursors.get(key);
          if (current && current.last_cursor > cursor) return { meta: { changes: 0 } };
          cursors.set(key, { last_cursor: cursor, updated_at });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("DELETE FROM delivery_acknowledgements")) {
          const row = acknowledgements.get(args[0]);
          if (row) deliveries.delete([row.device_id, row.stream, row.delivery_id].join("|"));
          acknowledgements.delete(args[0]);
          return { meta: { changes: row ? 1 : 0 } };
        }
        throw new Error("Unexpected run query: " + sql);
      }
    };
  },
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
};
const env = { DB: db };

async function signedAck(body) {
  const bodyText = JSON.stringify(body);
  const bodySha256 = await sha256(bodyText);
  const challengeResponse = await worker.fetch(new Request("https://sene.test/v1/challenges", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      purpose: "DELIVERY_ACK", deviceId,
      targetMethod: "POST", targetPath: "/v1/deliveries/ack", bodySha256
    })
  }), env);
  assert.equal(challengeResponse.status, 201, "El desafío DELIVERY_ACK debe emitirse");
  const challenge = await challengeResponse.json();
  const signingMessage = Buffer.from(challenge.signingMessage, "base64url");
  const rawSignature = new Uint8Array(await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signingMessage
  ));
  const signature = rawEcdsaToDer(Buffer.from(rawSignature)).toString("base64");
  return worker.fetch(new Request("https://sene.test/v1/deliveries/ack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-SENE-Challenge": challenge.challengeId,
      "X-SENE-Signature": signature,
      "X-SENE-Device": deviceId
    },
    body: bodyText
  }), env);
}

const body = {
  ackId: "123e4567-e89b-42d3-a456-426614174001",
  stream: "PATRON_REQUESTS",
  deliveryId: "PATRON_REQUESTS:" + "a".repeat(48),
  payloadSha256: "a".repeat(64),
  cursor: 1,
  recipientDeviceId: deviceId
};
const first = await signedAck(body);
assert.equal(first.status, 200);
assert.equal((await first.json()).duplicate, false);
const retry = await signedAck(body);
assert.equal(retry.status, 200);
assert.equal((await retry.json()).duplicate, true);

const reusedAckId = await signedAck({
  ...body, payloadSha256: "b".repeat(64),
  deliveryId: "PATRON_REQUESTS:" + "b".repeat(48)
});
assert.equal(reusedAckId.status, 409, "Un ackId no puede reutilizarse con otro cuerpo");

const reusedDelivery = await signedAck({ ...body, ackId: "123e4567-e89b-42d3-a456-426614174002" });
assert.equal(reusedDelivery.status, 200);
assert.equal((await reusedDelivery.json()).duplicate, true);

const conflictingDelivery = await signedAck({
  ...body, ackId: "123e4567-e89b-42d3-a456-426614174003", payloadSha256: "c".repeat(64)
});
assert.equal(conflictingDelivery.status, 400, "El identificador de entrega debe estar ligado a la huella");

const regressingCursor = await signedAck({
  ...body,
  ackId: "123e4567-e89b-42d3-a456-426614174004",
  payloadSha256: "d".repeat(64),
  deliveryId: "PATRON_REQUESTS:" + "d".repeat(48),
  cursor: 0
});
assert.equal(regressingCursor.status, 409, "El cursor de un flujo no puede retroceder");
assert.equal(acknowledgements.size, 1, "Los reintentos y conflictos no deben duplicar el recibo");
console.log("PASS: ACK firmado, durable, idempotente, sin duplicados y con conflictos detectados");
