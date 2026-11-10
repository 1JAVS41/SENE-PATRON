package com.sene.patron

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class SenePatronApiException(val httpStatus: Int, val responseBody: String) :
    IOException("SENE API HTTP $httpStatus: $responseBody")

/** Cliente HTTPS firmado. Todas las operaciones deben ejecutarse fuera del hilo principal. */
class SenePatronApiClient(context: Context, baseUrl: String) {
    private val app = context.applicationContext
    private val root = baseUrl.trim().trimEnd('/')
    private val prefs = app.getSharedPreferences("sene_patron_server", Context.MODE_PRIVATE)

    init {
        require(root.startsWith("https://")) { "El servidor SENE debe usar HTTPS" }
    }

    fun storedDeviceId(): String? = prefs.getString("device_id", null)?.takeIf { it.isNotBlank() }

    fun activate(activationCode: String): JSONObject {
        val identity = PatronDeviceIdentity.get(app)
        val body = JSONObject()
            .put("activationCode", activationCode.trim())
            .put("installationId", identity.installationId)
            .put("continuityId", identity.continuityId)
            .put("publicKeyBase64", identity.publicKeyBase64)
            .put("fingerprint", identity.fingerprint)
        val result = bootstrapSigned("PATRON_ACTIVATE", "/v1/patron/activate", body.toString(), identity)
        saveDevice(result)
        return result
    }

    fun session(deviceId: String = storedDeviceId()
        ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")): JSONObject =
        deviceSigned("DEVICE_AUTH", "/v1/device/session", "{}", deviceId)

    fun createPairingToken(deviceId: String = storedDeviceId()
        ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")): JSONObject =
        deviceSigned("PATRON_PAIRING_TOKEN", "/v1/patron/pairing-tokens", JSONObject().put("uses", 2).toString(), deviceId)

    fun notifications(deviceId: String = storedDeviceId()
        ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")): JSONObject =
        deviceSigned("PATRON_NOTIFICATIONS", "/v1/patron/notifications", "{}", deviceId)

    fun linkedDevices(deviceId: String = storedDeviceId()
        ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")): JSONObject =
        deviceSigned("PATRON_DEVICES_LIST", "/v1/patron/devices/list", "{}", deviceId)

    fun requestReplacement(
        deviceIdToReplace: String,
        reason: String,
        patronDeviceId: String = storedDeviceId()
            ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")
    ): JSONObject {
        require(deviceIdToReplace.isNotBlank() && reason.isNotBlank())
        val body = JSONObject().put("deviceId", deviceIdToReplace).put("reason", reason.trim())
        return deviceSigned("PATRON_REPLACEMENT_REQUEST", "/v1/patron/devices/replacement-request", body.toString(), patronDeviceId)
    }

    fun requestRenewal(
        patronDeviceId: String = storedDeviceId()
            ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")
    ): JSONObject = deviceSigned("PATRON_RENEWAL_REQUEST", "/v1/patron/renewals/request", "{}", patronDeviceId)

    fun redeemRenewal(
        requestId: String,
        authorizationCode: String,
        patronDeviceId: String = storedDeviceId()
            ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")
    ): JSONObject {
        val body = JSONObject().put("requestId", requestId).put("authorizationCode", authorizationCode.trim())
        return deviceSigned("PATRON_RENEWAL_REDEEM", "/v1/patron/renewals/redeem", body.toString(), patronDeviceId)
    }

    fun recover(recoveryCode: String): JSONObject {
        val identity = PatronDeviceIdentity.get(app)
        val body = JSONObject()
            .put("recoveryCode", recoveryCode.trim().uppercase())
            .put("installationId", identity.installationId)
            .put("continuityId", identity.continuityId)
            .put("publicKeyBase64", identity.publicKeyBase64)
            .put("fingerprint", identity.fingerprint)
        val result = bootstrapSigned("PATRON_RECOVERY", "/v1/patron/recover", body.toString(), identity)
        saveDevice(result)
        return result
    }

    fun requestsInbox(
        slot: String,
        status: String = "pending",
        deviceId: String = storedDeviceId()
            ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")
    ): JSONObject {
        require(slot == "VENTAS_1" || slot == "VENTAS_2")
        require(status == "pending" || status == "all")
        return deviceSigned(
            "PATRON_REQUESTS_INBOX", "/v1/patron/requests/inbox",
            JSONObject().put("slot", slot).put("status", status).toString(), deviceId
        )
    }

    fun decideRequest(
        requestId: String,
        decision: String,
        decisionDetails: JSONObject = JSONObject(),
        deviceId: String = storedDeviceId()
            ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")
    ): JSONObject {
        require(decision == "approve" || decision == "reject")
        val body = JSONObject().put("requestId", requestId).put("decision", decision)
            .put("decisionDetails", decisionDetails)
        return deviceSigned("PATRON_REQUEST_DECISION", "/v1/patron/requests/decision", body.toString(), deviceId)
    }

    fun correctionsInbox(
        slot: String,
        status: String = "pending",
        deviceId: String = storedDeviceId()
            ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")
    ): JSONObject {
        require(slot == "VENTAS_1" || slot == "VENTAS_2")
        return deviceSigned(
            "PATRON_CORRECTIONS_INBOX", "/v1/patron/corrections/inbox",
            JSONObject().put("slot", slot).put("status", status).toString(), deviceId
        )
    }

    fun decideCorrection(
        requestId: String,
        decision: String,
        deviceId: String = storedDeviceId()
            ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")
    ): JSONObject {
        require(decision == "approve" || decision == "reject")
        val body = JSONObject().put("requestId", requestId).put("decision", decision)
        return deviceSigned("PATRON_CORRECTION_DECISION", "/v1/patron/corrections/decision", body.toString(), deviceId)
    }

    fun payrollSettings(
        deviceId: String = storedDeviceId()
            ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")
    ): JSONObject = deviceSigned("PATRON_PAYROLL_SETTINGS_GET", "/v1/patron/payroll/settings/get", "{}", deviceId)

    fun savePayrollSettings(
        slot: String,
        salaryCents: Long,
        paymentDay: Int?,
        paymentDates: JSONArray = JSONArray(),
        deviceId: String = storedDeviceId()
            ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")
    ): JSONObject {
        require(slot == "VENTAS_1" || slot == "VENTAS_2")
        val body = JSONObject().put("slot", slot).put("salaryCents", salaryCents)
            .put("paymentDay", paymentDay).put("paymentDates", paymentDates)
        return deviceSigned("PATRON_PAYROLL_SETTINGS_SET", "/v1/patron/payroll/settings/set", body.toString(), deviceId)
    }

    fun reportsInbox(
        slot: String,
        deviceId: String = storedDeviceId()
            ?: throw IllegalStateException("SENE PATRÓN todavía no está activado")
    ): JSONObject {
        require(slot == "VENTAS_1" || slot == "VENTAS_2")
        return deviceSigned("PATRON_REPORTS_INBOX", "/v1/patron/reports/inbox",
            JSONObject().put("slot", slot).toString(), deviceId)
    }

    /** Obtiene y verifica criptográficamente los contactos oficiales AYUDA. */
    fun officialSupportContacts(): JSONObject {
        val signed = get("/v1/support/contacts")
        return OfficialSupportVerifier.verifyAndRemember(app, signed)
    }

    private fun get(path: String): JSONObject {
        val connection = (URL(root + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10000
            readTimeout = 15000
            useCaches = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("X-SENE-Version", "1")
        }
        try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) throw SenePatronApiException(status, response)
            return JSONObject(response)
        } finally {
            connection.disconnect()
        }
    }

    private fun saveDevice(result: JSONObject) {
        val id = result.optString("deviceId")
        check(id.isNotBlank()) { "El servidor no devolvió el identificador del dispositivo" }
        check(prefs.edit().putString("device_id", id).commit()) {
            "No se pudo guardar la activación de SENE PATRÓN"
        }
    }

    private fun bootstrapSigned(
        purpose: String, path: String, body: String, identity: PatronIdentitySnapshot
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
        val signature = PatronDeviceIdentity.signChallenge(app, decodeSigningMessage(challenge))
        return post(path, body, challenge.getString("challengeId"), signature)
    }

    private fun deviceSigned(purpose: String, path: String, body: String, deviceId: String): JSONObject {
        require(deviceId.isNotBlank()) { "Falta el identificador del dispositivo" }
        val challengeBody = JSONObject()
            .put("purpose", purpose)
            .put("deviceId", deviceId)
            .put("targetMethod", "POST")
            .put("targetPath", path)
            .put("bodySha256", sha256(body))
        val challenge = post("/v1/challenges", challengeBody.toString())
        val signature = PatronDeviceIdentity.signChallenge(app, decodeSigningMessage(challenge))
        return post(path, body, challenge.getString("challengeId"), signature, deviceId)
    }

    private fun decodeSigningMessage(challenge: JSONObject): ByteArray =
        Base64.decode(challenge.getString("signingMessage"),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    private fun post(
        path: String, body: String, challengeId: String? = null,
        signature: String? = null, deviceId: String? = null
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
            if (status !in 200..299) throw SenePatronApiException(status, response)
            return if (response.isBlank()) JSONObject() else JSONObject(response)
        } finally { connection.disconnect() }
    }

    private fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xFF) }
}
