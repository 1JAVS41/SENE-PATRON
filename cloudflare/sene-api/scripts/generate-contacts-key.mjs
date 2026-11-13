import { generateKeyPairSync } from "node:crypto";

// Ejecutar localmente en una computadora segura. No guardar la salida privada en Git.
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privateJwk = privateKey.export({ format: "jwk" });
const publicKeyX509Base64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

process.stdout.write(JSON.stringify({
  keyId: "sene-official-contacts-v1",
  privateJwk,
  publicKeyX509Base64
}, null, 2) + "\n");
