import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");
const createStart = source.indexOf("async function createOrReadPaydayBundle");
const ackStart = source.indexOf("async function acknowledgePaydayBundle", createStart);
assert.ok(createStart >= 0 && ackStart > createStart, "Deben existir los dos manejadores de nómina");
const create = source.slice(createStart, ackStart);
assert.ok(create.includes("payload: JSON.parse(existing.payload_json)"), "El reintento debe devolver el paquete persistido original");
assert.ok(!create.includes("UPDATE payday_deliveries SET payload_json=?"), "Un paquete pendiente no debe cambiar después de emitirse");
assert.ok(create.includes('status: "pending"') && create.includes("duplicate: true"), "El reintento debe conservar el estado pendiente e indicar duplicado");
const ackEnd = source.indexOf("\nfunction validateOfficialContacts", ackStart);
const ack = source.slice(ackStart, ackEnd > ackStart ? ackEnd : undefined);
assert.ok(ack.includes("env.DB.batch(["), "El ACK y la limpieza deben ejecutarse en un lote atómico");
assert.ok(ack.includes("status='acked'"), "El ACK debe marcar la entrega antes de compactarla");
assert.ok(ack.includes("payloadCompacted: true"), "El servidor debe devolver recibo compacto después de confirmar");
console.log("PASS: paquete de nómina inmutable durante reintentos; limpieza solo después del ACK");
