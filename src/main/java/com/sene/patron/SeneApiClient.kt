package com.sene.patron

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class SeneApiException(val httpStatus: Int, val responseBody: String) :
    IOException("SENE API HTTP $httpStatus: $responseBody")

/**
 * Cliente HTTP firmado para SENE PATRÓN.
 * Ejecutar sus métodos fuera del hilo principal. El baseUrl debe ser HTTPS.
 * No contiene tokens administrativos ni credenciales privadas.
 */
class SeneApiClient(context: Context, baseUrl: String) {
    private val app = context.applicationContext
    private val root = baseUrl.trim().trimEnd('/')
    private val prefs = app.getSharedPreferences("sene_patron_server", Context.MODE_PRIVATE)

    init {
        require(root.startsWith("https://")) { "La dirección del servidor SENE debe usar HTTPS" }
    }

    fun activate(activationCode: String): JSONObject {
        val identity = PatronDeviceIdentity.get(app)
        val body = JSONObject()
            .put("activationCode", activationCode.trim().uppercase())
            .put("installationId", identity.installationId)
            .put("continuityId", identity.continuityId)
            .put("publicKeyBase64", identity.publicKeyBase64)
            .put("fingerprint", identity.fingerprint)
        val result = bootstrapSigned("PATRON_ACTIVATE", "/v1/patron/activate", body.toString(), identity)
        val registeredId = result.optString("deviceId")
        if (registeredId.isNotBlank()) {
            check(prefs.edit().putString("device_id", registeredId).commit()) {
                "No se pudo guardar la vinculación de SENE PATRÓN"
            }
        }
        return result
    }

    fun storedDeviceId(): String? = prefs.getString("device_id", null)?.takeIf { it.isNotBlank() }

    fun createPairingToken(deviceId: String = storedDeviceId()
        ?: throw IllegalStateException("SENE PATRÓN todavía no está vinculado")): JSONObject {
        val body = JSONObject().put("uses", 2)
        return deviceSigned("PATRON_PAIRING_TOKEN", "/v1/patron/pairing-tokens", body.toString(), deviceId)
    }

    fun session(deviceId: String = storedDeviceId()
        ?: throw IllegalStateException("SENE PATRÓN todavía no está vinculado")): JSONObject =
        deviceSigned("DEVICE_AUTH", "/v1/device/session", "{}", deviceId)

    private fun bootstrapSigned(
        purpose: String,
        path: String,
        body: String,
        identity: PatronIdentitySnapshot
    ): JSONObject {
        val challengeBody = JSONObject()
            .put("purpose", purpose)
            .put("installationId", identity.installationId)
            .put("continuityId", identity.continuityId)
            .put("publicKeyBase64", identity.publicKeyBase64)
            .put("fingerprint", identity.fingerprint)
            .put("targetMethod", "POST")
            .put("targetPath", path)
            .put("bodySha256", sha256(body))
        val challenge = post("/v1/challenges", challengeBody.toString())
        val signature = sign(challenge, identity)
        return post(path, body, challenge.getString("challengeId"), signature, null)
    }

    private fun deviceSigned(purpose: String, path: String, body: String, deviceId: String): JSONObject {
        require(deviceId.isNotBlank()) { "Falta el identificador del equipo registrado" }
        val challengeBody = JSONObject()
            .put("purpose", purpose)
            .put("deviceId", deviceId)
            .put("targetMethod", "POST")
            .put("targetPath", path)
            .put("bodySha256", sha256(body))
        val challenge = post("/v1/challenges", challengeBody.toString())
        val signature = sign(challenge, null)
        return post(path, body, challenge.getString("challengeId"), signature, deviceId)
    }

    private fun sign(challenge: JSONObject, identity: PatronIdentitySnapshot?): String {
        val encoded = challenge.getString("signingMessage")
        val message = Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        return if (identity == null) PatronDeviceIdentity.signChallenge(app, message)
        else PatronDeviceIdentity.signChallenge(app, message)
    }

    private fun post(
        path: String,
        body: String,
        challengeId: String? = null,
        signature: String? = null,
        deviceId: String? = null
    ): JSONObject {
        val connection = (URL(root + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 10000
            readTimeout = 15000
            doOutput = true
            useCaches = false
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("X-SENE-Version", "1")
            if (challengeId != null) setRequestProperty("X-SENE-Challenge", challengeId)
            if (signature != null) setRequestProperty("X-SENE-Signature", signature)
            if (deviceId != null) setRequestProperty("X-SENE-Device", deviceId)
        }
        try {
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) throw SeneApiException(status, response)
            return if (response.isBlank()) JSONObject() else JSONObject(response)
        } finally {
            connection.disconnect()
        }
    }

    private fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xFF) }
}
