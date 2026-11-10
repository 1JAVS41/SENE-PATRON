package com.sene.patron

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.view.inputmethod.InputMethodManager
import android.content.Context.INPUT_METHOD_SERVICE
import android.widget.EditText
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.MessageDigest
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * Activación local de SENE PATRÓN.
 * La contraseña no se guarda: se valida mediante PBKDF2 y solo se conserva
 * la autorización ligada al identificador Android de este dispositivo.
 */
object Protection {
    private const val PREFS = "sene_patron_access"
    private const val ROUNDS = 310000
    private const val SALT_B64 = "HdH3dF+B/pxZDymDkL208g=="
    private const val HASH_B64 = "Ru33WCl+r5Bq8IJKJLVD7vUDxqN9Kmf1KWFfl8MK2MA="
    private const val KEY_ALIAS = "sene_patron_device_binding_v1"
    private const val KEY_CHALLENGE = "SENE-PATRON-DEVICE-BINDING-v1"

    private fun deviceId(context: Context): String =
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID).orEmpty()

    fun requireActivation(activity: Activity, onAuthorized: () -> Unit) {
        if (isAuthorized(activity)) {
            onAuthorized()
            return
        }

        val field = EditText(activity).apply {
            hint = "Contraseña de acceso"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            setSingleLine(true)
            setPadding(
                (18 * resources.displayMetrics.density).toInt(),
                (14 * resources.displayMetrics.density).toInt(),
                (18 * resources.displayMetrics.density).toInt(),
                (14 * resources.displayMetrics.density).toInt()
            )
        }

        val dialog = AlertDialog.Builder(activity)
            .setTitle("SENE PATRÓN · Acceso")
            .setMessage("Introduce la contraseña para activar el acceso en este dispositivo.")
            .setView(field)
            .setCancelable(false)
            .setPositiveButton("ENTRAR", null)
            .create()

        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val entered = field.text?.toString().orEmpty()
                val id = deviceId(activity)
                if (verifyPassword(entered) && id.isNotBlank()) {
                    activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                        .putBoolean("authorized", true)
                        .putString("device_id", id)
                        .apply()
                    (activity.getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)
                        ?.hideSoftInputFromWindow(field.windowToken, 0)
                    dialog.dismiss()
                    onAuthorized()
                } else {
                    field.text?.clear()
                    field.error = if (id.isBlank()) "No se pudo identificar este dispositivo"
                        else "Contraseña incorrecta"
                }
            }
        }
        dialog.show()
    }

    private fun verifyDeviceKey(): Boolean {
        return try {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val privateKey = ks.getKey(KEY_ALIAS, null) as? PrivateKey ?: return false
            val publicKey = ks.getCertificate(KEY_ALIAS)?.publicKey ?: return false
            val signer = Signature.getInstance("SHA256withRSA")
            signer.initSign(privateKey)
            signer.update(KEY_CHALLENGE.toByteArray(Charsets.UTF_8))
            val signed = signer.sign()
            val verifier = Signature.getInstance("SHA256withRSA")
            verifier.initVerify(publicKey)
            verifier.update(KEY_CHALLENGE.toByteArray(Charsets.UTF_8))
            verifier.verify(signed)
        } catch (_: Exception) { false }
    }

    private fun verifyPassword(value: String): Boolean {
        if (value.isEmpty()) return false
        return try {
            val spec = PBEKeySpec(
                value.toCharArray(),
                Base64.decode(SALT_B64, Base64.DEFAULT),
                ROUNDS,
                256
            )
            val actual = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
                .generateSecret(spec).encoded
            spec.clearPassword()
            MessageDigest.isEqual(actual, Base64.decode(HASH_B64, Base64.DEFAULT))
        } catch (_: Exception) {
            false
        }
    }

    private fun isAuthorized(context: Context): Boolean {
        val id = deviceId(context)
        if (id.isBlank()) return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean("authorized", false) || prefs.getString("device_id", null) != id) return false
        // Blindaje automático con Android Keystore; si la clave falta o se invalida,
        // se regenera sin pedir acciones al patrón ni bloquear el acceso.
        if (!verifyDeviceKey()) {
            val ready = try {
                val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
                if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS)
                val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore")
                generator.initialize(KeyGenParameterSpec.Builder(
                    KEY_ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
                ).setDigests(KeyProperties.DIGEST_SHA256).setKeySize(2048).build())
                generator.generateKeyPair()
                verifyDeviceKey()
            } catch (_: Exception) { false }
            prefs.edit().putBoolean("device_key_ready", ready).apply()
        } else if (!prefs.getBoolean("device_key_ready", false)) {
            prefs.edit().putBoolean("device_key_ready", true).apply()
        }
        return true
    }
}
