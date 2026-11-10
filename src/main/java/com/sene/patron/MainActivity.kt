package com.sene.patron

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Bitmap
import android.graphics.Bitmap.Config
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.graphics.RectF
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.animation.ValueAnimator
import android.view.animation.LinearInterpolator
import android.widget.EditText
import android.widget.CheckBox
import android.widget.Toast
import android.widget.FrameLayout
import android.widget.ImageView
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject

class MainActivity : Activity() {
    private val bg = Color.rgb(244, 245, 250)
    private val ink = Color.rgb(23, 33, 61)
    private val muted = Color.rgb(111, 121, 145)
    private val red = Color.rgb(190, 35, 48)
    private val accent = Color.rgb(255, 181, 71)
    private val success = Color.rgb(22, 139, 69)
    private val white = Color.WHITE
    private var currentPage = "home"
    @Volatile private var lastNotificationRefreshAt = 0L
    private var refreshingNotifications = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = bg
        window.navigationBarColor = bg
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }
        Protection.requireActivation(this) { render() }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        when {
            currentPage == "home" -> super.onBackPressed()
            currentPage == "menu" -> { currentPage = "home"; render() }
            currentPage == "team1" || currentPage == "team2" -> { currentPage = "home"; render() }
            currentPage.startsWith("team1_") -> { currentPage = "team1"; render() }
            currentPage.startsWith("team2_") -> { currentPage = "team2"; render() }
            else -> { currentPage = "menu"; render() }
        }
    }

    private fun render() {
        val scroll = ScrollView(this).apply {
            setBackgroundColor(bg)
            isFillViewport = true
            isSmoothScrollingEnabled = true
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_ALWAYS
            clipToPadding = false
        }
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(30), dp(18), dp(88))
        }
        scroll.addView(page)
        val licenseStatus = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
            .getString("license_status", "").orEmpty()
        if (isLicenseExpired()) {
            expiredScreen(page)
        } else {
            when (currentPage) {
                "home" -> homeScreen(page)
                "menu" -> menuScreen(page)
                "team1", "team2" -> teamScreen(page, currentPage)
                else -> detailScreen(page, currentPage)
            }
        }
        setContentView(scroll)
        scroll.post { scroll.scrollTo(0, 0) }
        refreshNotificationsFromServer()
    }

    private fun isLicenseExpired(): Boolean {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        if (prefs.getString("license_status", "") in setOf("expired", "suspended")) return true
        val expiry = prefs.getLong("period_ends_at", 0L)
        val serverTime = prefs.getLong("server_time", 0L)
        val elapsedAnchor = prefs.getLong("server_time_elapsed", 0L)
        if (expiry <= 0L || serverTime <= 0L || elapsedAnchor <= 0L) return false
        val elapsedNow = SystemClock.elapsedRealtime()
        if (elapsedNow < elapsedAnchor) return true
        val estimatedServerNow = serverTime + (elapsedNow - elapsedAnchor) / 1000L
        return estimatedServerNow >= expiry
    }

    private fun expiredScreen(root: LinearLayout) {
        header(root, "Validación de licencia")
        root.addView(info("RENOVACIÓN NECESARIA",
            "La licencia puede haber vencido, estar suspendida o necesitar validarse con el servidor. Las funciones administrativas quedan bloqueadas hasta confirmar su vigencia. SENE VENTAS conserva sus operaciones locales y sus datos."))
        gap(root, 14)
        root.addView(primaryButton("PAGAR MENSUALIDAD · $80 MXN") { showRenewalDialog() })
        val requestId = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
            .getString("renewal_request_id", null)
        if (!requestId.isNullOrBlank()) {
            gap(root, 8)
            root.addView(primaryButton("INTRODUCIR CÓDIGO DE RENOVACIÓN") {
                showRenewalCodeDialog(requestId)
            })
        }
        gap(root, 10)
        root.addView(primaryButton("¿NECESITAS AYUDA?") { showContactDialog() })
    }

    private fun homeScreen(root: LinearLayout) {
        header(root, "Inicio")
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val linked = !prefs.getString("device_id", null).isNullOrBlank()
        val registrationRequest = prefs.getString("registration_request_id", null)

        root.addView(primaryButton("VINCULAR SENE PATRÓN") {
            when {
                linked -> showOwnerOptions()
                !registrationRequest.isNullOrBlank() -> showActivationDialog()
                else -> showRegistrationDialog()
            }
        })
        gap(root, 12)
        root.addView(primaryButton("EQUIPO-1") {
            currentPage = "team1"
            render()
        })
        gap(root, 12)
        root.addView(primaryButton("EQUIPO-2") {
            currentPage = "team2"
            render()
        })
        gap(root, 12)
        root.addView(primaryButton("PAGAR MENSUALIDAD") {
            if (linked) showRenewalDialog()
            else Toast.makeText(this, "Primero debes vincular SENE PATRÓN", Toast.LENGTH_LONG).show()
        })
        gap(root, 12)
        root.addView(primaryButton("AYUDA") { showContactDialog() })
        if (!prefs.getString("patron_recovery_payment_request_id", null).isNullOrBlank()) {
            gap(root, 10)
            root.addView(primaryButton("INTRODUCIR CÓDIGO DE REPOSICIÓN") {
                showPatronRecoveryCodeDialog()
            })
        }
    }

    private fun showOwnerOptions() {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val options = mutableListOf("Actualizar avisos", "Pagar mensualidad · $80 MXN", "Configurar conexión")
        val renewalId = prefs.getString("renewal_request_id", null)
        if (!renewalId.isNullOrBlank()) options.add("Introducir código de renovación")
        AlertDialog.Builder(this)
            .setTitle("CONEXIÓN Y PAGOS")
            .setItems(options.toTypedArray()) { _, which ->
                when (options[which]) {
                    "Actualizar avisos" -> refreshNotificationsFromServer(force = true)
                    "Pagar mensualidad · $80 MXN" -> showRenewalDialog()
                    "Configurar conexión" -> showServerConfig()
                    "Introducir código de renovación" -> renewalId?.let { showRenewalCodeDialog(it) }
                }
            }
            .setNegativeButton("CERRAR", null)
            .show()
    }

    private fun renderPayrollSettings(root: LinearLayout, team: String) {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val raw = prefs.getString("payroll_settings_$team", null)
        if (raw.isNullOrBlank()) {
            root.addView(info("CONFIGURACIÓN DE NÓMINA", "Consultando sueldo y fechas de pago…"))
            return
        }
        try {
            val payload = JSONObject(raw)
            val settings = payload.optJSONObject("settings") ?: JSONObject()
            val key = if (team == "team1") "VENTAS_1" else "VENTAS_2"
            val item = settings.optJSONObject(key)
            if (item == null) {
                root.addView(info("SUELDO SIN CONFIGURAR", "Define el sueldo base y al menos un día fijo mensual o una fecha específica."))
                return
            }
            val salary = item.optLong("salaryCents", 0L) / 100.0
            val day = item.optInt("paymentDay", 0)
            val dates = item.optJSONArray("paymentDates") ?: org.json.JSONArray()
            val dateText = buildString {
                if (day > 0) append("Día fijo de cada mes: ").append(day)
                if (dates.length() > 0) {
                    if (isNotEmpty()) append("\n")
                    append("Fechas específicas: ")
                    for (i in 0 until dates.length()) {
                        if (i > 0) append(", ")
                        append(dates.optString(i))
                    }
                }
            }
            root.addView(info("SUELDO BASE", "$" + String.format(java.util.Locale.US, "%.2f MXN", salary)))
            root.addView(info("FECHAS DE PAGO", dateText))
        } catch (_: Exception) {
            root.addView(info("CONFIGURACIÓN NO DISPONIBLE", "No se pudo leer la configuración de nómina."))
        }
    }

    private fun refreshPayrollSettings(team: String, force: Boolean = false) {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)?.takeIf { it.isNotBlank() } ?: return
        if (prefs.getString("device_id", null).isNullOrBlank()) return
        val now = System.currentTimeMillis()
        val last = prefs.getLong("payroll_settings_updated_$team", 0L)
        if (!force && (now - last < 3_600_000L || prefs.getBoolean("payroll_settings_refreshing_$team", false))) return
        prefs.edit().putBoolean("payroll_settings_refreshing_$team", true).apply()
        Thread {
            try {
                val result = SeneApiClient(this, baseUrl).getPayrollSettings()
                prefs.edit().putString("payroll_settings_$team", result.toString())
                    .putLong("payroll_settings_updated_$team", System.currentTimeMillis())
                    .putBoolean("payroll_settings_refreshing_$team", false).apply()
                runOnUiThread { if (!isFinishing && currentPage == "${team}_payroll") render() }
            } catch (error: Exception) {
                prefs.edit().putBoolean("payroll_settings_refreshing_$team", false).apply()
                runOnUiThread {
                    if (!isFinishing) Toast.makeText(this, "No se pudo consultar nómina: " + (error.message ?: ""), Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    private fun showPayrollSettingsDialog(team: String) {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(8), dp(18), dp(8))
        }
        val salary = EditText(this).apply {
            hint = "Sueldo base por periodo en pesos"
            inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL
        }
        val day = EditText(this).apply {
            hint = "Día fijo mensual (1 a 31), opcional"
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
        }
        val dates = EditText(this).apply {
            hint = "Fechas específicas YYYY-MM-DD separadas por coma"
            minLines = 2
            maxLines = 3
        }
        content.addView(salary)
        content.addView(day)
        content.addView(dates)
        AlertDialog.Builder(this)
            .setTitle("NÓMINA · ${if (team == "team1") "EQUIPO 1" else "EQUIPO 2"}")
            .setMessage("Elige un día fijo mensual, fechas específicas o ambos. El servidor solo aceptará el reporte de nómina en una fecha configurada.")
            .setView(content)
            .setPositiveButton("GUARDAR") { _, _ ->
                val salaryValue = salary.text.toString().trim().replace(",", ".").toDoubleOrNull()
                val dayValue = day.text.toString().trim().takeIf { it.isNotBlank() }?.toIntOrNull()
                val dateValues = dates.text.toString().split(',', '\n').map { it.trim() }.filter { it.isNotBlank() }
                if (salaryValue == null || salaryValue <= 0 || salaryValue > 10_000_000 ||
                    (day.text.isNotBlank() && (dayValue == null || dayValue !in 1..31)) ||
                    (dayValue == null && dateValues.isEmpty()) ||
                    dateValues.any { !it.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$")) }) {
                    Toast.makeText(this, "Revisa sueldo y fechas. Usa YYYY-MM-DD.", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                val dateArray = org.json.JSONArray()
                dateValues.distinct().forEach { dateArray.put(it) }
                val slot = if (team == "team1") "VENTAS_1" else "VENTAS_2"
                val baseUrl = getSharedPreferences("sene_patron_server", MODE_PRIVATE).getString("server_base_url", null)
                if (baseUrl.isNullOrBlank()) { showServerConfig(); return@setPositiveButton }
                Thread {
                    try {
                        val result = SeneApiClient(this, baseUrl).savePayrollSettings(
                            slot, Math.round(salaryValue * 100.0), dayValue, dateArray
                        )
                        getSharedPreferences("sene_patron_server", MODE_PRIVATE).edit()
                            .remove("payroll_settings_$team")
                            .putLong("payroll_settings_updated_$team", 0L).apply()
                        runOnUiThread {
                            Toast.makeText(this, "Sueldo y fechas guardados para este equipo", Toast.LENGTH_LONG).show()
                            refreshPayrollSettings(team, force = true)
                            render()
                        }
                    } catch (error: Exception) {
                        runOnUiThread {
                            Toast.makeText(this, "No se pudo guardar nómina: " + (error.message ?: ""), Toast.LENGTH_LONG).show()
                        }
                    }
                }.start()
            }
            .setNegativeButton("CANCELAR", null)
            .show()
    }

    private fun renderTeamReports(root: LinearLayout, team: String) {
        val raw = getSharedPreferences("sene_patron_server", MODE_PRIVATE).getString("reports_$team", null)
        if (raw.isNullOrBlank()) {
            root.addView(info("REPORTES DEL EQUIPO", "Consultando reportes de cierres de turno y días de pago…"))
            return
        }
        try {
            val payload = JSONObject(raw)
            val shifts = payload.optJSONArray("shiftReports") ?: org.json.JSONArray()
            val payroll = payload.optJSONArray("payrollReports") ?: org.json.JSONArray()
            root.addView(kicker("CIERRES DE TURNO"))
            if (shifts.length() == 0) root.addView(info("SIN CIERRES", "Este equipo todavía no ha enviado reportes de cierre de turno."))
            for (i in 0 until shifts.length()) {
                val report = shifts.getJSONObject(i)
                val card = card()
                card.addView(text("Cierre · " + report.optString("shiftKey"), 15, ink, true))
                card.addView(text((report.optJSONObject("report") ?: JSONObject()).toString(2), 12, muted))
                root.addView(card)
                if (i != shifts.length() - 1) gap(root, 7)
            }
            gap(root, 12)
            root.addView(kicker("DÍAS DE PAGO"))
            if (payroll.length() == 0) root.addView(info("SIN REPORTES DE NÓMINA", "Este equipo todavía no ha enviado un reporte de día de pago."))
            for (i in 0 until payroll.length()) {
                val payrollItem = payroll.getJSONObject(i)
                val payrollData = payrollItem.optJSONObject("report") ?: JSONObject()
                val settingsRaw = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
                    .getString("payroll_settings_$team", null)
                var salaryCents = 0L
                if (!settingsRaw.isNullOrBlank()) {
                    val settingsPayload = JSONObject(settingsRaw).optJSONObject("settings") ?: JSONObject()
                    val settingKey = if (team == "team1") "VENTAS_1" else "VENTAS_2"
                    salaryCents = settingsPayload.optJSONObject(settingKey)?.optLong("salaryCents", 0L) ?: 0L
                }
                // Solo el servidor entrega las decisiones verificadas de D1. El arreglo
                // "requests" dentro del reporte enviado por VENTAS es informativo y no confiable.
                val verifiedRequests = if (i == 0) {
                    payload.optJSONArray("payrollEntries") ?: org.json.JSONArray()
                } else org.json.JSONArray()
                var authorizedDeductions = 0L
                var approvedCount = 0
                for (requestIndex in 0 until verifiedRequests.length()) {
                    val request = verifiedRequests.optJSONObject(requestIndex) ?: continue
                    if (request.optString("status") != "approved") continue
                    approvedCount++
                    val deduction = request.optJSONObject("decisionDetails")?.optJSONObject("deduction")
                    if (deduction?.optBoolean("authorized", false) == true) {
                        authorizedDeductions += deduction.optLong("amountCents", 0L).coerceAtLeast(0L)
                    }
                }
                val netCents = (salaryCents - authorizedDeductions).coerceAtLeast(0L)
                val payrollCard = card()
                payrollCard.addView(text("Nómina · " + payrollItem.optString("periodKey"), 15, ink, true))
                payrollCard.addView(text("Trabajador: " + payrollData.optString("worker", "Sin nombre"), 12, muted))
                if (i == 0) {
                    payrollCard.addView(text("Solicitudes verificadas: ${verifiedRequests.length()} · Aprobadas: $approvedCount", 12, muted))
                    if (salaryCents > 0L) {
                        payrollCard.addView(text("Sueldo base del periodo: " + String.format(java.util.Locale.US, "$%.2f MXN", salaryCents / 100.0), 13, ink, true))
                        payrollCard.addView(text("Descuentos autorizados: " + String.format(java.util.Locale.US, "$%.2f MXN", authorizedDeductions / 100.0), 13, muted))
                        payrollCard.addView(text("Pago estimado preliminar: " + String.format(java.util.Locale.US, "$%.2f MXN", netCents / 100.0), 16, success, true))
                    } else {
                        payrollCard.addView(text("Configura el sueldo base para calcular el pago estimado.", 12, red, true))
                    }
                    payrollCard.addView(text("Detalle basado en decisiones verificadas por SENE PATRÓN: " + verifiedRequests.toString(), 11, muted))
                } else {
                    payrollCard.addView(text("Reporte histórico. El detalle de decisiones verificadas se consulta en el reporte más reciente.", 12, muted))
                }
                root.addView(payrollCard)
                if (i != payroll.length() - 1) gap(root, 7)
            }
        } catch (_: Exception) {
            root.addView(info("NO SE PUDIERON LEER REPORTES", "Actualiza la conexión e inténtalo de nuevo."))
        }
    }

    private fun refreshTeamReports(team: String, force: Boolean = false) {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)?.takeIf { it.isNotBlank() } ?: return
        if (prefs.getString("device_id", null).isNullOrBlank()) return
        val now = System.currentTimeMillis()
        val last = prefs.getLong("reports_updated_$team", 0L)
        if (!force && (now - last < 3_600_000L || prefs.getBoolean("reports_refreshing_$team", false))) return
        prefs.edit().putBoolean("reports_refreshing_$team", true).apply()
        Thread {
            try {
                val slot = if (team == "team1") "VENTAS_1" else "VENTAS_2"
                val result = SeneApiClient(this, baseUrl).reportsInbox(slot)
                prefs.edit().putString("reports_$team", result.toString())
                    .putLong("reports_updated_$team", System.currentTimeMillis())
                    .putBoolean("reports_refreshing_$team", false).apply()
                runOnUiThread { if (!isFinishing && currentPage == "${team}_schedule") render() }
            } catch (error: Exception) {
                prefs.edit().putBoolean("reports_refreshing_$team", false).apply()
                runOnUiThread {
                    if (!isFinishing) Toast.makeText(this, "No se pudieron consultar reportes: " + (error.message ?: ""), Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    private fun renderRequestsInbox(root: LinearLayout, team: String) {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val raw = prefs.getString("requests_$team", null)
        if (raw.isNullOrBlank()) {
            root.addView(info("BANDEJA DE SOLICITUDES", "Consultando solicitudes pendientes de este equipo…"))
            return
        }
        try {
            val payload = JSONObject(raw)
            val items = payload.optJSONArray("items") ?: org.json.JSONArray()
            if (items.length() == 0) {
                root.addView(info("SIN SOLICITUDES", "No hay solicitudes registradas para este equipo."))
                return
            }
            for (index in 0 until items.length()) {
                val item = items.getJSONObject(index)
                val requestId = item.optString("requestId")
                val type = item.optString("type", "Solicitud")
                val details = item.optJSONObject("details") ?: JSONObject()
                val status = item.optString("status", "pending")
                val requestCard = card()
                requestCard.addView(kicker(type.replace('_', ' ')))
                requestCard.addView(text(details.toString(2), 13, ink))
                requestCard.addView(text("Estado: $status", 11, muted))
                if (status == "pending") {
                    gap(requestCard, 7)
                    val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
                    val approve = primaryButton("APROBAR") { showTeamRequestApproval(team, requestId) }
                    val reject = primaryButton("RECHAZAR") {
                        AlertDialog.Builder(this)
                            .setTitle("Rechazar solicitud")
                            .setMessage("¿Confirmas que deseas rechazar esta solicitud?")
                            .setPositiveButton("RECHAZAR") { _, _ -> decideTeamRequest(team, requestId, false) }
                            .setNegativeButton("CANCELAR", null)
                            .show()
                    }
                    actions.addView(approve, LinearLayout.LayoutParams(0, dp(46), 1f).apply { marginEnd = dp(6) })
                    actions.addView(reject, LinearLayout.LayoutParams(0, dp(46), 1f).apply { marginStart = dp(6) })
                    requestCard.addView(actions)
                }
                root.addView(requestCard)
                if (index != items.length() - 1) gap(root, 8)
            }
        } catch (_: Exception) {
            root.addView(info("NO SE PUDO LEER LA BANDEJA", "Actualiza la conexión e inténtalo de nuevo."))
        }
    }


    private fun renderCorrectionInbox(root: LinearLayout, team: String) {
        val raw = getSharedPreferences("sene_patron_server", MODE_PRIVATE).getString("requests_$team", null)
        root.addView(kicker("CORRECCIONES DE VENTA"))
        if (raw.isNullOrBlank()) {
            root.addView(info("CORRECCIONES", "Consultando solicitudes de corrección…"))
            return
        }
        try {
            val payload = JSONObject(raw)
            val items = payload.optJSONArray("corrections") ?: org.json.JSONArray()
            if (items.length() == 0) {
                root.addView(info("SIN CORRECCIONES", "No hay solicitudes de corrección de venta para este equipo."))
                return
            }
            for (index in 0 until items.length()) {
                val item = items.getJSONObject(index)
                val requestId = item.optString("requestId")
                val status = item.optString("status", "pending")
                val correction = card()
                correction.addView(text("Venta: " + item.optString("saleId"), 15, ink, true))
                correction.addView(text("Motivo: " + item.optString("reason"), 13, muted))
                correction.addView(text("Estado: $status", 11, muted))
                if (status == "pending") {
                    gap(correction, 7)
                    correction.addView(primaryButton("AUTORIZAR UNA CORRECCIÓN") {
                        AlertDialog.Builder(this)
                            .setTitle("Autorizar corrección")
                            .setMessage("Revisa el motivo de la solicitud que aparece en esta tarjeta (por ejemplo: devolución, ajuste de precio, eliminación de producto o corrección de cantidad). Con esa información puedes decidir directamente desde SENE PATRÓN si autorizas o rechazas la corrección. Si autorizas, el trabajador podrá corregir esa venta una sola vez. El detalle comercial de la operación y los cambios de caja e inventario permanecen en SENE VENTAS; el servidor solo conserva el motivo, el estado y los identificadores necesarios para controlar el permiso.")
                            .setPositiveButton("AUTORIZAR") { _, _ -> decideTeamCorrection(team, requestId, true) }
                            .setNegativeButton("RECHAZAR") { _, _ -> decideTeamCorrection(team, requestId, false) }
                            .setNeutralButton("CANCELAR", null)
                            .show()
                    })
                }
                root.addView(correction)
                if (index != items.length() - 1) gap(root, 8)
            }
        } catch (_: Exception) {
            root.addView(info("NO SE PUDO LEER CORRECCIONES", "Actualiza la conexión e inténtalo de nuevo."))
        }
    }

    private fun decideTeamCorrection(team: String, requestId: String, approve: Boolean) {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)?.takeIf { it.isNotBlank() } ?: return
        Thread {
            try {
                SeneApiClient(this, baseUrl).decideCorrection(requestId, approve)
                prefs.edit().remove("requests_$team").putLong("requests_updated_$team", 0L).apply()
                refreshTeamRequests(team, force = true)
                runOnUiThread {
                    Toast.makeText(this, if (approve) "Permiso de un uso autorizado" else "Corrección rechazada", Toast.LENGTH_SHORT).show()
                    if (!isFinishing) render()
                }
            } catch (error: Exception) {
                runOnUiThread {
                    Toast.makeText(this, "No se pudo guardar la decisión: " + (error.message ?: ""), Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    // El servidor devuelve el número de avisos todavía no consultados por equipo.
    // Usar pendingByTeam evita volver a contar solicitudes que ya fueron vistas.
    private fun updateTeamNotificationCount(payload: JSONObject) {
        val counts = payload.optJSONObject("pendingByTeam") ?: return
        getSharedPreferences("sene_patron_server", MODE_PRIVATE).edit()
            .putInt("notifications_team1", counts.optInt("VENTAS_1", 0).coerceAtLeast(0))
            .putInt("notifications_team2", counts.optInt("VENTAS_2", 0).coerceAtLeast(0))
            .apply()
    }

    private fun refreshTeamRequests(team: String, force: Boolean = false) {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)?.takeIf { it.isNotBlank() } ?: return
        if (prefs.getString("device_id", null).isNullOrBlank()) return
        val now = System.currentTimeMillis()
        val last = prefs.getLong("requests_updated_$team", 0L)
        if (!force && (now - last < 600_000L || prefs.getBoolean("requests_refreshing_$team", false))) return
        prefs.edit().putBoolean("requests_refreshing_$team", true).apply()
        Thread {
            try {
                val slot = if (team == "team1") "VENTAS_1" else "VENTAS_2"
                val api = SeneApiClient(this, baseUrl)
                val result = api.requestsInbox(slot, all = true)
                prefs.edit()
                    .putString("requests_$team", result.toString())
                    .putLong("requests_updated_$team", System.currentTimeMillis())
                    .putBoolean("requests_refreshing_$team", false)
                    .apply()
                updateTeamNotificationCount(result)
                runOnUiThread { if (!isFinishing && (currentPage == "${team}_requests" || currentPage == "team1" || currentPage == "team2" || currentPage == "menu")) render() }
            } catch (error: Exception) {
                prefs.edit().putBoolean("requests_refreshing_$team", false).apply()
                runOnUiThread {
                    if (!isFinishing) Toast.makeText(this, "No se pudo consultar la bandeja: " + (error.message ?: ""), Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    private fun showTeamRequestApproval(team: String, requestId: String) {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(8), dp(18), dp(8))
        }
        val deduction = CheckBox(this).apply {
            text = "Autorizar descuento en nómina"
            isChecked = false
        }
        val amount = EditText(this).apply {
            hint = "Importe a descontar en pesos"
            inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL
            isEnabled = false
        }
        deduction.setOnCheckedChangeListener { _, checked -> amount.isEnabled = checked }
        content.addView(deduction)
        content.addView(amount)
        AlertDialog.Builder(this)
            .setTitle("Aprobar solicitud")
            .setMessage("La aprobación no descuenta dinero automáticamente. Solo se aplicará descuento si marcas la opción y confirmas un importe.")
            .setView(content)
            .setPositiveButton("APROBAR") { _, _ ->
                val details = JSONObject()
                val authorized = deduction.isChecked
                val decision = JSONObject().put("authorized", authorized)
                if (authorized) {
                    val pesos = amount.text.toString().trim().replace(",", ".").toDoubleOrNull()
                    if (pesos == null || pesos < 0 || pesos > 1_000_000) {
                        Toast.makeText(this, "Captura un importe válido para el descuento", Toast.LENGTH_LONG).show()
                        return@setPositiveButton
                    }
                    decision.put("amountCents", Math.round(pesos * 100.0))
                }
                details.put("deduction", decision)
                decideTeamRequest(team, requestId, true, details)
            }
            .setNegativeButton("CANCELAR", null)
            .show()
    }

    private fun decideTeamRequest(
        team: String,
        requestId: String,
        approve: Boolean,
        decisionDetails: JSONObject = JSONObject()
    ) {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)?.takeIf { it.isNotBlank() } ?: return
        Thread {
            try {
                SeneApiClient(this, baseUrl).decideRequest(requestId, approve, decisionDetails)
                prefs.edit().remove("requests_$team").putLong("requests_updated_$team", 0L).apply()
                refreshTeamRequests(team, force = true)
                runOnUiThread {
                    Toast.makeText(this, if (approve) "Solicitud aprobada" else "Solicitud rechazada", Toast.LENGTH_SHORT).show()
                    if (!isFinishing) render()
                }
            } catch (error: Exception) {
                runOnUiThread {
                    Toast.makeText(this, "No se pudo guardar la decisión: " + (error.message ?: ""), Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }


    private fun showPairingQr(team: String, operation: String = "NEW") {
        val slot = if (team == "team1") "VENTAS_1" else "VENTAS_2"
        val number = if (team == "team1") "1" else "2"
        val baseUrl = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
            .getString("server_base_url", null)?.takeIf { it.isNotBlank() }
        if (baseUrl == null) {
            showServerConfig()
            return
        }
        Thread {
            try {
                val result = SeneApiClient(this, baseUrl).createPairingToken(slot, operation)
                val payload = result.optString("qrPayload")
                if (payload.isBlank()) throw IllegalStateException("El servidor no devolvió el QR")
                val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, 640, 640)
                val pixels = IntArray(640 * 640)
                for (y in 0 until 640) for (x in 0 until 640) {
                    pixels[y * 640 + x] = if (matrix.get(x, y)) Color.BLACK else Color.WHITE
                }
                val bitmap = Bitmap.createBitmap(640, 640, Bitmap.Config.ARGB_8888)
                bitmap.setPixels(pixels, 0, 640, 0, 0, 640, 640)
                runOnUiThread {
                    val content = LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        gravity = Gravity.CENTER
                        setPadding(dp(18), dp(8), dp(18), dp(8))
                    }
                    content.addView(ImageView(this).apply {
                        setImageBitmap(bitmap)
                        adjustViewBounds = true
                        scaleType = ImageView.ScaleType.FIT_CENTER
                    }, LinearLayout.LayoutParams(dp(280), dp(280)))
                    content.addView(text(
                        "QR exclusivo de EQUIPO $number. Un solo uso, sin vencimiento por tiempo. " +
                            "Si cierras la aplicación antes de vincularlo, se recuperará este mismo QR.",
                        13, muted
                    ))
                    AlertDialog.Builder(this)
                        .setTitle(if (operation == "REPLACEMENT") "QR DE REPOSICIÓN · EQUIPO $number" else "QR · EQUIPO $number")
                        .setMessage("Escanea este código desde SENE VENTAS del teléfono que ocupará el espacio $number.")
                        .setView(content)
                        .setPositiveButton("CERRAR", null)
                        .show()
                }
            } catch (error: Exception) {
                runOnUiThread {
                    Toast.makeText(this, "No se pudo recuperar o generar el QR: " + (error.message ?: ""), Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    private fun showServerConfig() {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val field = EditText(this).apply {
            hint = "https://tu-worker.workers.dev"
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            setText(prefs.getString("server_base_url", ""))
            setPadding(dp(16), dp(13), dp(16), dp(13))
        }
        AlertDialog.Builder(this)
            .setTitle("CONEXIÓN SEGURA SENE")
            .setMessage("Introduce la dirección HTTPS del servidor SENE. No uses una dirección de prueba Hello World.")
            .setView(field)
            .setPositiveButton("GUARDAR") { _, _ ->
                val value = field.text?.toString()?.trim()?.trimEnd('/').orEmpty()
                val uri = android.net.Uri.parse(value)
                if (!value.startsWith("https://") || uri.host.isNullOrBlank() || value.any { it.isWhitespace() }) {
                    Toast.makeText(this, "Dirección HTTPS no válida", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                if (!prefs.edit().putString("server_base_url", value).commit()) {
                    Toast.makeText(this, "No se pudo guardar la dirección", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                Toast.makeText(this, "Dirección guardada", Toast.LENGTH_SHORT).show()
                if (prefs.getString("device_id", null).isNullOrBlank()) showRegistrationDialog()
                else refreshNotificationsFromServer(force = true)
            }
            .setNegativeButton("CANCELAR", null)
            .show()
    }


    private fun showPatronRecoveryCodeDialog() {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)
        if (baseUrl.isNullOrBlank()) {
            showServerConfig()
            return
        }
        val field = EditText(this).apply {
            hint = "Código de recuperación de un solo uso"
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
            setPadding(dp(16), dp(13), dp(16), dp(13))
        }
        AlertDialog.Builder(this)
            .setTitle("RECUPERAR SENE PATRÓN")
            .setMessage("Usa el código de recuperación emitido por el operador después de verificar al titular. El teléfono anterior será revocado y los dos equipos VENTAS conservarán sus espacios.")
            .setView(field)
            .setPositiveButton("RECUPERAR") { _, _ ->
                val code = field.text?.toString()?.trim().orEmpty()
                if (code.length != 12) {
                    Toast.makeText(this, "El código debe tener 12 caracteres", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                Thread {
                    try {
                        val result = SeneApiClient(this, baseUrl).recover(code)
                        runOnUiThread {
                            lastNotificationRefreshAt = 0L
                            Toast.makeText(this, "SENE PATRÓN recuperado. Estado: " + result.optString("licenseStatus"), Toast.LENGTH_LONG).show()
                            render()
                        }
                    } catch (error: Exception) {
                        runOnUiThread {
                            Toast.makeText(this, "No se pudo recuperar: " + (error.message ?: ""), Toast.LENGTH_LONG).show()
                        }
                    }
                }.start()
            }
            .setNegativeButton("CANCELAR", null)
            .show()
    }

    private fun showRegistrationDialog() {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)
        if (baseUrl.isNullOrBlank()) {
            showServerConfig()
            return
        }
        val existingRequest = prefs.getString("registration_request_id", null)
        if (!existingRequest.isNullOrBlank()) {
            showActivationDialog()
            return
        }
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(4)) }
        fun field(hintText: String, type: Int): EditText = EditText(this).apply {
            hint = hintText; setSingleLine(true); inputType = type
            setPadding(dp(12), dp(10), dp(12), dp(10)); form.addView(this)
        }
        val field = field("Nombre exacto de tu empresa", android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES)
        val emailField = field("Correo electrónico registrado", android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
        val phoneField = field("Número telefónico registrado", android.text.InputType.TYPE_CLASS_PHONE)
        AlertDialog.Builder(this)
            .setTitle("REGISTRO INICIAL · $580 MXN")
            .setMessage(
                "Para registrar SENE PATRÓN y sus dos equipos SENE VENTAS:\n\n" +
                "1. Realiza un pago total de $580 MXN ($500 de alta + $80 de primera mensualidad), usando los datos oficiales de pago proporcionados por SENE.\n" +
                "2. En el concepto escribe ÚNICAMENTE el nombre exacto de tu empresa.\n" +
                "3. Envía el comprobante a uno de los dos números oficiales del botón AYUDA por WhatsApp.\n" +
                "4. Después de enviar el comprobante, pulsa YA REALICÉ EL PAGO.\n\n" +
                "El servidor crea una sola solicitud. El código de activación se entrega a través de los números oficiales de AYUDA únicamente después de verificar el pago. No se activa la licencia antes de introducir el código."
            )
            .setView(form)
            .setPositiveButton("YA REALICÉ EL PAGO") { _, _ ->
                val businessName = field.text?.toString()?.trim()?.replace(Regex("\\s+"), " ").orEmpty()
                if (businessName.isBlank() || businessName.length > 100) {
                    Toast.makeText(this, "Escribe el nombre exacto de tu empresa", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                val email = emailField.text?.toString()?.trim().orEmpty()
                val phone = phoneField.text?.toString()?.trim().orEmpty()
                if (!android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches() ||
                    phone.filter { it.isDigit() }.length !in 10..15) {
                    Toast.makeText(this, "Escribe un correo y teléfono válidos", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                Thread {
                    try {
                        val result = SeneApiClient(this, baseUrl).requestRegistration(businessName, email, phone)
                        val requestId = result.optString("requestId")
                        runOnUiThread {
                            if (requestId.isBlank()) {
                                Toast.makeText(this, "No se recibió el folio de registro", Toast.LENGTH_LONG).show()
                            } else {
                                AlertDialog.Builder(this)
                                    .setTitle("SOLICITUD DE REGISTRO RECIBIDA")
                                    .setMessage(
                                        "Empresa: " + result.optString("businessName", businessName) +
                                        "\nImporte: $580 MXN\nConcepto: " +
                                        result.optString("businessName", businessName) +
                                        "\n\nLa solicitud quedó registrada. Conserva el comprobante y espera el código enviado por los canales oficiales de AYUDA. Cuando lo recibas, vuelve a VINCULAR SENE PATRÓN para introducirlo."
                                    )
                                    .setPositiveButton("CERRAR", null)
                                    .show()
                            }
                        }
                    } catch (error: Exception) {
                        runOnUiThread {
                            val message = when {
                                error.message?.contains("BUSINESS_NAME_ALREADY_REGISTERED") == true ->
                                    "Ese nombre de empresa ya está registrado."
                                error.message?.contains("BUSINESS_NAME_REGISTRATION_PENDING") == true ->
                                    "Ya existe una solicitud pendiente para ese nombre. Contacta AYUDA para continuar."
                                else -> "No se pudo registrar la solicitud. " + (error.message ?: "")
                            }
                            Toast.makeText(this, message, Toast.LENGTH_LONG).show()
                        }
                    }
                }.start()
            }
            .setNegativeButton("CANCELAR", null)
            .show()
    }

    private fun showActivationDialog() {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)
        if (baseUrl.isNullOrBlank()) {
            showServerConfig()
            return
        }
        val field = EditText(this).apply {
            hint = "Código de activación de 12 caracteres"
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
            setPadding(dp(16), dp(13), dp(16), dp(13))
        }
        AlertDialog.Builder(this)
            .setTitle("VINCULAR SENE PATRÓN")
            .setMessage("Introduce el código que recibiste después de confirmar el pago inicial.")
            .setView(field)
            .setPositiveButton("VINCULAR") { _, _ ->
                val code = field.text?.toString()?.trim().orEmpty()
                if (code.length != 12) {
                    Toast.makeText(this, "El código debe tener 12 caracteres", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                Thread {
                    try {
                        val result = SeneApiClient(this, baseUrl).activate(code)
                        runOnUiThread {
                            Toast.makeText(
                                this,
                                "SENE PATRÓN vinculado. Estado: " + result.optString("licenseStatus"),
                                Toast.LENGTH_LONG
                            ).show()
                            lastNotificationRefreshAt = 0L
                            render()
                        }
                    } catch (error: Exception) {
                        runOnUiThread {
                            Toast.makeText(
                                this,
                                "No se pudo vincular. Comprueba el servidor y el código. " +
                                    (error.message ?: ""),
                                Toast.LENGTH_LONG
                            ).show()
                        }
                    }
                }.start()
            }
            .setNegativeButton("CANCELAR", null)
            .show()
    }

    private fun refreshNotificationsFromServer(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (refreshingNotifications || (!force && now - lastNotificationRefreshAt < 86_400_000L)) return
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)?.takeIf { it.isNotBlank() } ?: return
        if (prefs.getString("device_id", null).isNullOrBlank()) return
        refreshingNotifications = true
        // No marcar la consulta como realizada hasta recibir confirmación del servidor.
        // Si falla la red, el siguiente render o intento manual podrá reintentar.
        Thread {
            try {
                val api = SeneApiClient(this, baseUrl)
                val session = api.session()
                if (session.optString("licenseStatus") != "EXPIRED") {
                    // Solo aplicar el intervalo de 24 h cuando el servidor confirmó
                    // la consulta; un fallo de red no debe silenciar reintentos.
                    api.refreshNotifications()
                    lastNotificationRefreshAt = System.currentTimeMillis()
                }
                runOnUiThread {
                    refreshingNotifications = false
                    if (!isFinishing) render()
                }
            } catch (_: Exception) {
                // No volver a renderizar aquí: render() intenta actualizar notificaciones
                // y provocaría un ciclo de reintentos continuo cuando la red falla.
                runOnUiThread {
                    refreshingNotifications = false
                }
            }
        }.start()
    }

    private fun showRenewalDialog() {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)
        if (baseUrl.isNullOrBlank()) {
            showServerConfig()
            return
        }
        val business = prefs.getString("business_name", null).orEmpty().ifBlank { "el nombre exacto de tu empresa" }
        AlertDialog.Builder(this)
            .setTitle("PAGAR MENSUALIDAD")
            .setMessage(
                "RENOVACIÓN SENE · $80 MXN\n\n" +
                    "1. Realiza el pago de $80 MXN.\n" +
                    "2. En el concepto escribe exactamente:\n$business\n" +
                    "3. Envía la captura del comprobante a los números oficiales de Ayuda por WhatsApp.\n" +
                    "4. Después pulsa YA REALICÉ EL PAGO para enviar la solicitud y espera la confirmación del pago y el código de autorización.\n\n" +
                    "La licencia se renueva 30 días cuando introduces el código correcto."
            )
            .setPositiveButton("YA REALICÉ EL PAGO") { _, _ ->
                Thread {
                    try {
                        val result = SeneApiClient(this, baseUrl).requestRenewal()
                        val requestId = result.optString("requestId")
                        runOnUiThread {
                            if (requestId.isNotBlank()) showRenewalCodeDialog(requestId)
                            else Toast.makeText(this, "No se recibió la solicitud de renovación", Toast.LENGTH_LONG).show()
                        }
                    } catch (error: Exception) {
                        runOnUiThread {
                            Toast.makeText(this, "No se pudo enviar la solicitud de pago. " + (error.message ?: ""), Toast.LENGTH_LONG).show()
                        }
                    }
                }.start()
            }
            .setNegativeButton("CERRAR", null)
            .show()
    }

    private fun showRenewalCodeDialog(requestId: String) {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)
        if (baseUrl.isNullOrBlank()) {
            showServerConfig()
            return
        }
        val field = EditText(this).apply {
            hint = "Código de autorización"
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
            setPadding(dp(16), dp(13), dp(16), dp(13))
        }
        AlertDialog.Builder(this)
            .setTitle("ESPERANDO CONFIRMACIÓN")
            .setMessage("Cuando recibas el código de autorización después de verificar el pago, escríbelo aquí. El código es de un solo uso y no caduca por tiempo.")
            .setView(field)
            .setPositiveButton("RENOVAR 30 DÍAS") { _, _ ->
                val code = field.text?.toString()?.trim().orEmpty()
                if (code.length != 12) {
                    Toast.makeText(this, "El código debe tener 12 caracteres", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                Thread {
                    try {
                        val result = SeneApiClient(this, baseUrl).redeemRenewal(requestId, code)
                        runOnUiThread {
                            Toast.makeText(this, "Licencia renovada por 30 días", Toast.LENGTH_LONG).show()
                            lastNotificationRefreshAt = 0L
                            render()
                        }
                    } catch (error: Exception) {
                        runOnUiThread {
                            Toast.makeText(this, "No se pudo renovar. Comprueba el código. " + (error.message ?: ""), Toast.LENGTH_LONG).show()
                        }
                    }
                }.start()
            }
            .setNegativeButton("CANCELAR", null)
            .show()
    }

    private fun showContactDialog() {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)?.trim()?.takeIf { it.startsWith("https://") }
        if (baseUrl == null) {
            AlertDialog.Builder(this)
                .setTitle("CONTACTOS OFICIALES SENE")
                .setMessage("Primero configura la conexión HTTPS con el servidor SENE. Los contactos oficiales no se aceptan desde mensajes ni se guardan como números editables.")
                .setPositiveButton("CERRAR", null)
                .show()
            return
        }

        val loading = AlertDialog.Builder(this)
            .setTitle("CONTACTOS OFICIALES SENE")
            .setMessage("Consultando el servidor y verificando la firma digital…")
            .setNegativeButton("CANCELAR", null)
            .create()
        loading.show()
        Thread {
            try {
                val contacts = SeneApiClient(this, baseUrl).officialSupportContacts()
                val email = contacts.getString("officialEmail")
                val phone1 = contacts.getString("helpPhone1")
                val phone2 = contacts.getString("helpPhone2")
                val revision = contacts.getLong("revision")
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    loading.dismiss()
                    AlertDialog.Builder(this)
                        .setTitle("CONTACTOS OFICIALES SENE · VERIFICADOS")
                        .setMessage(
                            "Correo oficial:\n$email\n\n" +
                                "AYUDA 1:\n$phone1\n\n" +
                                "AYUDA 2:\n$phone2\n\n" +
                                "Revisión digital: $revision\n\n" +
                                "Estos datos fueron validados con la clave pública integrada en SENE PATRÓN."
                        )
                        .setNegativeButton("REINSTALÉ EN EL MISMO TELÉFONO") { _, _ -> showPatronRestoreDialog() }
                        .setNegativeButton("REINSTALÉ EN EL MISMO TELÉFONO") { _, _ -> showPatronRestoreDialog() }
                        .setNeutralButton("PERDÍ MI EQUIPO SENE PATRÓN") { _, _ -> showPatronRecoveryDialog() }
                        .setPositiveButton("CERRAR", null)
                        .show()
                }
            } catch (error: Exception) {
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    loading.dismiss()
                    AlertDialog.Builder(this)
                        .setTitle("NO SE PUDIERON VERIFICAR LOS CONTACTOS")
                        .setMessage("El servidor no respondió con contactos oficiales válidos o la firma digital no coincide. Por seguridad, no se mostrarán números ni correos alternativos.")
                        .setNeutralButton("PERDÍ MI EQUIPO SENE PATRÓN") { _, _ -> showPatronRecoveryDialog() }
                        .setPositiveButton("CERRAR", null)
                        .show()
                }
            }
        }.start()
    }

    private fun showPatronRestoreDialog() {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)?.trim()?.takeIf { it.startsWith("https://") }
        if (baseUrl == null) { showServerConfig(); return }
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(4)) }
        fun field(hintText: String, type: Int) = EditText(this).apply {
            hint = hintText
            inputType = type
            setSingleLine(true)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            form.addView(this)
        }
        val company = field("Nombre exacto de la empresa registrada",
            android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES)
        val email = field("Correo electrónico registrado",
            android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
        val phone = field("Número telefónico registrado", android.text.InputType.TYPE_CLASS_PHONE)
        form.addView(text(
            "Esta opción es únicamente para cuando desinstalaste o reinstalaste SENE PATRÓN en EL MISMO TELÉFONO. No tiene costo si el servidor confirma que coincide con el equipo anterior. Si perdiste o cambiaste de teléfono, utiliza PERDÍ MI EQUIPO SENE PATRÓN.",
            13, muted, false
        ))
        AlertDialog.Builder(this)
            .setTitle("RESTAURAR EN EL MISMO TELÉFONO")
            .setView(form)
            .setPositiveButton("RESTAURAR VINCULACIÓN") { _, _ ->
                val name = company.text?.toString()?.trim().orEmpty()
                val mail = email.text?.toString()?.trim().orEmpty()
                val number = phone.text?.toString()?.trim().orEmpty()
                if (name.isBlank() || !android.util.Patterns.EMAIL_ADDRESS.matcher(mail).matches() ||
                    number.filter { it.isDigit() }.length !in 10..15) {
                    Toast.makeText(this, "Completa los datos registrados correctamente", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                Thread {
                    try {
                        val result = SeneApiClient(this, baseUrl).restorePatron(name, mail, number)
                        runOnUiThread {
                            lastNotificationRefreshAt = 0L
                            Toast.makeText(this,
                                "Vinculación restaurada en este teléfono. Estado: " + result.optString("licenseStatus"),
                                Toast.LENGTH_LONG).show()
                            render()
                        }
                    } catch (error: Exception) {
                        runOnUiThread {
                            Toast.makeText(this,
                                "No se pudo restaurar en este teléfono. " + (error.message ?: ""),
                                Toast.LENGTH_LONG).show()
                        }
                    }
                }.start()
            }
            .setNegativeButton("CANCELAR", null)
            .show()
    }

    private fun showPatronRecoveryDialog() {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)?.trim()?.takeIf { it.startsWith("https://") }
        if (baseUrl == null) { showServerConfig(); return }
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(4)) }
        fun field(hintText: String, type: Int): EditText = EditText(this).apply { hint = hintText; inputType = type; setSingleLine(true); setPadding(dp(12), dp(10), dp(12), dp(10)); form.addView(this) }
        val company = field("Nombre exacto de la empresa registrada", android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES)
        val email = field("Correo electrónico registrado", android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
        val phone = field("Número telefónico registrado", android.text.InputType.TYPE_CLASS_PHONE)
        val instructions = text("REPOSICIÓN DE SENE PATRÓN · $500 MXN\n\n1. Realiza el pago de $500 MXN con el concepto exacto: Reposición SENE PATRÓN.\n2. Envía el comprobante a uno de los números oficiales de AYUDA por WhatsApp.\n3. Después pulsa YA REALICÉ EL PAGO.\n\nEl servidor comprobará que empresa, correo y teléfono coincidan con los datos registrados. Tras verificar el pago, el código de reposición se entregará únicamente por los números oficiales de AYUDA.", 14, ink, false)
        form.addView(instructions)
        AlertDialog.Builder(this).setTitle("PERDÍ MI EQUIPO SENE PATRÓN").setView(form)
            .setPositiveButton("YA REALICÉ EL PAGO") { _, _ ->
                val name = company.text?.toString()?.trim().orEmpty()
                val mail = email.text?.toString()?.trim().orEmpty()
                val number = phone.text?.toString()?.trim().orEmpty()
                if (name.isBlank() || !android.util.Patterns.EMAIL_ADDRESS.matcher(mail).matches() || number.filter { it.isDigit() }.length !in 10..15) {
                    Toast.makeText(this, "Completa los datos registrados correctamente", Toast.LENGTH_LONG).show(); return@setPositiveButton
                }
                Thread {
                    try {
                        val result = SeneApiClient(this, baseUrl).requestPatronRecovery(name, mail, number)
                        runOnUiThread {
                            AlertDialog.Builder(this)
                                .setTitle("SOLICITUD DE REPOSICIÓN RECIBIDA")
                                .setMessage("Folio: ${result.optString("requestId")}\n\nEstado: ${result.optString("status", "pendiente de verificación")}\n\nImporte: $500 MXN\n\nEl código se entregará después de verificar el comprobante, exclusivamente por los números oficiales de AYUDA. Puedes introducirlo aquí o volver más tarde desde la pantalla principal.")
                                .setPositiveButton("INTRODUCIR CÓDIGO") { _, _ -> showPatronRecoveryCodeDialog() }
                                .setNegativeButton("CERRAR", null)
                                .show()
                        }
                    } catch (error: Exception) { runOnUiThread { Toast.makeText(this, error.message ?: "No se pudo enviar la solicitud", Toast.LENGTH_LONG).show() } }
                }.start()
            }.setNegativeButton("CANCELAR", null).show()
    }
    private fun menuScreen(root: LinearLayout) {
        header(root, "Menú de administración")
        val intro = card()
        intro.addView(kicker("HERRAMIENTAS DEL TITULAR"))
        intro.addView(text("Selecciona el equipo que deseas administrar", 20, ink, true))
        intro.addView(text("Cada equipo tendrá sus propias configuraciones y notificaciones independientes.", 13, muted))
        root.addView(intro)
        gap(root, 13)
        root.addView(teamMenuCard("EQUIPO 1", "SENE VENTAS · Primer espacio de trabajador", "team1"))
        gap(root, 11)
        root.addView(teamMenuCard("EQUIPO 2", "SENE VENTAS · Segundo espacio de trabajador", "team2"))
        gap(root, 13)
        root.addView(info("LICENCIA SENE · 3 ESPACIOS",
            "Un dispositivo SENE PATRÓN y dos espacios independientes SENE VENTAS."))
    }

    private fun teamMenuCard(title: String, description: String, destination: String) = card().apply {
        isClickable = true
        isFocusable = true
        val count = pendingAlertCount(destination)
        addView(horizontal(title, when { count > 0 -> "● $count ALERTA(S)"; count == 0 -> "ABRIR  ›"; else -> "SIN CONEXIÓN" }, ink,
            when { count > 0 -> success; count == 0 -> red; else -> muted }))
        addView(text(description, 12, muted))
        setOnClickListener { currentPage = destination; render() }
    }

    private fun teamScreen(root: LinearLayout, team: String) {
        val number = if (team == "team1") "1" else "2"
        header(root, "Equipo $number")
        val intro = card()
        intro.addView(kicker("SENE VENTAS"))
        intro.addView(text("Equipo $number", 21, ink, true))
        intro.addView(text("Todo lo de este trabajador está reunido aquí. Desliza hacia abajo para consultar cada apartado.", 13, muted))
        root.addView(intro)
        gap(root, 10)

        root.addView(notificationCard(number))
        gap(root, 10)

        val requests = card()
        requests.addView(kicker("AVISOS Y SOLICITUDES"))
        renderRequestsInbox(requests, team)
        renderCorrectionInbox(requests, team)
        requests.addView(primaryButton("ACTUALIZAR SOLICITUDES") {
            refreshTeamRequests(team, force = true)
        })
        root.addView(requests)
        refreshTeamRequests(team)
        gap(root, 10)

        val work = card()
        work.addView(kicker("ASISTENCIA Y PAGO"))
        renderTeamReports(work, team)
        work.addView(primaryButton("ACTUALIZAR ASISTENCIAS") {
            refreshTeamReports(team, force = true)
        })
        gap(work, 7)
        renderPayrollSettings(work, team)
        work.addView(primaryButton("CONFIGURAR SUELDO Y FECHA DE PAGO") {
            showPayrollSettingsDialog(team)
        })
        root.addView(work)
        refreshTeamReports(team)
        refreshPayrollSettings(team)
        gap(root, 10)

        val device = card()
        device.addView(kicker("TELÉFONO DEL TRABAJADOR"))
        device.addView(text("Consulta la vinculación o genera el código QR para conectar SENE VENTAS a este espacio.", 13, muted))
        device.addView(primaryButton("GENERAR QR DE VINCULACIÓN · EQUIPO $number") { showPairingQr(team, "NEW") })
        gap(device, 7)
        device.addView(primaryButton("GENERAR QR DE REPOSICIÓN · EQUIPO $number") { showPairingQr(team, "REPLACEMENT") })
        gap(device, 7)
        device.addView(primaryButton("VER ESTADO DE SEGURIDAD") {
            AlertDialog.Builder(this)
                .setTitle("SEGURIDAD · EQUIPO $number")
                .setMessage("La identidad del teléfono y sus eventos de seguridad se validan con el servidor SENE.")
                .setPositiveButton("CERRAR", null)
                .show()
        })
        root.addView(device)
        gap(root, 12)
        root.addView(primaryButton("VOLVER AL INICIO") { currentPage = "home"; render() })
    }

    private fun teamSectionCard(title: String, description: String, destination: String) = card().apply {
        isClickable = true
        isFocusable = true
        val team = if (destination.startsWith("team1_")) "team1" else "team2"
        val section = destination.substringAfter("_")
        val count = pendingAlertCount(team, section)
        addView(horizontal(title, when { count > 0 -> "● $count NUEVA(S)"; count == 0 -> "›"; else -> "SIN CONEXIÓN" }, ink,
            when { count > 0 -> success; count == 0 -> red; else -> muted }))
        addView(text(description, 12, muted))
        setOnClickListener { currentPage = destination; render() }
    }

    private fun pendingAlertCount(team: String, section: String? = null): Int =
        getSharedPreferences("sene_patron_server", MODE_PRIVATE).getInt("notifications_$team", -1)

    private fun notificationCard(number: String) = card().apply {
        val count = pendingAlertCount(if (number == "1") "team1" else "team2")
        addView(horizontal("NOTIFICACIONES · EQUIPO $number", when { count > 0 -> "● $count"; count == 0 -> "SIN AVISOS"; else -> "SIN CONEXIÓN" }, ink, when { count > 0 -> success; count == 0 -> red; else -> muted }))
        gap(this, 4)
        addView(text("Aquí aparecerán exclusivamente los avisos, solicitudes y cambios de este equipo.", 12, muted))
        addView(text("La bandeja de este equipo se actualizará al consultar el servidor SENE.", 11, muted))
    }

    private fun detailScreen(root: LinearLayout, page: String) {
        val teamNumber = if (page.startsWith("team1_")) "1" else "2"
        val section = page.substringAfter("_")
        val teamHome = if (teamNumber == "1") "team1" else "team2"
        val title = when (section) {
            "schedule" -> "Horarios y asistencias"
            "payroll" -> "Sueldo y día de pago"
            "requests" -> "Autorizaciones de corrección"
            "security" -> "Seguridad del dispositivo"
            else -> "Vinculación del equipo"
        }
        header(root, title)
        val intro = card()
        intro.addView(kicker("SENE VENTAS · EQUIPO $teamNumber"))
        intro.addView(text(title, 21, ink, true))
        intro.addView(text(when (section) {
            "schedule" -> "Consulta los horarios, entradas, salidas y asistencias registrados por el Equipo $teamNumber."
            "payroll" -> "Define el sueldo base y el día fijo mensual o las fechas específicas de pago para el Equipo $teamNumber."
            "requests" -> "Revisa solicitudes de corrección de ventas del Equipo $teamNumber. Aceptar autoriza una sola corrección; rechazar la cierra."
            "security" -> "Consulta la seguridad y los eventos del dispositivo asignado al Equipo $teamNumber."
            else -> "Consulta el vínculo y la identidad del dispositivo correspondiente al Equipo $teamNumber."
        }, 14, muted))
        root.addView(intro)
        gap(root, 11)
        root.addView(notificationCard(teamNumber))
        gap(root, 11)
        when (section) {
            "schedule" -> {
                renderTeamReports(root, teamHome)
                gap(root, 8)
                root.addView(primaryButton("ACTUALIZAR REPORTES") { refreshTeamReports(teamHome, force = true) })
                refreshTeamReports(teamHome)
            }
            "payroll" -> {
                renderPayrollSettings(root, teamHome)
                gap(root, 8)
                root.addView(primaryButton("CONFIGURAR SUELDO Y FECHAS") { showPayrollSettingsDialog(teamHome) })
                refreshPayrollSettings(teamHome)
            }
            "requests" -> {
                renderRequestsInbox(root, teamHome)
                renderCorrectionInbox(root, teamHome)
                gap(root, 8)
                root.addView(primaryButton("ACTUALIZAR SOLICITUDES") { refreshTeamRequests(teamHome, force = true) })
                refreshTeamRequests(teamHome)
            }
            "security" -> {
                root.addView(info("ESTADO DEL DISPOSITIVO · EQUIPO $teamNumber",
                    "Los avisos de seguridad, bloqueos e incidencias se mostrarán solo para este equipo."))
                gap(root, 9)
                root.addView(info("SUSTITUCIÓN DE TELÉFONO",
                    "La solicitud de sustitución conservará el espacio de licencia del Equipo $teamNumber y requerirá validación del titular."))
            }
            else -> {
                root.addView(info("VÍNCULO · EQUIPO $teamNumber",
                    "Genera un QR temporal para vincular el teléfono SENE VENTAS que ocupará este espacio. Cada QR permite dos vinculaciones y vence en 24 horas."))
                gap(root, 9)
                root.addView(primaryButton("GENERAR QR DE VINCULACIÓN") { showPairingQr() })
            }
        }
        gap(root, 11)
        root.addView(info("FUNCIONAMIENTO LOCAL Y SERVIDOR SENE",
            "SENE VENTAS conserva localmente ventas, inventario, caja y gastos. Los cierres de turno se envían al servidor y al WhatsApp configurado; los reportes de día de pago se envían al servidor para el cálculo del patrón. No se sincronizan ventas ni inventarios."))
        gap(root, 12)
        root.addView(primaryButton("VOLVER A EQUIPO $teamNumber") { currentPage = teamHome; render() })
    }

    private fun header(root: LinearLayout, subtitle: String) {
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(13), dp(14), dp(13))
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR,
                intArrayOf(Color.rgb(17, 26, 53), Color.rgb(38, 59, 112)))
                .apply { cornerRadius = dp(21).toFloat() }
            elevation = dp(4).toFloat()
        }
        val logoButton = FrameLayout(this).apply {
            background = rounded(Color.rgb(52, 74, 130), 15, Color.rgb(90, 117, 180))
            setPadding(dp(4), dp(4), dp(4), dp(4))
            isClickable = true
            isFocusable = true
            contentDescription = if (currentPage == "menu") "Volver al panel principal" else "Abrir menú de administración"
            setOnClickListener {
                currentPage = "home"
                render()
            }
        }
        val logo = ImageView(this).apply {
            setImageBitmap(redLogo())
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = "Logotipo original SENE. Tocar para abrir el menú."
        }
        logoButton.addView(logo, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        top.addView(logoButton, LinearLayout.LayoutParams(dp(60), dp(60)))
        val brand = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), 0, 0, 0)
        }
        brand.addView(text("SENE / PATRÓN", 19, white, true).apply { letterSpacing = .04f })
        brand.addView(text("GESTIÓN INTELIGENTE", 10, Color.rgb(185, 201, 248), true).apply { letterSpacing = .12f })
        top.addView(brand, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(top, LinearLayout.LayoutParams(-1, -2))
        root.addView(View(this).apply { background = rounded(accent, 3) },
            LinearLayout.LayoutParams(dp(42), dp(5)).apply { topMargin = dp(18); bottomMargin = dp(9) })
        root.addView(text(subtitle, 24, ink, true))
        root.addView(text("Todo bajo control.", 13, muted).apply { setPadding(0, 0, 0, dp(13)) })
    }

    private fun redLogo(): Bitmap =
        android.graphics.BitmapFactory.decodeResource(resources, R.drawable.logo_sene_pv)

    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(15), dp(14), dp(15), dp(14))
        background = rounded(white, 17, Color.rgb(226, 230, 240))
        elevation = dp(1).toFloat()
    }

    private fun info(title: String, body: String) = card().apply {
        addView(kicker(title))
        addView(text(body, 13, muted))
    }

    private fun slot(name: String, description: String, state: String) = card().apply {
        addView(horizontal(name, state, ink, red))
        addView(text(description, 12, muted))
    }

    private fun menuCard(title: String, description: String, destination: String) = card().apply {
        isClickable = true
        isFocusable = true
        addView(horizontal(title, "›", ink, red))
        addView(text(description, 12, muted))
        setOnClickListener { currentPage = destination; render() }
    }

    private fun horizontal(left: String, right: String, leftColor: Int, rightColor: Int) =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(text(left, 14, leftColor, true), LinearLayout.LayoutParams(0, -2, 1f))
            addView(text(right, 10, rightColor, true))
        }

    private fun kicker(value: String) = text(value, 10, accent, true)
        .apply { letterSpacing = .09f; setPadding(0, 0, 0, dp(5)) }

    private fun text(value: String, size: Int, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = value
        textSize = size.toFloat()
        setTextColor(color)
        typeface = Typeface.create("sans-serif", if (bold) Typeface.BOLD else Typeface.NORMAL)
        setPadding(0, dp(3), 0, dp(3))
        setLineSpacing(dp(2).toFloat(), 1f)
    }

    private fun primaryButton(value: String, action: () -> Unit) = TextView(this).apply {
        text = value
        textSize = 14f
        typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER
        setTextColor(white)
        setPadding(dp(16), dp(15), dp(16), dp(15))
        background = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
            intArrayOf(Color.rgb(67, 95, 173), Color.rgb(40, 61, 120)))
            .apply { cornerRadius = dp(14).toFloat() }
        elevation = dp(3).toFloat()
        isClickable = true
        isFocusable = true
        setOnClickListener { action() }
    }

    private fun gap(parent: LinearLayout, height: Int) {
        parent.addView(View(this), LinearLayout.LayoutParams(1, dp(height)))
    }

    private fun rounded(color: Int, radius: Int, stroke: Int = 0) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius).toFloat()
        if (stroke != 0) setStroke(dp(1), stroke)
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}

private class FastMarqueeTextView(context: android.content.Context) : View(context) {
    var message: String = ""
        set(value) { field = value; invalidate(); restart() }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private var textWidth = 0f
    private var offset = 0f
    private var animator: ValueAnimator? = null
    private var gap = 72f * resources.displayMetrics.density

    fun setTextColor(color: Int) { paint.color = color }
    fun setTextSizeSp(size: Float) { paint.textSize = size * resources.displayMetrics.scaledDensity }
    fun setTypeface(typeface: Typeface) { paint.typeface = typeface }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        restart()
    }

    private fun restart() {
        animator?.cancel()
        textWidth = paint.measureText(message)
        if (width <= 0 || textWidth <= 0f || !isAttachedToWindow) return
        val distance = textWidth + gap
        animator = ValueAnimator.ofFloat(0f, distance).apply {
            duration = ((distance / (150f * resources.displayMetrics.density)) * 1000f)
                .toLong().coerceAtLeast(2200L)
            repeatCount = ValueAnimator.INFINITE
            interpolator = LinearInterpolator()
            addUpdateListener { offset = it.animatedValue as Float; invalidate() }
            start()
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val baseline = height / 2f - (paint.ascent() + paint.descent()) / 2f
        var x = -offset
        while (x < width) {
            canvas.drawText(message, x, baseline, paint)
            x += textWidth + gap
        }
    }

    override fun onAttachedToWindow() { super.onAttachedToWindow(); restart() }
    override fun onDetachedFromWindow() { animator?.cancel(); animator = null; super.onDetachedFromWindow() }
}

private class BorderRunnerView(context: android.content.Context) : View(context) {
    private val density = resources.displayMetrics.density
    private val basePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.8f * density
        // Borde rosado tenue para que el punto blanco destaque claramente.
        color = Color.argb(210, 255, 105, 125)
    }
    private val dotGlowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = Color.argb(235, 255, 255, 255)
        setShadowLayer(12f * density, 0f, 0f, Color.WHITE)
    }
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = Color.WHITE
        setShadowLayer(7f * density, 0f, 0f, Color.WHITE)
    }
    private val border = Path()
    private val measure = PathMeasure()
    private var progress = 0f
    private var animator: ValueAnimator? = null

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        border.reset()
        val inset = 5f * density
        border.addRoundRect(RectF(inset, inset, w - inset, h - inset),
            15f * density, 15f * density, Path.Direction.CW)
        measure.setPath(border, false)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawPath(border, basePaint)
        val length = measure.length
        if (length <= 0f) return
        val distance = (progress * length).coerceIn(0f, length)
        val position = FloatArray(2)
        val tangent = FloatArray(2)
        if (measure.getPosTan(distance, position, tangent)) {
            // Un único punto blanco brillante recorre el perímetro completo del rectángulo.
            canvas.drawCircle(position[0], position[1], 8f * density, dotGlowPaint)
            canvas.drawCircle(position[0], position[1], 3.8f * density, dotPaint)
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        setLayerType(View.LAYER_TYPE_SOFTWARE, null)
        animator?.cancel()
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 3200L
            repeatCount = ValueAnimator.INFINITE
            interpolator = LinearInterpolator()
            addUpdateListener { progress = it.animatedValue as Float; invalidate() }
            start()
        }
    }

    override fun onDetachedFromWindow() {
        animator?.cancel()
        animator = null
        super.onDetachedFromWindow()
    }
}
