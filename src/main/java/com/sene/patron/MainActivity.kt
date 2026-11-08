package com.sene.patron

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.graphics.RectF
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.animation.ValueAnimator
import android.view.animation.LinearInterpolator
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
            setPadding(dp(18), dp(30), dp(18), dp(88))
        }
        scroll.addView(page)
        when (currentPage) {
            "home" -> homeScreen(page)
            "menu" -> menuScreen(page)
            "team1", "team2" -> teamScreen(page, currentPage)
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
        gap(root, 14)

        // Contacto del titular: los datos se muestran solo cuando el usuario pulsa el botón.
        root.addView(primaryButton("¿NECESITAS AYUDA?") { showContactDialog() })
        gap(root, 7)
        root.addView(text(
            "Si perdiste un equipo, comunícate para obtener una nueva app y su vinculación.",
            12, muted
        ).apply { gravity = Gravity.CENTER; setPadding(dp(8), dp(3), dp(8), dp(3)) })
        gap(root, 14)

        // Aviso luminoso: texto animado más rápido y un destello blanco que recorre
        // continuamente los cuatro lados del contorno.
        val warningFrame = FrameLayout(this).apply {
            setPadding(dp(2), dp(2), dp(2), dp(2))
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
        warningFrame.addView(warningBox, FrameLayout.LayoutParams(-1, -2))
        warningFrame.addView(BorderRunnerView(this), FrameLayout.LayoutParams(-1, -1))
        root.addView(warningFrame, LinearLayout.LayoutParams(-1, -2))
        gap(root, 16)
        root.addView(text("Toca el logotipo para abrir el menú de administración.", 12, muted)
            .apply { gravity = Gravity.CENTER; setPadding(dp(8), dp(8), dp(8), dp(8)) })
        gap(root, 10)
        root.addView(text("SENE PATRÓN  ·  Versión 0.5.0", 11, muted)
            .apply { gravity = Gravity.CENTER })
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
        addView(horizontal(title, if (count > 0) "● $count ALERTA(S)" else "ABRIR  ›", ink,
            if (count > 0) Color.rgb(210, 20, 35) else red))
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
        val team = if (destination.startsWith("team1_")) "team1" else "team2"
        val section = destination.substringAfter("_")
        val count = pendingAlertCount(team, section)
        addView(horizontal(title, if (count > 0) "● $count NUEVA(S)" else "›", ink,
            if (count > 0) Color.rgb(210, 20, 35) else red))
        addView(text(description, 12, muted))
        setOnClickListener { currentPage = destination; render() }
    }

    // Contadores preparados para enlazarse a las notificaciones reales de Firebase.
    // Permanecen en cero mientras el servicio remoto no esté conectado.
    private fun pendingAlertCount(team: String, section: String? = null): Int = 0

    private fun notificationCard(number: String) = card().apply {
        addView(horizontal("NOTIFICACIONES · EQUIPO $number", "●", ink, red))
        gap(this, 4)
        addView(text("Aquí aparecerán exclusivamente los avisos, solicitudes y cambios de este equipo.", 12, muted))
        addView(text("Pendientes: se mostrarán al conectar Firebase", 11, red, true))
    }

    private fun detailScreen(root: LinearLayout, page: String) {
        val teamNumber = if (page.startsWith("team1_")) "1" else "2"
        val section = page.substringAfter("_")
        val teamHome = if (teamNumber == "1") "team1" else "team2"
        val title = when (section) {
            "schedule" -> "Horarios y asistencias"
            "requests" -> "Solicitudes operativas"
            "security" -> "Seguridad del dispositivo"
            else -> "Vinculación del equipo"
        }
        header(root, title)
        val intro = card()
        intro.addView(kicker("SENE VENTAS · EQUIPO $teamNumber"))
        intro.addView(text(title, 21, ink, true))
        intro.addView(text(when (section) {
            "schedule" -> "Consulta los horarios, entradas, salidas y asistencias registrados por el Equipo $teamNumber."
            "requests" -> "Revisa y autoriza únicamente las solicitudes enviadas desde el Equipo $teamNumber."
            "security" -> "Consulta la seguridad y los eventos del dispositivo asignado al Equipo $teamNumber."
            else -> "Consulta el vínculo y la identidad del dispositivo correspondiente al Equipo $teamNumber."
        }, 14, muted))
        root.addView(intro)
        gap(root, 11)
        root.addView(notificationCard(teamNumber))
        gap(root, 11)
        when (section) {
            "schedule" -> root.addView(info("REGISTROS · EQUIPO $teamNumber",
                "Los horarios y asistencias de este equipo aparecerán aquí, separados por trabajador y fecha."))
            "requests" -> root.addView(info("BANDEJA · EQUIPO $teamNumber",
                "Aquí se mostrarán las solicitudes pendientes y su historial. Las autorizaciones deberán ser individuales y de un solo uso cuando corresponda."))
            "security" -> {
                root.addView(info("ESTADO DEL DISPOSITIVO · EQUIPO $teamNumber",
                    "Los avisos de seguridad, bloqueos e incidencias se mostrarán solo para este equipo."))
                gap(root, 9)
                root.addView(info("SUSTITUCIÓN DE TELÉFONO",
                    "La solicitud de sustitución conservará el espacio de licencia del Equipo $teamNumber y requerirá validación del titular."))
            }
            else -> root.addView(info("VÍNCULO · EQUIPO $teamNumber",
                "Aquí se mostrará la identidad local, el estado de vinculación y la fecha de registro de este dispositivo."))
        }
        gap(root, 11)
        root.addView(info("ESTADO DE CONEXIÓN",
            "La pantalla ya separa la información por equipo. Las notificaciones y los datos reales se activarán al conectar Firebase; esta versión no inventa avisos ni modifica registros."))
        gap(root, 12)
        root.addView(primaryButton("VOLVER A EQUIPO $teamNumber") { currentPage = teamHome; render() })
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

/** Texto continuo de derecha a izquierda con velocidad controlada. */
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
            duration = ((distance / (155f * resources.displayMetrics.density)) * 1000f)
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

/** Destello blanco que recorre el perímetro redondeado del rectángulo. */
private class BorderRunnerView(context: android.content.Context) : View(context) {
    private val density = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2.2f * density
        color = Color.WHITE
        strokeCap = Paint.Cap.ROUND
        setShadowLayer(5f * density, 0f, 0f, Color.WHITE)
    }
    private val border = Path()
    private val measure = PathMeasure()
    private var progress = 0f
    private var animator: ValueAnimator? = null

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        border.reset()
        val inset = 2.5f * density
        border.addRoundRect(RectF(inset, inset, w - inset, h - inset),
            15f * density, 15f * density, Path.Direction.CW)
        measure.setPath(border, false)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val length = measure.length
        if (length <= 0f) return
        val start = progress * length
        val segment = length * .22f
        val end = start + segment
        val highlight = Path()
        if (end <= length) {
            measure.getSegment(start, end, highlight, true)
        } else {
            measure.getSegment(start, length, highlight, true)
            measure.getSegment(0f, end - length, highlight, true)
        }
        canvas.drawPath(highlight, paint)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        animator?.cancel()
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 2600L
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
