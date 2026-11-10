package com.sene.patron

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.security.MessageDigest

/** Verifica los contactos AYUDA firmados por el servidor. Nunca acepta datos sin firma válida. */
internal object OfficialSupportVerifier {
    private const val KEY_ID = "sene-official-contacts-v1"
    private const val ALGORITHM = "ECDSA_P256_SHA256"
    private const val PUBLIC_KEY_X509 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEDa1wlfPzS1pMguQM36nv+A596hF4IZz10lUOoOlxVD+KDThMEeXqIc08JTiR6G5n6GyMOZdQFISDWNuesarbKA=="

    fun verifyAndRemember(context: Context, response: JSONObject): JSONObject {
        check(response.optString("keyId") == KEY_ID) { "Identificador de clave oficial desconocido" }
        check(response.optString("algorithm") == ALGORITHM) { "Algoritmo de firma oficial no válido" }
        val payload = response.optJSONObject("payload")
            ?: throw SecurityException("El servidor no entregó los contactos oficiales")
        val expectedFields = setOf("revision", "officialEmail", "helpPhone1", "helpPhone2", "registeredAt", "updatedAt")
        val names = payload.names() ?: throw SecurityException("Contenido oficial incompleto")
        val actualFields = (0 until names.length()).map { names.getString(it) }.toSet()
        check(actualFields == expectedFields) { "El contenido oficial contiene campos inesperados o faltantes" }

        val revision = payload.getLong("revision")
        val registeredAt = payload.getLong("registeredAt")
        val updatedAt = payload.getLong("updatedAt")
        val email = payload.getString("officialEmail").trim()
        val phone1 = payload.getString("helpPhone1").trim()
        val phone2 = payload.getString("helpPhone2").trim()
        check(revision >= 1 && registeredAt > 0 && updatedAt >= registeredAt) {
            "La revisión de contactos oficiales no es válida"
        }
        check(email.length <= 254 && Regex("^[\\x21-\\x7E]+$").matches(email) &&
            Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$").matches(email)) {
            "El correo oficial recibido no es válido"
        }
        check(Regex("^\\+[1-9][0-9]{7,14}$").matches(phone1) &&
            Regex("^\\+[1-9][0-9]{7,14}$").matches(phone2) && phone1 != phone2) {
            "Los teléfonos oficiales recibidos no son válidos"
        }

        // Reproduce exactamente el orden y la representación JSON que firma el Worker.
        val canonical = JSONObject()
            .put("revision", revision)
            .put("officialEmail", email)
            .put("helpPhone1", phone1)
            .put("helpPhone2", phone2)
            .put("registeredAt", registeredAt)
            .put("updatedAt", updatedAt)
            .toString()
        val signatureBytes = Base64.decode(
            response.getString("signature"),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
        )
        check(signatureBytes.size == 64) { "La firma digital oficial tiene un tamaño incorrecto" }
        val publicKey = KeyFactory.getInstance("EC").generatePublic(
            X509EncodedKeySpec(Base64.decode(PUBLIC_KEY_X509, Base64.DEFAULT))
        )
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(publicKey)
        verifier.update(canonical.toByteArray(Charsets.UTF_8))
        check(verifier.verify(rawEcdsaToDer(signatureBytes))) {
            "La firma de los contactos oficiales no coincide. No se mostrarán los datos."
        }

        val digest = MessageDigest.getInstance("SHA-256")
            .digest(canonical.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        val prefs = context.applicationContext.getSharedPreferences("sene_official_support_integrity", Context.MODE_PRIVATE)
        val previousRevision = prefs.getLong("highest_revision", 0L)
        val previousDigest = prefs.getString("revision_digest", null)
        check(revision >= previousRevision) { "El servidor devolvió una revisión anterior de los contactos oficiales" }
        check(revision != previousRevision || previousDigest == null || previousDigest == digest) {
            "La revisión oficial ya fue registrada con otros datos. Posible manipulación detectada."
        }
        if (revision > previousRevision || previousDigest == null) {
            check(prefs.edit().putLong("highest_revision", revision).putString("revision_digest", digest).commit()) {
                "No se pudo proteger la revisión de los contactos oficiales"
            }
        }
        return JSONObject()
            .put("officialEmail", email)
            .put("helpPhone1", phone1)
            .put("helpPhone2", phone2)
            .put("revision", revision)
    }

    private fun rawEcdsaToDer(raw: ByteArray): ByteArray {
        require(raw.size == 64)
        fun integer(part: ByteArray): ByteArray {
            var first = 0
            while (first < part.size - 1 && part[first] == 0.toByte()) first++
            val value = part.copyOfRange(first, part.size)
            val needsZero = (value[0].toInt() and 0x80) != 0
            val body = if (needsZero) byteArrayOf(0) + value else value
            return byteArrayOf(0x02, body.size.toByte()) + body
        }
        val r = integer(raw.copyOfRange(0, 32))
        val s = integer(raw.copyOfRange(32, 64))
        val content = r + s
        require(content.size < 128)
        return byteArrayOf(0x30, content.size.toByte()) + content
    }
}
