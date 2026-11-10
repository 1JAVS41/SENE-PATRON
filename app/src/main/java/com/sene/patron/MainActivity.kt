package com.sene.patron

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.text.InputType
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    private val bg = Color.rgb(244, 245, 250)
    private val ink = Color.rgb(23, 33, 61)
    private val muted = Color.rgb(111, 121, 145)
    private val red = Color.rgb(24, 119, 190)
    private val redDark = Color.rgb(16, 91, 151)
    private val white = Color.WHITE
    private var currentPage = "home"
    private var team1StatusButton: TextView? = null
    private var team2StatusButton: TextView? = null
    private var linkedDevicesText: TextView? = null
    private var homeLicenseText: TextView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = bg
        window.navigationBarColor = bg
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }
        render()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        when (currentPage) {
            "home" -> super.onBackPressed()
            "menu" -> { currentPage = "home"; render() }
            else -> { currentPage = "menu"; render() }
        }
    }

    private fun render() {
        // Cada pantalla se monta dentro de un ScrollView independiente para permitir
        // desplazamiento vertical incluso en teléfonos pequeños o con letra ampliada.
        val scroll = ScrollView(this).apply {
            setBackgroundColor(bg)
            isFillViewport = true
            isSmoothScrollingEnabled = true
            isVerticalScrollBarEnabled = false
            clipToPadding = false
        }
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(32))
        }
        scroll.addView(page)
        when (currentPage) {
            "home" -> homeScreen(page)
            "menu" -> menuScreen(page)
            "connection" -> connectionScreen(page)
            else -> detailScreen(page, currentPage)
        }
        setContentView(scroll)
    }

    private fun homeScreen(root: LinearLayout) {
        header(root, "Panel principal")
        val summary = card()
        summary.addView(kicker("ESTADO DE TU LICENCIA"))
        summary.addView(horizontal("SENE PATRÓN", "EQUIPO PRINCIPAL", ink, red))
        gap(summary, 9)
        summary.addView(View(this).apply { setBackgroundColor(Color.rgb(220, 235, 244)) },
            LinearLayout.LayoutParams(-1, dp(1)))
        gap(summary, 9)
        val linkedLine = horizontal("Dispositivos SENE VENTAS", "Sin consultar", ink, red)
        linkedDevicesText = linkedLine.getChildAt(1) as TextView
        summary.addView(linkedLine)
        summary.addView(text("La licencia contempla 1 equipo SENE PATRÓN y hasta 2 equipos SENE VENTAS.", 13, muted))
        root.addView(summary)
        gap(root, 12)

        val status = card()
        val statusLine = horizontal("Administración", "SIN CONSULTAR", ink, red)
        homeLicenseText = statusLine.getChildAt(1) as TextView
        status.addView(statusLine)
        status.addView(text("El estado se consulta directamente con el servidor SENE. Las operaciones remotas requieren conexión y licencia vigente.", 12, muted))
        root.addView(status)
        refreshHomeStatus()
        gap(root, 12)
        root.addView(primaryButton("CONECTAR / ACTIVAR LICENCIA") { currentPage = "connection"; render() })
        gap(root, 16)
        root.addView(text("Toca el logotipo para abrir el menú de administración.", 12, muted)
            .apply { gravity = Gravity.CENTER; setPadding(dp(8), dp(8), dp(8), dp(8)) })
        gap(root, 10)
        root.addView(text("SENE PATRÓN  ·  Versión 0.5.0", 11, muted)
            .apply { gravity = Gravity.CENTER })
    }

    private fun refreshHomeStatus() {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val base = prefs.getString("server_base_url", null)
        val device = prefs.getString("device_id", null)
        if (base.isNullOrBlank() || device.isNullOrBlank()) {
            linkedDevicesText?.text = "No activado"
            homeLicenseText?.text = "PENDIENTE DE ACTIVACIÓN"
            return
        }
        Thread {
            try {
                val state = SenePatronApiClient(this, base).session(device)
                val count = state.optInt("linkedVentasCount", 0).coerceIn(0, 2)
                val license = state.optString("licenseStatus", "UNKNOWN")
                runOnUiThread {
                    linkedDevicesText?.text = "$count de 2 vinculados"
                    homeLicenseText?.text = license
                }
            } catch (_: Exception) {
                runOnUiThread {
                    linkedDevicesText?.text = "Sin conexión"
                    homeLicenseText?.text = "NO DISPONIBLE"
                }
            }
        }.start()
    }

    private fun menuScreen(root: LinearLayout) {
        header(root, "Menú de administración")
        val intro = card()
        intro.addView(kicker("HERRAMIENTAS DEL TITULAR"))
        intro.addView(text("¿Qué deseas administrar?", 20, ink, true))
        intro.addView(text("Selecciona una sección. Toca de nuevo el logotipo para regresar al panel principal.", 13, muted))
        root.addView(intro)
        gap(root, 13)
        val actions = listOf(
            Triple("Vinculación de equipos", "Administra los dos espacios SENE VENTAS de tu licencia", "devices"),
            Triple("Solicitudes operativas", "Revisa solicitudes que requieren autorización del patrón", "requests"),
            Triple("Horarios y asistencia", "Consulta horarios y actividad de los equipos", "schedule"),
            Triple("Seguridad de dispositivos", "Consulta bloqueos y procesos de sustitución", "security"),
            Triple("Conexión y activación", "Conecta el panel con el servidor seguro SENE", "connection")
        )
        actions.forEachIndexed { index, item ->
            root.addView(menuCard(item.first, item.second, item.third))
            if (index != actions.lastIndex) gap(root, 10)
        }
        gap(root, 13)
        root.addView(info("LICENCIA SENE · 3 ESPACIOS",
            "Un dispositivo SENE PATRÓN y exactamente dos espacios SENE VENTAS."))
    }

    private fun connectionScreen(root: LinearLayout) {
        header(root, "Conexión y activación")
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val base = EditText(this).apply {
            hint = "https://tu-worker.workers.dev"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
            setText(prefs.getString("server_base_url", ""))
        }
        val code = EditText(this).apply {
            hint = "Código de activación entregado por SENE"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            setSingleLine(true)
        }
        val recoveryCode = EditText(this).apply {
            hint = "Código de recuperación de PATRÓN (12 caracteres)"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            setSingleLine(true)
        }
        val fields = card()
        fields.addView(kicker("SERVIDOR OFICIAL SENE"))
        fields.addView(text("Dirección HTTPS del Worker", 13, ink, true))
        fields.addView(base)
        fields.addView(text("Código de activación", 13, ink, true))
        fields.addView(code)
        fields.addView(text("Recuperación de un PATRÓN perdido", 13, ink, true))
        fields.addView(recoveryCode)
        root.addView(fields)
        gap(root, 12)
        root.addView(primaryButton("GUARDAR DIRECCIÓN") {
            val value = base.text.toString().trim().trimEnd('/')
            val uri = Uri.parse(value)
            if (!value.startsWith("https://") || uri.host.isNullOrBlank() || value.any { it.isWhitespace() }) {
                Toast.makeText(this, "Escribe una dirección HTTPS válida", Toast.LENGTH_LONG).show()
            } else {
                prefs.edit().putString("server_base_url", value).apply()
                Toast.makeText(this, "Dirección guardada en este teléfono", Toast.LENGTH_LONG).show()
            }
        })
        gap(root, 9)
        root.addView(primaryButton("ACTIVAR SENE PATRÓN") {
            val value = base.text.toString().trim().trimEnd('/')
            val activationCode = code.text.toString().trim()
            val uri = Uri.parse(value)
            if (!value.startsWith("https://") || uri.host.isNullOrBlank() || activationCode.isBlank()) {
                Toast.makeText(this, "Captura una dirección HTTPS y el código de activación", Toast.LENGTH_LONG).show()
            } else {
                prefs.edit().putString("server_base_url", value).apply()
                Toast.makeText(this, "Validando activación con el servidor SENE…", Toast.LENGTH_LONG).show()
                Thread {
                    try {
                        val api = SenePatronApiClient(this, value)
                        val activated = api.activate(activationCode)
                        val state = api.session(activated.getString("deviceId"))
                        runOnUiThread {
                            code.text.clear()
                            Toast.makeText(this, "SENE PATRÓN activado. Estado: " + state.optString("licenseStatus"), Toast.LENGTH_LONG).show()
                            currentPage = "home"
                            render()
                        }
                    } catch (e: Exception) {
                        val detail = (e as? SenePatronApiException)?.responseBody.orEmpty()
                        val error = try { org.json.JSONObject(detail).optString("error", detail) } catch (_: Exception) { detail }
                        runOnUiThread { Toast.makeText(this, "No se pudo activar: " + (error.ifBlank { e.message ?: "Error de conexión" }), Toast.LENGTH_LONG).show() }
                    }
                }.start()
            }
        })
        gap(root, 9)
        root.addView(primaryButton("RECUPERAR PATRÓN EN UN TELÉFONO NUEVO") {
            val value = base.text.toString().trim().trimEnd('/')
            val recovery = recoveryCode.text.toString().trim()
            val uri = Uri.parse(value)
            if (!value.startsWith("https://") || uri.host.isNullOrBlank() || recovery.isBlank()) {
                Toast.makeText(this, "Captura la dirección HTTPS y el código de recuperación", Toast.LENGTH_LONG).show()
            } else {
                prefs.edit().putString("server_base_url", value).apply()
                Thread {
                    try {
                        val api = SenePatronApiClient(this, value)
                        val recovered = api.recover(recovery)
                        val state = api.session(recovered.getString("deviceId"))
                        runOnUiThread {
                            recoveryCode.text.clear()
                            Toast.makeText(this, "PATRÓN recuperado. Estado: " + state.optString("licenseStatus"), Toast.LENGTH_LONG).show()
                            currentPage = "home"
                            render()
                        }
                    } catch (e: Exception) {
                        runOnUiThread { Toast.makeText(this, "No se pudo recuperar: " + (e.message ?: "Error"), Toast.LENGTH_LONG).show() }
                    }
                }.start()
            }
        })
        gap(root, 9)
        root.addView(primaryButton("VERIFICAR ESTADO DE LICENCIA") {
            val value = prefs.getString("server_base_url", null)
            val deviceId = prefs.getString("device_id", null)
            if (value.isNullOrBlank() || deviceId.isNullOrBlank()) {
                Toast.makeText(this, "Primero guarda el servidor y activa el equipo", Toast.LENGTH_LONG).show()
            } else {
                Thread {
                    try {
                        val state = SenePatronApiClient(this, value).session(deviceId)
                        runOnUiThread { Toast.makeText(this, "Licencia: " + state.optString("licenseStatus") + " · Vigencia: " + state.optLong("periodEndsAt"), Toast.LENGTH_LONG).show() }
                    } catch (e: Exception) {
                        runOnUiThread { Toast.makeText(this, "No se pudo consultar: " + (e.message ?: "Error"), Toast.LENGTH_LONG).show() }
                    }
                }.start()
            }
        })
        gap(root, 12)
        root.addView(info("SEGURIDAD", "La clave privada permanece dentro de Android Keystore. El código de activación no se guarda. No uses la dirección temporal Hello World: el servidor SENE debe estar desplegado y validado antes de activar."))
        gap(root, 12)
        root.addView(primaryButton("VOLVER AL MENÚ") { currentPage = "menu"; render() })
    }

    private fun detailScreen(root: LinearLayout, page: String) {
        val title = when (page) {
            "connection" -> "Conexión y activación"
            "devices" -> "Vinculación de equipos"
            "requests" -> "Solicitudes operativas"
            "schedule" -> "Horarios y asistencia"
            else -> "Seguridad de dispositivos"
        }
        header(root, title)
        val intro = card()
        intro.addView(kicker("ADMINISTRACIÓN SENE"))
        intro.addView(text(title, 21, ink, true))
        intro.addView(text(when (page) {
            "devices" -> "Tu licencia contempla un dispositivo SENE PATRÓN y exactamente dos espacios SENE VENTAS."
            "requests" -> "Centro donde el titular revisará y resolverá solicitudes de sus equipos."
            "schedule" -> "Consulta administrativa de horarios y asistencia de los equipos autorizados."
            else -> "Protección de los dispositivos vinculados a la licencia y control de sustituciones."
        }, 14, muted))
        root.addView(intro)
        gap(root, 12)
        when (page) {
            "devices" -> devicesScreen(root)
            "requests" -> requestsScreen(root)
            "schedule" -> scheduleScreen(root)
            "security" -> securityScreen(root)
        }
        gap(root, 12)
        root.addView(info("MODO DE PREPARACIÓN",
            "Las pantallas de activación, vinculación, solicitudes, notificaciones, reemplazos y nómina ya están conectadas al cliente HTTPS firmado. Requieren que la API SENE esté desplegada y validada antes de usarse."))
        gap(root, 12)
        root.addView(primaryButton("VOLVER AL MENÚ") { currentPage = "menu"; render() })
    }

    private fun devicesScreen(root: LinearLayout) {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val base = prefs.getString("server_base_url", null)
        val device = prefs.getString("device_id", null)
        if (base.isNullOrBlank() || device.isNullOrBlank()) {
            root.addView(info("EQUIPOS SIN ACTIVAR", "Primero conecta y activa SENE PATRÓN para consultar los espacios de la licencia."))
            root.addView(primaryButton("IR A CONEXIÓN Y ACTIVACIÓN") { currentPage = "connection"; render() })
            return
        }
        root.addView(primaryButton("CONSULTAR ESTADO DE LOS EQUIPOS") {
            Thread {
                try {
                    val state = SenePatronApiClient(this, base).session(device)
                    val count = state.optInt("linkedVentasCount", 0)
                    runOnUiThread {
                        AlertDialog.Builder(this).setTitle("ESTADO DE LICENCIA")
                            .setMessage("Empresa: " + state.optString("businessName", "—") +
                                "\nEquipos SENE VENTAS vinculados: $count de 2" +
                                "\nEstado: " + state.optString("licenseStatus") +
                                "\nVencimiento (UTC): " + state.optLong("periodEndsAt"))
                            .setPositiveButton("CERRAR", null).show()
                    }
                } catch (e: Exception) {
                    runOnUiThread { Toast.makeText(this, "No se pudo consultar: " + (e.message ?: "Error"), Toast.LENGTH_LONG).show() }
                }
            }.start()
        })
        gap(root, 9)
        root.addView(primaryButton("GENERAR QR PARA VINCULAR EQUIPOS") {
            Thread {
                try {
                    val result = SenePatronApiClient(this, base).createPairingToken(device)
                    val payload = result.getString("qrPayload")
                    val matrix = MultiFormatWriter().encode(payload, BarcodeFormat.QR_CODE, 720, 720)
                    val bitmap = Bitmap.createBitmap(720, 720, Bitmap.Config.ARGB_8888)
                    for (y in 0 until 720) for (x in 0 until 720) {
                        bitmap.setPixel(x, y, if (matrix.get(x, y)) Color.BLACK else Color.WHITE)
                    }
                    runOnUiThread {
                        val image = ImageView(this).apply {
                            setImageBitmap(bitmap)
                            setPadding(dp(12), dp(12), dp(12), dp(12))
                            adjustViewBounds = true
                        }
                        val content = LinearLayout(this).apply {
                            orientation = LinearLayout.VERTICAL
                            setPadding(dp(12), dp(8), dp(12), dp(8))
                            addView(image, LinearLayout.LayoutParams(-1, dp(280)))
                            addView(text("Usos restantes: " + result.optInt("remainingUses") +
                                "\nVálido hasta (UTC): " + result.optLong("expiresAt"), 12, muted))
                            addView(text(payload, 10, muted))
                        }
                        AlertDialog.Builder(this).setTitle("QR DE VINCULACIÓN SENE VENTAS")
                            .setView(content).setPositiveButton("CERRAR", null).show()
                    }
                } catch (e: Exception) {
                    runOnUiThread { Toast.makeText(this, "No se pudo generar el QR: " + (e.message ?: "Error"), Toast.LENGTH_LONG).show() }
                }
            }.start()
        })
        gap(root, 9)
        root.addView(primaryButton("IR A SOLICITUDES Y NOTIFICACIONES") { currentPage = "requests"; render() })
        gap(root, 9)
        root.addView(info("REGLA DE LICENCIA", "Un equipo SENE PATRÓN y exactamente dos espacios SENE VENTAS. Cada QR permite dos vinculaciones y el servidor asigna el equipo libre."))
    }

    private fun requestsScreen(root: LinearLayout) {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val base = prefs.getString("server_base_url", null)
        val device = prefs.getString("device_id", null)
        if (base.isNullOrBlank() || device.isNullOrBlank()) {
            root.addView(info("SERVICIO NO ACTIVADO", "Conecta y activa SENE PATRÓN para recibir solicitudes."))
            root.addView(primaryButton("IR A CONEXIÓN") { currentPage = "connection"; render() })
            return
        }
        root.addView(info("NOTIFICACIONES INDEPENDIENTES", "Cada equipo conserva su propio contador. Rojo significa cero pendientes sin consultar; verde significa que hay una o más notificaciones."))
        gap(root, 9)
        val firstTeamButton = teamStatusButton("VENTAS_1", "EQUIPO 1 · SENE VENTAS", base)
        val secondTeamButton = teamStatusButton("VENTAS_2", "EQUIPO 2 · SENE VENTAS", base)
        team1StatusButton = firstTeamButton
        team2StatusButton = secondTeamButton
        root.addView(firstTeamButton)
        gap(root, 9)
        root.addView(secondTeamButton)
        gap(root, 9)
        root.addView(primaryButton("ACTUALIZAR CONTADORES") { refreshNotificationButtons(base) })
        refreshNotificationButtons(base)
        gap(root, 9)
        root.addView(info("IMPORTANTE", "Al abrir la bandeja de un equipo, el servidor marca como vistas sus notificaciones pendientes de ese equipo. Las solicitudes permanecen en el historial hasta que se aprueban o rechazan."))
    }

    private fun teamStatusButton(slot: String, label: String, base: String): TextView =
        TextView(this).apply {
            text = "$label\n0 notificaciones"
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            setPadding(dp(14), dp(16), dp(14), dp(16))
            background = rounded(Color.rgb(190, 45, 55), 14)
            isClickable = true
            isFocusable = true
            setOnClickListener { loadTeamInbox(slot, base) }
        }

    private fun updateTeamStatus(button: TextView?, label: String, count: Int) {
        if (button == null) return
        button.text = if (count > 0) "$label\n$count NOTIFICACIONES PENDIENTES"
            else "$label\nSIN NOTIFICACIONES PENDIENTES"
        button.background = rounded(
            if (count > 0) Color.rgb(28, 151, 91) else Color.rgb(190, 45, 55),
            14
        )
    }

    private fun refreshNotificationButtons(base: String) {
        val device = getSharedPreferences("sene_patron_server", MODE_PRIVATE).getString("device_id", null)
            ?: return
        Thread {
            try {
                val counts = SenePatronApiClient(this, base).notifications(device)
                    .optJSONObject("pendingByTeam") ?: org.json.JSONObject()
                val first = counts.optInt("VENTAS_1", 0)
                val second = counts.optInt("VENTAS_2", 0)
                runOnUiThread {
                    updateTeamStatus(team1StatusButton, "EQUIPO 1 · SENE VENTAS", first)
                    updateTeamStatus(team2StatusButton, "EQUIPO 2 · SENE VENTAS", second)
                }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this, "No se pudieron actualizar los contadores: " + (e.message ?: "Error"), Toast.LENGTH_LONG).show() }
            }
        }.start()
    }

    private fun loadTeamInbox(slot: String, base: String) {
        Thread {
            try {
                val api = SenePatronApiClient(this, base)
                // Las solicitudes laborales y las correcciones tienen endpoints separados.
                // Consultar ambos evita que las autorizaciones de venta desaparezcan de la bandeja.
                val result = api.requestsInbox(slot, "pending")
                val correctionResult = api.correctionsInbox(slot, "pending")
                val work = result.optJSONArray("items") ?: org.json.JSONArray()
                val corrections = correctionResult.optJSONArray("items") ?: org.json.JSONArray()
                val labels = ArrayList<String>()
                val kinds = ArrayList<String>()
                val records = ArrayList<org.json.JSONObject>()
                for (i in 0 until work.length()) {
                    val item = work.optJSONObject(i) ?: continue
                    labels.add("SOLICITUD · " + item.optString("type") + "\n" + item.optJSONObject("details")?.optString("description").orEmpty())
                    kinds.add("work"); records.add(item)
                }
                for (i in 0 until corrections.length()) {
                    val item = corrections.optJSONObject(i) ?: continue
                    labels.add("CORRECCIÓN DE VENTA\nVenta: " + item.optString("saleId") + "\nMotivo: " + item.optString("reason"))
                    kinds.add("correction"); records.add(item)
                }
                val counts = correctionResult.optJSONObject("pendingByTeam")
                    ?: result.optJSONObject("pendingByTeam") ?: org.json.JSONObject()
                val unseenCount = counts.optInt(slot, 0)
                val pendingCount = labels.size
                val message = if (pendingCount == 0) "No hay solicitudes pendientes para este equipo." else
                    "Solicitudes pendientes en esta bandeja: " + pendingCount + "\nSelecciona una solicitud para revisar y responder."
                runOnUiThread {
                    if (slot == "VENTAS_1") updateTeamStatus(team1StatusButton, "EQUIPO 1 · SENE VENTAS", unseenCount)
                    else updateTeamStatus(team2StatusButton, "EQUIPO 2 · SENE VENTAS", unseenCount)
                    val builder = AlertDialog.Builder(this).setTitle(if (slot == "VENTAS_1") "EQUIPO 1 · BANDEJA" else "EQUIPO 2 · BANDEJA")
                    if (labels.isEmpty()) builder.setMessage(message).setPositiveButton("CERRAR", null).show()
                    else builder.setMessage(message).setItems(labels.toTypedArray()) { _, index ->
                        val item = records[index]
                        val correction = kinds[index] == "correction"
                        val details = if (correction) {
                            "Venta: " + item.optString("saleId") + "\nMotivo: " + item.optString("reason")
                        } else {
                            "Tipo: " + item.optString("type") + "\nDetalle: " +
                                (item.optJSONObject("details")?.toString(2) ?: "{}")
                        }
                        AlertDialog.Builder(this).setTitle(if (correction) "AUTORIZAR CORRECCIÓN" else "REVISAR SOLICITUD")
                            .setMessage(details + "\n\nEl motivo se registra en SENE VENTAS y aquí se muestra para que puedas decidir sin llamar al trabajador. ¿Deseas aprobar o rechazar?")
                            .setPositiveButton("APROBAR") { _, _ -> decideTeamItem(base, item, correction, "approve", slot) }
                            .setNegativeButton("RECHAZAR") { _, _ -> decideTeamItem(base, item, correction, "reject", slot) }
                            .setNeutralButton("VOLVER", null).show()
                    }.setNegativeButton("CERRAR", null).show()
                }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this, "No se pudo cargar la bandeja: " + (e.message ?: "Error"), Toast.LENGTH_LONG).show() }
            }
        }.start()
    }

    private fun decideTeamItem(base: String, item: org.json.JSONObject, correction: Boolean, decision: String, slot: String) {
        if (correction || decision == "reject") {
            submitTeamDecision(base, item, correction, decision, slot, org.json.JSONObject())
            return
        }
        val requestType = item.optString("type")
        val canAuthorizeDeduction = requestType in setOf(
            "LOAN", "CONSUMPTION", "ABSENCE_PERMISSION", "LATE_ARRIVAL", "SALARY_ADVANCE"
        )
        val authorizeDeduction = CheckBox(this).apply {
            text = "Autorizar descuento en nómina"
            textSize = 14f
        }
        val amount = EditText(this).apply {
            hint = "Cantidad a descontar en pesos (si aplica)"
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
            setSingleLine(true)
            isEnabled = false
        }
        authorizeDeduction.setOnCheckedChangeListener { _, checked -> amount.isEnabled = checked }
        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), dp(4))
            if (canAuthorizeDeduction) {
                addView(authorizeDeduction)
                addView(amount)
            } else {
                addView(text("Esta solicitud no permite descuentos de nómina.", 13, ink))
            }
        }
        AlertDialog.Builder(this).setTitle("APROBAR SOLICITUD")
            .setMessage("La aprobación no descuenta automáticamente. Solo puedes autorizar descuentos para préstamos, consumos, permisos, retardos y adelantos.")
            .setView(form)
            .setPositiveButton("APROBAR") { _, _ ->
                val details = org.json.JSONObject()
                if (canAuthorizeDeduction) {
                    val deduction = org.json.JSONObject().put("authorized", authorizeDeduction.isChecked)
                    if (authorizeDeduction.isChecked) {
                        val value = amount.text.toString().trim().replace(",", ".").toDoubleOrNull()
                        if (value == null || value <= 0 || value > 1000000) {
                            Toast.makeText(this, "Captura una cantidad válida para el descuento", Toast.LENGTH_LONG).show()
                            return@setPositiveButton
                        }
                        val amountCents = Math.round(value * 100.0)
                        val requestedCents = item.optJSONObject("details")?.optLong("amountCents", 0L) ?: 0L
                        if (requestedCents > 0L && amountCents > requestedCents) {
                            Toast.makeText(this, "El descuento no puede superar la cantidad solicitada", Toast.LENGTH_LONG).show()
                            return@setPositiveButton
                        }
                        deduction.put("amountCents", amountCents)
                    }
                    details.put("deduction", deduction)
                }
                submitTeamDecision(base, item, correction, decision, slot, details)
            }
            .setNegativeButton("CANCELAR", null).show()
    }

    private fun submitTeamDecision(
        base: String,
        item: org.json.JSONObject,
        correction: Boolean,
        decision: String,
        slot: String,
        decisionDetails: org.json.JSONObject
    ) {
        Thread {
            try {
                val api = SenePatronApiClient(this, base)
                if (correction) api.decideCorrection(item.getString("requestId"), decision)
                else api.decideRequest(item.getString("requestId"), decision, decisionDetails)
                runOnUiThread {
                    Toast.makeText(this, if (decision == "approve") "Solicitud aprobada." else "Solicitud rechazada.", Toast.LENGTH_LONG).show()
                    if (slot == "VENTAS_1" || slot == "VENTAS_2") loadTeamInbox(slot, base)
                }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this, "No se pudo registrar la decisión: " + (e.message ?: "Error"), Toast.LENGTH_LONG).show() }
            }
        }.start()
    }

    private fun scheduleScreen(root: LinearLayout) {
        val prefs = getSharedPreferences("sene_patron_server", MODE_PRIVATE)
        val base = prefs.getString("server_base_url", null)
        val device = prefs.getString("device_id", null)
        if (base.isNullOrBlank() || device.isNullOrBlank()) {
            root.addView(info("SERVICIO NO ACTIVADO", "Conecta y activa SENE PATRÓN para administrar sueldo y consultar reportes."))
            root.addView(primaryButton("IR A CONEXIÓN") { currentPage = "connection"; render() })
            return
        }
        root.addView(info("SUELDO Y DÍA DE PAGO", "La configuración se guarda por separado para Equipo 1 y Equipo 2. El servidor valida la fecha de pago usando la hora de Ciudad de México."))
        gap(root, 9)
        root.addView(primaryButton("CONFIGURAR SUELDO · EQUIPO 1") { showPayrollSettings("VENTAS_1", base) })
        gap(root, 9)
        root.addView(primaryButton("CONFIGURAR SUELDO · EQUIPO 2") { showPayrollSettings("VENTAS_2", base) })
        gap(root, 14)
        root.addView(info("REPORTES RECIBIDOS", "Consulta por separado los cierres de turno y los reportes de nómina enviados por cada trabajador."))
        gap(root, 9)
        root.addView(primaryButton("REPORTES · EQUIPO 1") { showTeamReports("VENTAS_1", base) })
        gap(root, 9)
        root.addView(primaryButton("REPORTES · EQUIPO 2") { showTeamReports("VENTAS_2", base) })
        gap(root, 12)
        root.addView(primaryButton("RESUMEN PRELIMINAR DE NÓMINA · EQUIPO 1") { showPayrollCalculation("VENTAS_1", base) })
        gap(root, 9)
        root.addView(primaryButton("RESUMEN PRELIMINAR DE NÓMINA · EQUIPO 2") { showPayrollCalculation("VENTAS_2", base) })
    }

    private fun showPayrollCalculation(slot: String, base: String) {
        Thread {
            try {
                val api = SenePatronApiClient(this, base)
                val settings = api.payrollSettings().optJSONObject("settings")?.optJSONObject(slot)
                val reportInbox = api.reportsInbox(slot)
                val reports = reportInbox.optJSONArray("payrollReports") ?: org.json.JSONArray()
                val shiftReports = reportInbox.optJSONArray("shiftReports") ?: org.json.JSONArray()
                val latest = if (reports.length() > 0) reports.optJSONObject(0) else null
                val report = latest?.optJSONObject("report")
                // Las decisiones y cantidades vienen de D1, no del reporte enviado por el teléfono VENTAS.
                val requests = reportInbox.optJSONArray("payrollEntries") ?: org.json.JSONArray()
                val salaryCents = settings?.optLong("salaryCents", 0L) ?: 0L
                var deductions = 0L
                var approvedDeductions = 0
                val lines = StringBuilder()
                for (i in 0 until requests.length()) {
                    val item = requests.optJSONObject(i) ?: continue
                    if (item.optString("status") != "approved") continue
                    val deduction = item.optJSONObject("decisionDetails")?.optJSONObject("deduction") ?: continue
                    if (!deduction.optBoolean("authorized", false)) continue
                    val cents = deduction.optLong("amountCents", 0L)
                    if (cents <= 0L) continue
                    deductions += cents
                    approvedDeductions++
                    lines.append("\n• ").append(item.optString("type"))
                        .append(": $").append(String.format(java.util.Locale.US, "%.2f", cents / 100.0))
                }
                val net = salaryCents - deductions
                val message = buildString {
                    append("Equipo: ").append(slot).append("\n")
                    append("Trabajador: ").append(report?.optString("worker", "No registrado") ?: "Sin reporte")
                    append("\nFecha de reporte: ").append(latest?.optString("periodKey", "—") ?: "Sin reporte")
                    append("\nCierres de turno recibidos: ").append(shiftReports.length())
                    append("\nSueldo base configurado: $").append(String.format(java.util.Locale.US, "%.2f", salaryCents / 100.0))
                    append("\nDescuentos autorizados incluidos: $").append(String.format(java.util.Locale.US, "%.2f", deductions))
                    append("\nCantidad de descuentos: ").append(approvedDeductions)
                    append("\nTOTAL PRELIMINAR: $").append(String.format(java.util.Locale.US, "%.2f", net))
                    if (lines.isNotEmpty()) append("\n\nDetalle:").append(lines)
                    append("\n\nEste resumen usa únicamente los descuentos expresamente autorizados que llegaron en el reporte. Verifica el periodo y la asistencia antes de confirmar el pago.")
                }
                runOnUiThread {
                    AlertDialog.Builder(this).setTitle("RESUMEN PRELIMINAR · " + slot)
                        .setMessage(message).setPositiveButton("CERRAR", null).show()
                }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this, "No se pudo calcular el resumen: " + (e.message ?: "Error"), Toast.LENGTH_LONG).show() }
            }
        }.start()
    }

    private fun showPayrollSettings(slot: String, base: String) {
        Thread {
            try {
                val api = SenePatronApiClient(this, base)
                val all = api.payrollSettings().optJSONObject("settings") ?: org.json.JSONObject()
                val current = all.optJSONObject(slot)
                runOnUiThread {
                    val form = LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        setPadding(dp(20), dp(8), dp(20), dp(4))
                    }
                    val salary = EditText(this).apply {
                        hint = "Sueldo base en pesos"
                        inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
                        setSingleLine(true)
                        if (current != null) setText(String.format(java.util.Locale.US, "%.2f", current.optLong("salaryCents") / 100.0))
                    }
                    val day = EditText(this).apply {
                        hint = "Día fijo mensual (1 a 31, opcional)"
                        inputType = InputType.TYPE_CLASS_NUMBER
                        setSingleLine(true)
                        if (current != null && !current.isNull("paymentDay")) setText(current.optString("paymentDay"))
                    }
                    val extraDates = current?.optJSONArray("paymentDates") ?: org.json.JSONArray()
                    val dates = EditText(this).apply {
                        hint = "Fechas específicas: AAAA-MM-DD, separadas por coma"
                        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
                        minLines = 2
                        if (extraDates.length() > 0) {
                            val values = ArrayList<String>()
                            for (i in 0 until extraDates.length()) values.add(extraDates.optString(i))
                            setText(values.joinToString(", "))
                        }
                    }
                    form.addView(text("Sueldo base mensual", 13, ink, true))
                    form.addView(salary)
                    form.addView(text("Día fijo mensual (opcional)", 13, ink, true))
                    form.addView(day)
                    form.addView(text("O fechas específicas (opcional)", 13, ink, true))
                    form.addView(dates)
                    AlertDialog.Builder(this).setTitle(if (slot == "VENTAS_1") "NÓMINA · EQUIPO 1" else "NÓMINA · EQUIPO 2")
                        .setView(form)
                        .setMessage("Fechas adicionales configuradas: " + extraDates.length())
                        .setPositiveButton("GUARDAR") { _, _ ->
                            val amount = salary.text.toString().trim().replace(",", ".").toDoubleOrNull()
                            val dayText = day.text.toString().trim()
                            val paymentDay = if (dayText.isBlank()) null else dayText.toIntOrNull()
                            val selectedDates = dates.text.toString().split(",").map { it.trim() }.filter { it.isNotBlank() }
                            val dateArray = org.json.JSONArray()
                            selectedDates.forEach { dateArray.put(it) }
                            val invalidDay = dayText.isNotBlank() && (paymentDay == null || paymentDay !in 1..31)
                            if (amount == null || amount <= 0 || amount > 10000000 || invalidDay ||
                                (paymentDay == null && selectedDates.isEmpty())) {
                                Toast.makeText(this, "Captura sueldo y un día mensual válido o al menos una fecha específica", Toast.LENGTH_LONG).show()
                            } else {
                                Thread {
                                    try {
                                        api.savePayrollSettings(slot, Math.round(amount * 100.0), paymentDay, dateArray)
                                        runOnUiThread { Toast.makeText(this, "Configuración guardada para " + slot, Toast.LENGTH_LONG).show() }
                                    } catch (e: Exception) {
                                        runOnUiThread { Toast.makeText(this, "No se pudo guardar: " + (e.message ?: "Error"), Toast.LENGTH_LONG).show() }
                                    }
                                }.start()
                            }
                        }.setNegativeButton("CANCELAR", null).show()
                }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this, "No se pudo leer la nómina: " + (e.message ?: "Error"), Toast.LENGTH_LONG).show() }
            }
        }.start()
    }

    private fun showTeamReports(slot: String, base: String) {
        Thread {
            try {
                val result = SenePatronApiClient(this, base).reportsInbox(slot)
                val shifts = result.optJSONArray("shiftReports") ?: org.json.JSONArray()
                val payroll = result.optJSONArray("payrollReports") ?: org.json.JSONArray()
                val labels = ArrayList<String>()
                val details = ArrayList<String>()
                for (i in 0 until shifts.length()) {
                    val item = shifts.optJSONObject(i) ?: continue
                    labels.add("CIERRE DE TURNO · " + item.optString("shiftKey"))
                    details.add(item.optJSONObject("report")?.toString(2) ?: "{}")
                }
                for (i in 0 until payroll.length()) {
                    val item = payroll.optJSONObject(i) ?: continue
                    labels.add("NÓMINA · " + item.optString("periodKey"))
                    details.add(item.optJSONObject("report")?.toString(2) ?: "{}")
                }
                runOnUiThread {
                    val title = if (slot == "VENTAS_1") "REPORTES · EQUIPO 1" else "REPORTES · EQUIPO 2"
                    if (labels.isEmpty()) AlertDialog.Builder(this).setTitle(title)
                        .setMessage("Todavía no hay reportes recibidos.").setPositiveButton("CERRAR", null).show()
                    else AlertDialog.Builder(this).setTitle(title).setItems(labels.toTypedArray()) { _, index ->
                        AlertDialog.Builder(this).setTitle(labels[index]).setMessage(details[index])
                            .setPositiveButton("CERRAR", null).show()
                    }.setNegativeButton("CERRAR", null).show()
                }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this, "No se pudieron consultar reportes: " + (e.message ?: "Error"), Toast.LENGTH_LONG).show() }
            }
        }.start()
    }

    private fun header(root: LinearLayout, subtitle: String) {
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(13), dp(14), dp(13))
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR,
                intArrayOf(Color.rgb(15, 76, 137), Color.rgb(18, 137, 164), Color.rgb(17, 91, 148)))
                .apply { cornerRadius = dp(21).toFloat() }
            elevation = dp(4).toFloat()
        }
        val logoButton = FrameLayout(this).apply {
            background = rounded(Color.rgb(20, 102, 158), 15, Color.rgb(78, 190, 165))
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
            setImageBitmap(originalLogo())
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = "Logotipo original SENE azul y verde. Tocar para abrir el menú."
        }
        logoButton.addView(logo, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        top.addView(logoButton, LinearLayout.LayoutParams(dp(60), dp(60)))
        val brand = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), 0, 0, 0)
        }
        brand.addView(text("SENE / PATRÓN", 19, white, true).apply { letterSpacing = .04f })
        brand.addView(text("GESTIÓN INTELIGENTE", 10, Color.rgb(203, 239, 235), true).apply { letterSpacing = .12f })
        top.addView(brand, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(top, LinearLayout.LayoutParams(-1, -2))
        root.addView(View(this).apply { background = rounded(red, 3) },
            LinearLayout.LayoutParams(dp(42), dp(5)).apply { topMargin = dp(18); bottomMargin = dp(9) })
        root.addView(text(subtitle, 24, ink, true))
        root.addView(text("Todo bajo control.", 13, muted).apply { setPadding(0, 0, 0, dp(13)) })
    }

    // Muestra el logotipo original sin recolorear para conservar la identidad azul/verde de SENE.
    private fun originalLogo(): Bitmap =
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

    private fun kicker(value: String) = text(value, 10, red, true)
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
            intArrayOf(Color.rgb(24, 119, 190), Color.rgb(18, 151, 133)))
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
