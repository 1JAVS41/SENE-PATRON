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
    private var lastNotificationRefreshAt = 0L
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
            currentPage == "team1" || currentPage == "team2" -> { currentPage = "menu"; render() }
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
        header(root, "Panel principal")
        val summary = card()
        summary.addView(kicker("ESTADO DE TU LICENCIA"))
        summary.addView(horizontal("SENE PATRÓN", "EQUIPO PRINCIPAL", ink, red))
        gap(summary, 9)
        summary.addView(View(this).apply { setBackgroundColor(Color.rgb(235, 226, 229)) },
            LinearLayout.LayoutParams(-1, dp(1)))
        gap(summary, 9)
        val serverPrefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val linkedCount = serverPrefs.getInt("linked_ventas_count", -1)
        val linkedLabel = if (linkedCount >= 0) "$linkedCount de 2 vinculados" else "PENDIENTE DE CONSULTA"
        summary.addView(horizontal("Dispositivos SENE VENTAS", linkedLabel, ink, if (linkedCount >= 0) success else muted))
        summary.addView(text("La licencia contempla 1 equipo SENE PATRÓN y hasta 2 equipos SENE VENTAS.", 13, muted))
        root.addView(summary)
        gap(root, 12)

        val status = card()
        val licenseStatus = serverPrefs.getString("license_status", "").orEmpty()
        status.addView(horizontal(
            "Administración",
            when (licenseStatus) {
                "active" -> "CONECTADO"
                "expired" -> "LICENCIA VENCIDA"
                "suspended" -> "SUSPENDIDA"
                else -> "PENDIENTE DE VINCULACIÓN"
            },
            ink,
            when (licenseStatus) {
                "active" -> success
                "expired", "suspended" -> red
                else -> muted
            }
        ))
        status.addView(text(
            "El servidor administra licencias, solicitudes, reportes, notificaciones y permisos. Ventas, inventario, caja y gastos permanecen locales en SENE VENTAS.",
            12, muted
        ))
        root.addView(status)
        gap(root, 10)

        val linked = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
            .getString("device_id", null).orEmpty().isNotBlank()
        root.addView(primaryButton(if (linked) "ACTUALIZAR ESTADO Y NOTIFICACIONES" else "VINCULAR LICENCIA SENE") {
            if (linked) refreshNotificationsFromServer(force = true) else showActivationDialog()
        })
        gap(root, 7)
        root.addView(primaryButton("CONFIGURAR CONEXIÓN SEGURA") { showServerConfig() })
        if (linked) {
            gap(root, 7)
            root.addView(primaryButton("PAGAR MENSUALIDAD · $80 MXN") { showRenewalDialog() })
            val pendingRenewal = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
                .getString("renewal_request_id", null)
            if (!pendingRenewal.isNullOrBlank()) {
                gap(root, 7)
                root.addView(primaryButton("INTRODUCIR CÓDIGO DE RENOVACIÓN") {
                    showRenewalCodeDialog(pendingRenewal)
                })
            }
        }
        gap(root, 14)

        root.addView(primaryButton("¿NECESITAS AYUDA?") { showContactDialog() })
        gap(root, 7)
        root.addView(text(
            "Si perdiste un equipo, comunícate para obtener una nueva app y su vinculación.",
            12, muted
        ).apply { gravity = Gravity.CENTER; setPadding(dp(8), dp(3), dp(8), dp(3)) })
        gap(root, 14)

        // Marco de altura fija: ambos trazos ocupan el mismo rectángulo y el destello queda encima.
        val warningFrame = FrameLayout(this).apply {
            setPadding(dp(3), dp(3), dp(3), dp(3))
            clipChildren = false
            clipToPadding = false
        }
        val warningBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
                intArrayOf(Color.rgb(91, 10, 27), Color.rgb(190, 35, 48), Color.rgb(91, 10, 27)))
                .apply { cornerRadius = dp(15).toFloat() }
            elevation = dp(5).toFloat()
        }
        val warningText = FastMarqueeTextView(this).apply {
            message = "EN CASO DE PÉRDIDA DE ALGÚN EQUIPO VINCULADO, LA REPOSICIÓN DE NUESTRA APP TIENE UN COSTO POR DISPOSICIÓN DE LICENCIA Y VINCULACIÓN. ¡CUIDA TUS EQUIPOS DE TRABAJO!"
            setTextColor(Color.WHITE)
            setTextSizeSp(13f)
            setTypeface(Typeface.DEFAULT_BOLD)
            contentDescription = message
        }
        warningBox.addView(warningText, LinearLayout.LayoutParams(-1, dp(38)))
        warningFrame.addView(warningBox, FrameLayout.LayoutParams(-1, -1))
        warningFrame.addView(BorderRunnerView(this), FrameLayout.LayoutParams(-1, -1))
        root.addView(warningFrame, LinearLayout.LayoutParams(-1, dp(66)))
        gap(root, 16)

        val instruction = FrameLayout(this).apply {
            setPadding(dp(5), dp(8), dp(5), dp(8))
        }
        val instructionText = "TOCA EL CARRITO SENE PATRÓN PARA ADMINISTRAR"
        val instructionShadow = text(instructionText, 13, Color.rgb(3, 27, 78), false).apply {
            gravity = Gravity.CENTER
            letterSpacing = .025f
            translationX = dp(1).toFloat()
            translationY = dp(1).toFloat()
            setShadowLayer(dp(2).toFloat(), 0f, dp(1).toFloat(), Color.rgb(0, 18, 58))
        }
        val instructionFace = text(instructionText, 13, Color.rgb(80, 170, 255), false).apply {
            gravity = Gravity.CENTER
            letterSpacing = .025f
            setShadowLayer(dp(2).toFloat(), 0f, 0f, Color.rgb(130, 205, 255))
            post {
                paint.shader = LinearGradient(
                    0f, 0f, 0f, height.toFloat().coerceAtLeast(1f),
                    intArrayOf(Color.rgb(225, 245, 255), Color.rgb(70, 160, 245),
                        Color.rgb(15, 75, 165), Color.rgb(175, 220, 255)),
                    null, Shader.TileMode.CLAMP
                )
                invalidate()
            }
        }
        instruction.addView(instructionShadow, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))
        instruction.addView(instructionFace, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))
        root.addView(instruction, LinearLayout.LayoutParams(-1, -2))
        gap(root, 10)
        root.addView(text("SENE PATRÓN  ·  Versión 0.5.0", 11, muted)
            .apply { gravity = Gravity.CENTER })
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
            hint = "Sueldo base mensual en pesos"
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
                if (salaryValue == null || salaryValue < 0 || salaryValue > 10_000_000 ||
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
                val report = payroll.getJSONObject(i)
                val card = card()
                card.addView(text("Nómina · " + report.optString("periodKey"), 15, ink, true))
                card.addView(text((report.optJSONObject("report") ?: JSONObject()).toString(2), 12, muted))
                root.addView(card)
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
                            .setMessage("Este permiso será de un solo uso y quedará ligado únicamente a esta venta.")
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
                runOnUiThread { if (!isFinishing && currentPage == "${team}_requests") render() }
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


    private fun showPairingQr() {
        val baseUrl = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
            .getString("server_base_url", null)?.takeIf { it.isNotBlank() }
        if (baseUrl == null) {
            showServerConfig()
            return
        }
        Thread {
            try {
                val result = SeneApiClient(this, baseUrl).createPairingToken()
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
                    content.addView(text("Escanea este QR desde SENE VENTAS. Usos restantes: " +
                        result.optInt("remainingUses", 2) + "\nVence: " +
                        java.text.SimpleDateFormat("dd/MM/yyyy HH:mm", java.util.Locale("es", "MX"))
                            .format(java.util.Date(result.optLong("expiresAt", 0L) * 1000)), 13, muted))
                    AlertDialog.Builder(this)
                        .setTitle("VINCULAR SENE VENTAS")
                        .setMessage("QR de un solo proceso. No lo compartas con personas ajenas a tu negocio.")
                        .setView(content)
                        .setPositiveButton("CERRAR", null)
                        .show()
                }
            } catch (error: Exception) {
                runOnUiThread {
                    Toast.makeText(this, "No se pudo generar el QR: " + (error.message ?: ""), Toast.LENGTH_LONG).show()
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
                if (prefs.getString("device_id", null).isNullOrBlank()) showActivationDialog()
                else refreshNotificationsFromServer(force = true)
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
        if (refreshingNotifications || (!force && now - lastNotificationRefreshAt < 43_200_000L)) return
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val baseUrl = prefs.getString("server_base_url", null)?.takeIf { it.isNotBlank() } ?: return
        if (prefs.getString("device_id", null).isNullOrBlank()) return
        refreshingNotifications = true
        lastNotificationRefreshAt = now
        Thread {
            try {
                val api = SeneApiClient(this, baseUrl)
                val session = api.session()
                if (session.optString("licenseStatus") != "EXPIRED") {
                    try { api.refreshNotifications() } catch (_: Exception) { }
                }
                runOnUiThread {
                    refreshingNotifications = false
                    if (!isFinishing) render()
                }
            } catch (_: Exception) {
                runOnUiThread {
                    refreshingNotifications = false
                    if (!isFinishing) render()
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
                    "4. Después pulsa CONSULTAR PAGO y espera el código de autorización.\n\n" +
                    "La licencia se renueva 30 días cuando introduces el código correcto."
            )
            .setPositiveButton("YA PAGUÉ · CONSULTAR PAGO") { _, _ ->
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
                            Toast.makeText(this, "No se pudo consultar el pago. " + (error.message ?: ""), Toast.LENGTH_LONG).show()
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
        AlertDialog.Builder(this)
            .setTitle("DATOS DE CONTACTO")
            .setMessage(
                "Teléfonos:\n3325142147\n3324860833\n\nCorreo electrónico:\nnagavs28@gmail.com"
            )
            .setPositiveButton("CERRAR", null)
            .show()
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
        intro.addView(kicker("CONFIGURACIÓN INDIVIDUAL"))
        intro.addView(text("SENE VENTAS · EQUIPO $number", 20, ink, true))
        intro.addView(text("Administra únicamente la información y las solicitudes correspondientes a este equipo.", 13, muted))
        root.addView(intro)
        gap(root, 11)
        root.addView(notificationCard(number))
        gap(root, 12)
        val sections = listOf(
            Triple("Horarios y asistencias", "Turnos, entradas, salidas y registros de asistencia", "schedule"),
            Triple("Sueldo y día de pago", "Configura el sueldo y las fechas de nómina de este equipo", "payroll"),
            Triple("Autorizaciones de corrección", "Revisa solicitudes puntuales de corrección de ventas", "requests"),
            Triple("Seguridad del dispositivo", "Estado de seguridad, bloqueo y sustitución del teléfono", "security"),
            Triple("Vinculación del equipo", "Identidad, estado de vínculo y datos del dispositivo", "link")
        )
        sections.forEachIndexed { index, item ->
            root.addView(teamSectionCard(item.first, item.second, team + "_" + item.third))
            if (index != sections.lastIndex) gap(root, 9)
        }
        gap(root, 12)
        root.addView(primaryButton("VOLVER A EQUIPOS") { currentPage = "menu"; render() })
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
                currentPage = if (currentPage == "menu") "home" else "menu"
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
