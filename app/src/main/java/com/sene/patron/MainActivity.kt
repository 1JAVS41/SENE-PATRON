package com.sene.patron

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.text.InputType
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
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
        summary.addView(horizontal("Dispositivos SENE VENTAS", "0 de 2 vinculados", ink, red))
        summary.addView(text("La licencia contempla 1 equipo SENE PATRÓN y hasta 2 equipos SENE VENTAS.", 13, muted))
        root.addView(summary)
        gap(root, 12)

        val status = card()
        status.addView(horizontal("Administración", "EN PREPARACIÓN", ink, red))
        status.addView(text("La interfaz está lista para revisión. La conexión segura con el servidor SENE aún está pendiente; por ahora no se autorizan equipos ni se modifican datos reales.", 12, muted))
        root.addView(status)
        gap(root, 12)
        root.addView(primaryButton("CONECTAR / ACTIVAR LICENCIA") { currentPage = "connection"; render() })
        gap(root, 16)
        root.addView(text("Toca el logotipo para abrir el menú de administración.", 12, muted)
            .apply { gravity = Gravity.CENTER; setPadding(dp(8), dp(8), dp(8), dp(8)) })
        gap(root, 10)
        root.addView(text("SENE PATRÓN  ·  Versión 0.5.0", 11, muted)
            .apply { gravity = Gravity.CENTER })
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
        val fields = card()
        fields.addView(kicker("SERVIDOR OFICIAL SENE"))
        fields.addView(text("Dirección HTTPS del Worker", 13, ink, true))
        fields.addView(base)
        fields.addView(text("Código de activación", 13, ink, true))
        fields.addView(code)
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
            "devices" -> {
                root.addView(slot("SENE VENTAS · EQUIPO 1", "Primer espacio de trabajador", "DISPONIBLE"))
                gap(root, 9)
                root.addView(slot("SENE VENTAS · EQUIPO 2", "Segundo espacio de trabajador", "DISPONIBLE"))
                gap(root, 9)
                root.addView(info("REGLA DE LICENCIA",
                    "Máximo tres dispositivos: un SENE PATRÓN y dos SENE VENTAS. Ningún equipo se autoriza por sí mismo."))
            }
            "requests" -> root.addView(info("BANDEJA DE SOLICITUDES",
                "Aquí aparecerán las solicitudes pendientes de autorización cuando se conecte el servicio."))
            "schedule" -> root.addView(info("HORARIOS Y ASISTENCIA",
                "Los datos se mostrarán cuando exista una conexión autorizada con los equipos SENE VENTAS."))
            "security" -> {
                root.addView(info("BLOQUEO DE DISPOSITIVOS",
                    "El bloqueo real deberá validarse en el servidor y conservar un registro de auditoría."))
                gap(root, 9)
                root.addView(info("SUSTITUCIÓN DE TELÉFONO",
                    "La sustitución requiere autorización del titular de la plataforma y conserva el espacio de licencia."))
            }
        }
        gap(root, 12)
        root.addView(info("MODO DE PREPARACIÓN",
            "Esta versión muestra la interfaz y navegación. Todavía no se conecta al servidor SENE ni autoriza dispositivos."))
        gap(root, 12)
        root.addView(primaryButton("VOLVER AL MENÚ") { currentPage = "menu"; render() })
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
