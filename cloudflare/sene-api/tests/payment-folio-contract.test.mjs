import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");
const app = readFileSync(new URL("../../../src/main/java/com/sene/patron/MainActivity.kt", import.meta.url), "utf8");

function bodyOf(source, startName, endName) {
  const start = source.indexOf(startName);
  const end = source.indexOf(endName, start);
  assert.ok(start >= 0 && end > start, "No se encontró " + startName);
  return source.slice(start, end);
}

const registration = bodyOf(worker, "async function createPatronRegistrationRequest", "function normalizeOfficialPhone");
assert.ok(registration.includes("folio: id") && registration.includes("folio: existingForDevice.id"));
assert.ok(registration.includes("folio de solicitud: ${id}"));

const recovery = bodyOf(worker, "async function createPatronRecoveryPaymentRequest", "async function listOperatorPatronRecoveryPayments");
assert.ok(recovery.includes("folio:id") && recovery.includes("folio:existing.id") && recovery.includes("folio:raced.id"));
assert.ok(recovery.includes("folio: ${id}"));

const renewal = bodyOf(worker, "async function createRenewalRequest", "async function listOperatorRenewals");
assert.ok(renewal.includes("folio: id") && renewal.includes("folio: existing.id") && renewal.includes("folio: raced.id"));
assert.ok(renewal.includes("folio: ${id}"));

const replacement = bodyOf(worker, "async function createReplacementRequest", "async function listOperatorReplacements");
assert.ok(replacement.includes("folio: requestId") && replacement.includes("folio: existing.id") && replacement.includes("folio: raced.id"));
assert.ok(replacement.includes("folio: ${requestId}"));

assert.ok(app.includes("CREAR SOLICITUD Y OBTENER FOLIO"));
assert.ok(app.includes("private fun showPaymentFolioDialog"));
assert.ok(app.includes("private fun sendPaymentNoticeToAyuda"));
assert.ok(app.includes("Folio de solicitud: $folio"));
assert.ok(app.includes('sendPaymentNoticeToAyuda(requestId, "$580 MXN", "REGISTRO INICIAL")'));
console.log("PASS: registro, renovación, recuperación y reposición reutilizan el mismo folio y lo incluyen en el aviso de WhatsApp");
