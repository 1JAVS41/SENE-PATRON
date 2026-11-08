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
    private val red = Color.rgb(190, 35, 48)
    private val redDark = Color.rgb(111, 13, 29)
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
            overScrollMode = View.OVER_SCROLL_ALWAYS
            clipToPadding = false
        }
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(12), dp(18), dp(88))
        }
        scroll.addView(page)
        when (currentPage) {
            "home" -> homeScreen(page)
            "menu" -> menuScreen(page)
            else -> detailScreen(page, currentPage)
        }
        setContentView(scroll)
        // Cada navegación comienza arriba y deja margen inferior suficiente
        // para poder deslizar el contenido hacia arriba en pantallas pequeñas.
        scroll.post { scroll.scrollTo(0, 0) }
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
        summary.addView(horizontal("Dispositivos SENE VENTAS", "0 de 2 vinculados", ink, red))
        summary.addView(text("La licencia contempla 1 equipo SENE PATRÓN y hasta 2 equipos SENE VENTAS.", 13, muted))
        root.addView(summary)
        gap(root, 12)

        val status = card()
        status.addView(horizontal("Administración", "EN PREPARACIÓN", ink, red))
        status.addView(text("La interfaz está lista para revisión. La conexión con Firebase aún está pendiente; por ahora no se autorizan equipos ni se modifican datos reales.", 12, muted))
        root.addView(status)
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
        addView(horizontal(title, "ABRIR  ›", ink, red))
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
            Triple("Solicitudes operativas", "Correcciones de ventas y solicitudes que requieren tu autorización", "requests"),
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
        addView(horizontal(title, "›", ink, red))
        addView(text(description, 12, muted))
        setOnClickListener { currentPage = destination; render() }
    }

    private fun notificationCard(number: String) = card().apply {
        addView(horizontal("NOTIFICACIONES · EQUIPO $number", "●", ink, red))
        gap(this, 4)
        addView(text("Aquí aparecerán exclusivamente los avisos, solicitudes y cambios de este equipo.", 12, muted))
        addView(text("Pendientes: se mostrarán al conectar Firebase", 11, red, true))
    }

    private fun detailScreen(root: LinearLayout, page: String) {
        val title = when (page) {
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
            "Esta versión muestra la interfaz y navegación. Todavía no realiza cambios en Firebase ni autoriza dispositivos."))
        gap(root, 12)
        root.addView(primaryButton("VOLVER AL MENÚ") { currentPage = "menu"; render() })
    }

    private fun header(root: LinearLayout, subtitle: String) {
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(13), dp(14), dp(13))
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR,
                intArrayOf(Color.rgb(72, 12, 27), Color.rgb(157, 25, 43), Color.rgb(91, 13, 29)))
                .apply { cornerRadius = dp(21).toFloat() }
            elevation = dp(4).toFloat()
        }
        val logoButton = FrameLayout(this).apply {
            background = rounded(Color.rgb(120, 18, 35), 15, Color.rgb(218, 92, 105))
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
            contentDescription = "Logotipo SENE PATRÓN rojo. Tocar para abrir el menú."
        }
        logoButton.addView(logo, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        top.addView(logoButton, LinearLayout.LayoutParams(dp(60), dp(60)))
        val brand = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), 0, 0, 0)
        }
        brand.addView(text("SENE / PATRÓN", 19, white, true).apply { letterSpacing = .04f })
        brand.addView(text("GESTIÓN INTELIGENTE", 10, Color.rgb(255, 210, 215), true).apply { letterSpacing = .12f })
        top.addView(brand, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(top, LinearLayout.LayoutParams(-1, -2))
        root.addView(View(this).apply { background = rounded(red, 3) },
            LinearLayout.LayoutParams(dp(42), dp(5)).apply { topMargin = dp(18); bottomMargin = dp(9) })
        root.addView(text(subtitle, 24, ink, true))
        root.addView(text("Todo bajo control.", 13, muted).apply { setPadding(0, 0, 0, dp(13)) })
    }

    // Conserva el diseño original del logotipo y transforma sus colores azul/verde a rojo.
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
                if (a > 0 && maxOf(r, g, b) - minOf(r, g, b) > 28) {
                    val luminance = (0.299 * r + 0.587 * g + 0.114 * b).toInt()
                    val redValue = (82 + luminance * 0.66).toInt().coerceIn(0, 255)
                    result.setPixel(x, y, Color.argb(a, redValue, 8, 22))
                }
            }
        }
        return result
    }

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
            intArrayOf(Color.rgb(190, 35, 48), Color.rgb(116, 15, 31)))
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
