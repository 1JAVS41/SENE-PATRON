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

    fun requestRegistration(businessName: String, registeredEmail: String, registeredPhone: String): JSONObject {
        val normalizedName = businessName.trim().replace(Regex("\\s+"), " ")
        val email = registeredEmail.trim().lowercase()
        val phone = registeredPhone.filter { it.isDigit() }
        require(normalizedName.isNotBlank() && normalizedName.length <= 100) { "Escribe el nombre de tu empresa (máximo 100 caracteres)" }
        require(android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches()) { "Escribe un correo válido" }
        require(phone.length in 10..15) { "Escribe el número registrado (10 a 15 dígitos)" }
        val identity = PatronDeviceIdentity.get(app)
        // La prueba de identidad también viaja en el cuerpo firmado final.
        // El desafío y la solicitud usan exactamente la misma instantánea.
        val body = JSONObject()
            .put("businessName", normalizedName)
            .put("registeredEmail", email)
            .put("registeredPhone", phone)
            .put("installationId", identity.installationId)
            .put("continuityId", identity.continuityId)
            .put("publicKeyBase64", identity.publicKeyBase64)
            .put("fingerprint", identity.fingerprint)
        val result = bootstrapSigned("PATRON_REGISTRATION_REQUEST", "/v1/patron/registrations/request", body.toString(), identity)
        val requestId = result.optString("requestId")
        if (requestId.isNotBlank()) {
            check(prefs.edit()
                .putString("registration_request_id", requestId)
                .putString("business_name", result.optString("businessName", normalizedName))
                .putLong("registration_expires_at", result.optLong("expiresAt", 0L))
                .putLong("registration_server_time", result.optLong("serverTime", 0L))
                .putLong("registration_server_elapsed", android.os.SystemClock.elapsedRealtime())
                .commit()) { "No se pudo guardar la solicitud de registro" }
        }
        return result
    }

    fun requestPatronRecovery(businessName: String, registeredEmail: String, registeredPhone: String): JSONObject {
        val email = registeredEmail.trim().lowercase()
        val phone = registeredPhone.filter { it.isDigit() }
        require(businessName.isNotBlank() && android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches() && phone.length in 10..15) { "Revisa los datos registrados" }
        val identity = PatronDeviceIdentity.get(app)
        val body = JSONObject()
            .put("businessName", businessName.trim())
            .put("registeredEmail", email)
            .put("registeredPhone", phone)
            .put("installationId", identity.installationId)
            .put("continuityId", identity.continuityId)
            .put("publicKeyBase64", identity.publicKeyBase64)
            .put("fingerprint", identity.fingerprint)
        val result = bootstrapSigned("PATRON_RECOVERY_REQUEST", "/v1/patron/recovery/request", body.toString(), identity)
        val requestId = result.optString("requestId")
        if (requestId.isNotBlank()) {
            check(prefs.edit().putString("patron_recovery_payment_request_id", requestId).commit()) {
                "No se pudo guardar la solicitud de reposición"
            }
        }
        return result
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
            check(prefs.edit().putString("device_id", registeredId).remove("registration_request_id").commit()) {
                "No se pudo guardar la vinculación de SENE PATRÓN"
            }
        }
        return result
    }

    fun storedDeviceId(): String? = prefs.getString("device_id", null)?.takeIf { it.isNotBlank() }

    /** Descarga y verifica la firma digital de los contactos oficiales AYUDA. */
    fun officialSupportContacts(): JSONObject =
        OfficialSupportVerifier.verifyAndRemember(app, get("/v1/support/contacts"))

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
            if (status !in 200..299) throw SeneApiException(status, response)
            return JSONObject(response)
        } finally {
            connection.disconnect()
        }
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
        val registeredId = result.optString("deviceId")
        if (registeredId.isNotBlank()) {
            check(prefs.edit()
                .putString("device_id", registeredId)
                .remove("patron_recovery_payment_request_id")
                .commit()) {
                "No se pudo guardar la recuperación de SENE PATRÓN"
            }
        }
        return result
    }

    /** Recupera la vinculación tras reinstalar en el mismo teléfono físico. */
    fun restorePatron(businessName: String, registeredEmail: String, registeredPhone: String): JSONObject {
        val name = businessName.trim().replace(Regex("\\s+"), " ")
        val email = registeredEmail.trim().lowercase()
        val phone = registeredPhone.filter { it.isDigit() }
        require(name.isNotBlank() && name.length <= 100 &&
            android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches() &&
            phone.length in 10..15) { "Revisa los datos registrados de la empresa" }
        val identity = PatronDeviceIdentity.get(app)
        val body = JSONObject()
            .put("businessName", name)
            .put("registeredEmail", email)
            .put("registeredPhone", phone)
            .put("installationId", identity.installationId)
            .put("continuityId", identity.continuityId)
            .put("publicKeyBase64", identity.publicKeyBase64)
            .put("fingerprint", identity.fingerprint)
        val result = bootstrapSigned("PATRON_RESTORE", "/v1/patron/restore", body.toString(), identity)
        val registeredId = result.optString("deviceId")
        check(registeredId.isNotBlank()) { "El servidor no devolvió la nueva vinculación" }
        check(prefs.edit().putString("device_id", registeredId).commit()) {
            "No se pudo guardar la vinculación recuperada"
        }
        return session().put("restored", true)
    }

    fun createPairingToken(slot: String, operation: String = "NEW", deviceId: String = storedDeviceId()
        ?: throw IllegalStateException("SENE PATRÓN todavía no está vinculado")): JSONObject {
        require(slot == "VENTAS_1" || slot == "VENTAS_2") { "Equipo no válido" }
        require(operation == "NEW" || operation == "REPLACEMENT") { "Operación de vinculación no válida" }
        val body = JSONObject().put("slot", slot).put("operation", operation)
        return deviceSigned("PATRON_PAIRING_TOKEN", "/v1/patron/pairing-tokens", body.toString(), deviceId)
    }

    fun session(deviceId: String = storedDeviceId()
        ?: throw IllegalStateException("SENE PATRÓN todavía no está vinculado")): JSONObject {
        val result = deviceSigned("DEVICE_AUTH", "/v1/device/session", "{}", deviceId)
        check(prefs.edit()
            .putInt("linked_ventas_count", result.optInt("linkedVentasCount", 0).coerceIn(0, 2))
            .putString("license_status", result.optString("licenseStatus"))
            .putString("business_name", result.optString("businessName"))
            .putLong("period_ends_at", result.optLong("periodEndsAt", 0L))
            .putLong("server_time", result.optLong("serverTime", 0L))
            .putLong("server_time_elapsed", android.os.SystemClock.elapsedRealtime())
            .commit()) { "No se pudo guardar el estado de licencia" }
        return result
    }

    fun refreshNotifications(): JSONObject {
        val result = deviceSigned("PATRON_NOTIFICATIONS", "/v1/patron/notifications", "{}")
        val counts = result.optJSONObject("pendingByTeam") ?: JSONObject()
        check(prefs.edit()
            .putInt("notifications_team1", counts.optInt("VENTAS_1", 0))
            .putInt("notifications_team2", counts.optInt("VENTAS_2", 0))
            .putLong("notifications_updated_at", result.optLong("serverTime", 0L))
            .commit()) { "No se pudieron guardar los contadores de notificaciones" }
        return result
    }

    fun requestsInbox(slot: String, all: Boolean = false): JSONObject {
        require(slot == "VENTAS_1" || slot == "VENTAS_2") { "Equipo no válido" }
        val body = JSONObject().put("slot", slot).put("status", if (all) "all" else "pending")
        val result = deviceSigned("PATRON_REQUESTS_INBOX", "/v1/patron/requests/inbox", body.toString())
        val counts = result.optJSONObject("pendingByTeam") ?: JSONObject()
        check(prefs.edit()
            .putInt("notifications_team1", counts.optInt("VENTAS_1", 0))
            .putInt("notifications_team2", counts.optInt("VENTAS_2", 0))
            .putLong("notifications_updated_at", System.currentTimeMillis() / 1000)
            .commit()) { "No se pudieron guardar los contadores de notificaciones" }
        return result
    }

    fun decideRequest(requestId: String, approve: Boolean, decisionDetails: JSONObject = JSONObject()): JSONObject {
        val body = JSONObject()
            .put("requestId", requestId)
            .put("decision", if (approve) "approve" else "reject")
            .put("decisionDetails", decisionDetails)
        return deviceSigned("PATRON_REQUEST_DECISION", "/v1/patron/requests/decision", body.toString())
    }

    fun getPayrollSettings(): JSONObject =
        deviceSigned("PATRON_PAYROLL_SETTINGS_GET", "/v1/patron/payroll/settings/get", "{}")

    fun savePayrollSettings(
        slot: String,
        salaryCents: Long,
        paymentDay: Int?,
        paymentDates: org.json.JSONArray
    ): JSONObject {
        require(slot == "VENTAS_1" || slot == "VENTAS_2") { "Equipo no válido" }
        val body = JSONObject()
            .put("slot", slot)
            .put("salaryCents", salaryCents)
            .put("paymentDay", paymentDay ?: JSONObject.NULL)
            .put("paymentDates", paymentDates)
        return deviceSigned("PATRON_PAYROLL_SETTINGS_SET", "/v1/patron/payroll/settings/set", body.toString())
    }

    fun reportsInbox(slot: String): JSONObject {
        require(slot == "VENTAS_1" || slot == "VENTAS_2") { "Equipo no válido" }
        return deviceSigned("PATRON_REPORTS_INBOX", "/v1/patron/reports/inbox", JSONObject().put("slot", slot).toString())
    }

    fun paydayBundle(paymentDate: String): JSONObject {
        require(paymentDate.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$"))) { "Fecha de pago no válida" }
        val body = JSONObject().put("paymentDate", paymentDate)
        return deviceSigned("PATRON_PAYDAY_BUNDLE", "/v1/patron/payday/bundle", body.toString())
    }

    fun acknowledgePaydayBundle(deliveryId: String): JSONObject {
        require(deliveryId.matches(Regex("(?i)^[0-9a-f-]{36}$"))) { "Identificador de entrega no válido" }
        val body = JSONObject().put("deliveryId", deliveryId)
        return deviceSigned("PATRON_PAYDAY_ACK", "/v1/patron/payday/ack", body.toString())
    }

    fun correctionInbox(slot: String, all: Boolean = false): JSONObject {
        require(slot == "VENTAS_1" || slot == "VENTAS_2") { "Equipo no válido" }
        val body = JSONObject().put("slot", slot).put("status", if (all) "all" else "pending")
        return deviceSigned("PATRON_CORRECTIONS_INBOX", "/v1/patron/corrections/inbox", body.toString())
    }

    fun decideCorrection(requestId: String, approve: Boolean): JSONObject {
        val body = JSONObject().put("requestId", requestId)
            .put("decision", if (approve) "approve" else "reject")
        return deviceSigned("PATRON_CORRECTION_DECISION", "/v1/patron/corrections/decision", body.toString())
    }

    fun requestRenewal(): JSONObject {
        val result = deviceSigned("PATRON_RENEWAL_REQUEST", "/v1/patron/renewals/request", "{}")
        val requestId = result.optString("requestId")
        if (requestId.isNotBlank()) {
            check(prefs.edit().putString("renewal_request_id", requestId).commit())
        }
        return result
    }

    fun redeemRenewal(requestId: String, authorizationCode: String): JSONObject {
        val body = JSONObject().put("requestId", requestId).put("authorizationCode", authorizationCode.trim())
        val result = deviceSigned("PATRON_RENEWAL_REDEEM", "/v1/patron/renewals/redeem", body.toString())
        check(prefs.edit()
            .remove("renewal_request_id")
            .putString("license_status", result.optString("licenseStatus"))
            .putLong("period_ends_at", result.optLong("periodEndsAt", 0L))
            .commit())
        return result
    }


    /**
     * Confirma una entrega después de que la aplicación guardó el lote entero
     * localmente. ackId debe haberse persistido antes del envío para reintentos.
     */
    fun acknowledgeDelivery(
        stream: String,
        deliveryId: String,
        payloadSha256: String,
        cursor: Long,
        ackId: String
    ): JSONObject {
        require(stream.matches(Regex("^[A-Z][A-Z0-9_.-]{1,47}$"))) { "Flujo de entrega no válido" }
        require(deliveryId.matches(Regex("^[A-Za-z0-9._:-]{1,120}$"))) { "Identificador de entrega no válido" }
        require(payloadSha256.matches(Regex("(?i)^[a-f0-9]{64}$"))) { "Huella de entrega no válida" }
        require(cursor >= 0L) { "Cursor de entrega no válido" }
        require(ackId.matches(Regex("(?i)^[0-9a-f-]{36}$"))) { "El ACK necesita un UUID persistido" }
        val deviceId = storedDeviceId()
            ?: throw IllegalStateException("SENE PATRÓN todavía no está vinculado")
        val body = JSONObject()
            .put("stream", stream)
            .put("deliveryId", deliveryId)
            .put("payloadSha256", payloadSha256.lowercase())
            .put("cursor", cursor)
            .put("ackId", ackId.lowercase())
            .put("recipientDeviceId", deviceId)
        return deviceSigned("DELIVERY_ACK", "/v1/deliveries/ack", body.toString(), deviceId)
    }


    /**
     * Persiste un identificador estable de ACK antes de enviarlo. Puede
     * llamarse únicamente después de que el llamador haya guardado el lote.
     */
    private fun canonicalJson(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") {
            JSONObject.quote(it) + ":" + canonicalJson(value.get(it))
        }
        is org.json.JSONArray -> (0 until value.length()).joinToString(",", "[", "]") {
            canonicalJson(value.get(it))
        }
        is String -> JSONObject.quote(value)
        is Number, is Boolean -> value.toString()
        else -> JSONObject.quote(value.toString())
    }

    fun acknowledgePersistedDelivery(stream: String, payload: JSONObject): JSONObject {
        val stablePayload = JSONObject(payload.toString()).apply { remove("serverTime") }
        val payloadHash = sha256(canonicalJson(stablePayload))
        val deliveryId = "$stream:${payloadHash.take(48)}"
        val cursor = payload.optLong("cursor", 0L).coerceAtLeast(0L)
        val key = "delivery_ack_${stream}_${payloadHash}"
        val ackId = prefs.getString(key, null) ?: java.util.UUID.randomUUID().toString().also {
            check(prefs.edit().putString(key, it).commit()) {
                "No se pudo guardar el identificador de ACK para reintentar"
            }
        }
        val result = acknowledgeDelivery(stream, deliveryId, payloadHash, cursor, ackId)
        check(result.optBoolean("acknowledged", false)) { "El servidor no confirmó el ACK de la entrega" }
        check(prefs.edit().remove(key).commit()) {
            "El servidor confirmó el ACK, pero no se pudo cerrar el recibo local"
        }
        return result
    }

    fun requestReplacement(deviceId: String, reason: String): JSONObject {
        val body = JSONObject().put("deviceId", deviceId).put("reason", reason.trim())
        return deviceSigned("PATRON_REPLACEMENT_REQUEST", "/v1/patron/devices/replacement-request", body.toString())
    }

    private fun deviceSigned(purpose: String, path: String, body: String): JSONObject {
        val deviceId = storedDeviceId()
            ?: throw IllegalStateException("SENE PATRÓN todavía no está vinculado")
        return deviceSigned(purpose, path, body, deviceId)
    }

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
