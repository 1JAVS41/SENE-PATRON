import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const match = source.match(String.raw`function validIsoDate\(value\) \{\s*if \([^\n]*!\/(.*?)\/\.test\(value\)\)`);
const match = source.match(/function validIsoDate\\(value\\) \\{\\s*if \\([^\\n]*!\\/(.*?)\\/\\.test\\(value\\)\\)/);
assert.ok(match, "validIsoDate debe validar el formato ISO YYYY-MM-DD");
const format = new RegExp(match[1]);
const validIsoDate = value => {
  if (typeof value !== "string" || !format.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

for (const value of ["2026-01-01", "2024-02-29", "2000-12-31"]) {
  assert.equal(validIsoDate(value), true, value + " debe aceptarse");
}
for (const value of ["", "2026-1-01", "26-01-01", "2026-02-29", "2025-13-01", "2025-04-31", "2025/04/30", null, 20260430]) {
  assert.equal(validIsoDate(value), false, String(value) + " debe rechazarse");
}
console.log("PASS: fechas ISO válidas, formato estricto y fechas imposibles rechazadas");
