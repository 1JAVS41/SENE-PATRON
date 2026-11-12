package com.sene.patron

import android.content.Context
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.UUID

data class PatronIdentitySnapshot(
    val installationId: String,
    val continuityId: String,
    val publicKeyBase64: String,
    val fingerprint: String
)

/** Identidad P-256 propia de SENE PATRÓN; la clave privada nunca sale de Android Keystore. */
object PatronDeviceIdentity {
    private const val KEY_ALIAS = "SENE_PATRON_DEVICE_IDENTITY_V1"
    private const val PREFS = "sene_patron_device_identity"
    private const val ID_KEY = "installation_id"

    @Synchronized
    fun get(context: Context): PatronIdentitySnapshot {
        val app = context.applicationContext
        val androidId = Settings.Secure.getString(app.contentResolver, Settings.Secure.ANDROID_ID).orEmpty()
        check(androidId.isNotBlank() && !androidId.equals("9774d56d682e549c", true)) {
            "Android no proporcionó un identificador estable"
        }
        // ANDROID_ID permite conservar la identidad lógica al reinstalar la APK
        // en el mismo teléfono; la clave privada P-256 se mantiene protegida en Keystore.
        val stableSeed = (app.packageName + "|" + androidId).toByteArray(Charsets.UTF_8)
        val installationId = UUID.nameUUIDFromBytes(stableSeed).toString()
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        check(prefs.edit().putString(ID_KEY, installationId).commit()) {
            "No se pudo guardar el identificador de instalación"
        }
        val pair = loadOrCreate(app)
        val continuity = digestHex(stableSeed)
        val publicBytes = pair.public.encoded
        return PatronIdentitySnapshot(
            installationId = installationId,
            continuityId = continuity,
            publicKeyBase64 = Base64.encodeToString(publicBytes, Base64.NO_WRAP),
            fingerprint = digestHex(publicBytes)
        )
    }

    @Synchronized
    fun signChallenge(context: Context, message: ByteArray): String {
        require(message.size in 16..4096) { "Mensaje de firma inválido" }
        get(context.applicationContext)
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val privateKey = keyStore.getKey(KEY_ALIAS, null) as? java.security.PrivateKey
            ?: throw IllegalStateException("No se encontró la clave privada del equipo")
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(privateKey)
        signer.update(message)
        return Base64.encodeToString(signer.sign(), Base64.NO_WRAP)
    }

    fun verifyChallenge(snapshot: PatronIdentitySnapshot, message: ByteArray, signatureBase64: String): Boolean {
        if (message.size !in 16..4096 || signatureBase64.isBlank()) return false
        return try {
            val publicBytes = Base64.decode(snapshot.publicKeyBase64, Base64.NO_WRAP)
            if (!digestHex(publicBytes).equals(snapshot.fingerprint, true)) return false
            val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(publicBytes))
            Signature.getInstance("SHA256withECDSA").run {
                initVerify(publicKey)
                update(message)
                verify(Base64.decode(signatureBase64, Base64.NO_WRAP))
            }
        } catch (_: Exception) { false }
    }

    private fun loadOrCreate(context: Context): KeyPair {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val publicKey = store.getCertificate(KEY_ALIAS)?.publicKey
        val privateKey = store.getKey(KEY_ALIAS, null) as? java.security.PrivateKey
        if (publicKey != null && privateKey != null) return KeyPair(publicKey, privateKey)
        if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS)
        // El installationId lógico ya se deriva de ANDROID_ID en get().
        // Renovar la clave no debe borrar ni cambiar esa identidad estable.
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        generator.initialize(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build()
        )
        return generator.generateKeyPair()
    }

    private fun digestHex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") {
            "%02X".format(it.toInt() and 0xFF)
        }
}
