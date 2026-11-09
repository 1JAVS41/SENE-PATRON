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

/** Clave privada P-256 no exportable: la firma se realiza dentro de Android Keystore. */
object PatronDeviceIdentity {
    private const val KEY_ALIAS = "SENE_PATRON_DEVICE_IDENTITY_V1"
    private const val PREFS = "sene_patron_identity"
    private const val ID_KEY = "installation_id"

    @Synchronized
    fun get(context: Context): PatronIdentitySnapshot {
        val app = context.applicationContext
        val pair = loadOrCreate(app)
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        var id = prefs.getString(ID_KEY, null)
        if (id.isNullOrBlank()) {
            id = UUID.randomUUID().toString()
            check(prefs.edit().putString(ID_KEY, id).commit()) {
                "No se pudo guardar la identidad de SENE PATRÓN"
            }
        }
        val androidId = Settings.Secure.getString(app.contentResolver, Settings.Secure.ANDROID_ID).orEmpty()
        check(androidId.isNotBlank() && !androidId.equals("9774d56d682e549c", true)) {
            "Android no proporcionó un identificador estable para este dispositivo"
        }
        val continuity = sha256Hex((app.packageName + "|" + androidId).toByteArray(Charsets.UTF_8))
        val public = pair.public.encoded
        return PatronIdentitySnapshot(
            installationId = id,
            continuityId = continuity,
            publicKeyBase64 = Base64.encodeToString(public, Base64.NO_WRAP),
            fingerprint = sha256Hex(public)
        )
    }

    @Synchronized
    fun signChallenge(context: Context, challenge: ByteArray): String {
        require(challenge.size in 16..4096) { "Reto de seguridad no válido" }
        get(context.applicationContext)
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val privateKey = store.getKey(KEY_ALIAS, null) as? java.security.PrivateKey
            ?: throw IllegalStateException("No se encontró la clave protegida de SENE PATRÓN")
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(privateKey)
        signer.update(challenge)
        return Base64.encodeToString(signer.sign(), Base64.NO_WRAP)
    }

    fun verifyChallenge(snapshot: PatronIdentitySnapshot, challenge: ByteArray, signatureBase64: String): Boolean {
        return try {
            if (challenge.size !in 16..4096 || signatureBase64.isBlank()) {
                false
            } else {
                val encoded = Base64.decode(snapshot.publicKeyBase64, Base64.NO_WRAP)
                if (!sha256Hex(encoded).equals(snapshot.fingerprint, true)) {
                    false
                } else {
                    val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(encoded))
                    Signature.getInstance("SHA256withECDSA").run {
                        initVerify(publicKey)
                        update(challenge)
                        verify(Base64.decode(signatureBase64, Base64.NO_WRAP))
                    }
                }
            }
        } catch (_: Exception) { false }
    }

    private fun loadOrCreate(context: Context): KeyPair {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val publicKey = store.getCertificate(KEY_ALIAS)?.publicKey
        val privateKey = store.getKey(KEY_ALIAS, null) as? java.security.PrivateKey
        if (publicKey != null && privateKey != null) return KeyPair(publicKey, privateKey)
        if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS)
        check(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(ID_KEY).commit()) {
            "No se pudo renovar la identidad local"
        }
        return KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
                )
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setUserAuthenticationRequired(false)
                    .build()
            )
        }.generateKeyPair()
    }

    private fun sha256Hex(value: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(value)
            .joinToString("") { "%02X".format(it.toInt() and 0xFF) }
}
