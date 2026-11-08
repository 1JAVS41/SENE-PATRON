package com.sene.patron

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

class MainActivity : Activity() {
    private val bg = Color.rgb(244, 245, 250)
    private val ink = Color.rgb(23, 33, 61)
    private val muted = Color.rgb(111, 121, 145)
    private val blue = Color.rgb(38, 59, 112)
    private val green = Color.rgb(22, 139, 69)
    private val red = Color.rgb(190, 35, 48)
    private val white = Color.WHITE
    private var currentPage = "home"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = bg
        window.navigationBarColor = bg
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }
        render()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (currentPage != "home") { currentPage = "home"; render() } else super.onBackPressed()
    }

    private fun render() {
        val scroll = ScrollView(this).apply {
            setBackgroundColor(bg)
            isFillViewport = true
            isSmoothScrollingEnabled = true
            isVerticalScrollBarEnabled = false
            clipToPadding = false
            descendantFocusability = ViewGroupFocus.AFTER_DESCENDANTS
        }
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(30))
        }
        scroll.addView(page)
        when (currentPage) {
            "home" -> homeScreen(page)
            "menu" -> menuScreen(page)
            else -> detailScreen(page, currentPage)
        }
        setContentView(scroll)
    }

    private object ViewGroupFocus { const val AFTER_DESCENDANTS = 0x20000 }

    private fun homeScreen(root: LinearLayout) {
        header(root, "Panel principal")
        val welcome = card()
        welcome.addView(kicker("SENE PATRÓN"))
        welcome.addView(text("Tu negocio, bajo control.", 22, ink, true))
        welcome.addView(text("Administra desde aquí los equipos y las solicitudes de tu licencia.", 14, muted))
        root.addView(welcome)
        gap(root, 13)

        val license = card()
        license.addView(kicker("TU LICENCIA"))
        license.addView(horizontal("Dispositivos registrados", "3 espacios", ink, green))
        gap(license, 8)
        license.addView(text("1 SENE PATRÓN  ·  2 SENE VENTAS", 14, blue, true))
        license.addView(text("La licencia contempla un equipo principal y dos equipos de trabajadores.", 12, muted))
        root.addView(license)
        gap(root, 13)

        val status = card()
        status.addView(horizontal("Estado de administración", "Preparación", ink, red))
        status.addView(text("Las funciones y pantallas están disponibles para revisión. La conexión real con Firebase aún está pendiente.", 12, muted))
        root.addView(status)
        gap(root, 18)
        root.addView(primaryButton("ABRIR MENÚ DE ADMINISTRACIÓN") {
            currentPage = "menu"
            render()
        })
        gap(root, 12)
        root.addView(text("Toca el logotipo rojo para abrir el menú desde cualquier pantalla.", 12, muted).apply { gravity = Gravity.CENTER })
        gap(root, 12)
        root.addView(text("SENE PATRÓN  ·  Versión 0.4.0", 11, muted).apply { gravity = Gravity.CENTER })
    }

    private fun menuScreen(root: LinearLayout) {
        header(root, "Menú de administración")
        val intro = card()
        intro.addView(kicker("HERRAMIENTAS DEL TITULAR"))
        intro.addView(text("¿Qué deseas administrar?", 20, ink, true))
        intro.addView(text("Selecciona una sección. Puedes volver a este menú tocando el logotipo rojo.", 13, muted))
        root.addView(intro)
        gap(root, 16)
        val actions = listOf(
            Triple("Vinculación de equipos", "Administra los dos espacios SENE VENTAS de tu licencia", "devices"),
            Triple("Solicitudes operativas", "Revisa solicitudes que requieren autorización del patrón", "requests"),
            Triple("Horarios y asistencia", "Consulta horarios y actividad de los equipos", "schedule"),
            Triple("Seguridad de dispositivos", "Consulta bloqueos y procesos de sustitución", "security")
        )
        actions.forEachIndexed { i, item ->
            root.addView(menuCard(item.first, item.second, item.third))
            if (i != actions.lastIndex) gap(root, 10)
        }
        gap(root, 16)
        root.addView(info("LICENCIA SENE · 3 ESPACIOS", "Un dispositivo SENE PATRÓN y exactamente dos dispositivos SENE VENTAS."))
        gap(root, 10)
        root.addView(primaryButton("VOLVER AL PANEL PRINCIPAL") { currentPage = "home"; render() })
    }

    private fun detailScreen(root: LinearLayout, page: String) {
        val title = when(page) {
            "devices" -> "Vinculación de equipos"
            "requests" -> "Solicitudes operativas"
            "schedule" -> "Horarios y asistencia"
            else -> "Seguridad de dispositivos"
        }
        header(root, title)
        val intro = card()
        intro.addView(kicker("ADMINISTRACIÓN SENE"))
        intro.addView(text(title, 21, ink, true))
        intro.addView(text(when(page) {
            "devices" -> "Tu licencia contempla un dispositivo SENE PATRÓN y exactamente dos espacios SENE VENTAS."
            "requests" -> "Centro donde el titular revisará y resolverá solicitudes de sus equipos."
            "schedule" -> "Consulta administrativa de horarios y asistencia de los equipos autorizados."
            else -> "Protección de los dispositivos vinculados a la licencia y control de sustituciones."
        }, 14, muted))
        root.addView(intro)
        gap(root, 14)
        when(page) {
            "devices" -> {
                root.addView(slot("SENE VENTAS · EQUIPO 1", "Primer espacio de trabajador", "DISPONIBLE", false))
                gap(root, 10)
                root.addView(slot("SENE VENTAS · EQUIPO 2", "Segundo espacio de trabajador", "DISPONIBLE", false))
                gap(root, 10)
                root.addView(info("REGLA DE LICENCIA", "Máximo tres dispositivos: un SENE PATRÓN y dos SENE VENTAS. Ningún equipo se autoriza por sí mismo."))
            }
            "requests" -> root.addView(info("BANDEJA DE SOLICITUDES", "Aquí aparecerán las solicitudes pendientes de autorización cuando se conecte el servicio."))
            "schedule" -> root.addView(info("HORARIOS Y ASISTENCIA", "Los datos se mostrarán cuando exista una conexión autorizada con los equipos SENE VENTAS."))
            "security" -> {
                root.addView(info("BLOQUEO DE DISPOSITIVOS", "El bloqueo real deberá validarse en el servidor y conservar un registro de auditoría."))
                gap(root, 10)
                root.addView(info("SUSTITUCIÓN DE TELÉFONO", "La sustitución requiere autorización del titular de la plataforma y conserva el espacio de licencia."))
            }
        }
        gap(root, 14)
        val note = card()
        note.addView(kicker("MODO DE PREPARACIÓN"))
        note.addView(text("Esta versión muestra la interfaz y navegación. Todavía no realiza cambios en Firebase ni autoriza dispositivos.", 13, muted))
        root.addView(note)
        gap(root, 18)
        root.addView(primaryButton("VOLVER AL MENÚ") { currentPage = "menu"; render() })
    }

    private fun header(root: LinearLayout, subtitle: String) {
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(15), dp(15), dp(15), dp(15))
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(Color.rgb(17,26,53), Color.rgb(38,59,112))).apply { cornerRadius = dp(22).toFloat() }
            elevation = dp(4).toFloat()
        }
        val frame = FrameLayout(this).apply {
            background = rounded(Color.rgb(112,30,43), 16)
            setPadding(dp(5), dp(5), dp(5), dp(5))
            isClickable = true
            isFocusable = true
            contentDescription = "Abrir menú SENE PATRÓN"
            setOnClickListener {
                currentPage = if (currentPage == "menu") "home" else "menu"
                render()
            }
        }
        val logo = ImageView(this).apply {
            setImageBitmap(redLogo())
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = "Logotipo rojo SENE PATRÓN. Tocar para abrir el menú."
        }
        frame.addView(logo, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        top.addView(frame, LinearLayout.LayoutParams(dp(62), dp(62)))
        val brand = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(13), 0, 0, 0)
        }
        brand.addView(text("SENE / PATRÓN", 19, white, true).apply { letterSpacing = .05f })
        brand.addView(text("GESTIÓN INTELIGENTE", 10, Color.rgb(185,201,248), true).apply { letterSpacing = .13f })
        top.addView(brand, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(top, LinearLayout.LayoutParams(-1, -2))
        val accent = View(this).apply { background = rounded(red, 3) }
        root.addView(accent, LinearLayout.LayoutParams(dp(42), dp(5)).apply { topMargin = dp(22); bottomMargin = dp(10) })
        root.addView(text(subtitle, 26, ink, true))
        root.addView(text("Todo bajo control.", 13, muted).apply { setPadding(0, 0, 0, dp(16)) })
    }

    // Recolorea únicamente las zonas originales azul/verde del logotipo; conserva el fondo y el chip.
    private fun redLogo(): Bitmap {
        val source = android.graphics.BitmapFactory.decodeResource(resources, R.drawable.logo_sene_pv)
        val result = source.copy(Bitmap.Config.ARGB_8888, true)
        for (y in 0 until result.height) {
            for (x in 0 until result.width) {
                val pixel = result.getPixel(x, y)
                val a = Color.alpha(pixel)
                val r = Color.red(pixel)
                val g = Color.green(pixel)
                val b = Color.blue(pixel)
                val high = maxOf(r, g, b)
                val low = minOf(r, g, b)
                if (a > 0 && high - low > 28) {
                    val luminance = (0.299 * r + 0.587 * g + 0.114 * b).toInt()
                    val redValue = (82 + luminance * 0.66).coerceIn(0, 255)
                    result.setPixel(x, y, Color.argb(a, redValue, 8, 22))
                }
            }
        }
        return result
    }

    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(15), dp(16), dp(15))
        background = rounded(white, 17, Color.rgb(226,230,240))
        elevation = dp(1).toFloat()
    }

    private fun info(title: String, body: String) = card().apply {
        addView(kicker(title))
        addView(text(body, 14, muted))
    }

    private fun slot(name: String, description: String, state: String, active: Boolean) = card().apply {
        addView(horizontal(name, state, ink, if(active) green else blue))
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
            addView(text(right, 11, rightColor, true))
        }

    private fun section(value: String) = text(value, 12, muted, true).apply { setPadding(dp(2), 0, 0, dp(9)) }
    private fun kicker(value: String) = text(value, 10, red, true).apply { letterSpacing = .1f; setPadding(0, 0, 0, dp(5)) }

    private fun text(value: String, size: Int, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = value
        textSize = size.toFloat()
        setTextColor(color)
        typeface = Typeface.create("sans-serif", if(bold) Typeface.BOLD else Typeface.NORMAL)
        setPadding(0, dp(3), 0, dp(3))
        setLineSpacing(dp(2).toFloat(), 1f)
    }

    private fun primaryButton(value: String, action: () -> Unit) = TextView(this).apply {
        text = value
        textSize = 14f
        typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER
        setTextColor(white)
        setPadding(dp(16), dp(16), dp(16), dp(16))
        background = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, intArrayOf(Color.rgb(67,95,173), Color.rgb(40,61,120))).apply { cornerRadius = dp(14).toFloat() }
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
