package com.sene.patron

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

class MainActivity : Activity() {
    private val navy = Color.rgb(13, 27, 48)
    private val panel = Color.rgb(24, 43, 68)
    private val muted = Color.rgb(166, 183, 203)
    private val white = Color.WHITE
    private val teal = Color.rgb(49, 190, 173)
    private var currentPage = "home"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = navy
        window.navigationBarColor = navy
        render()
    }

    override fun onBackPressed() {
        if (currentPage != "home") {
            currentPage = "home"
            render()
        } else {
            super.onBackPressed()
        }
    }

    private fun render() {
        setContentView(if (currentPage == "home") homeScreen() else detailScreen(currentPage))
    }

    private fun homeScreen(): View {
        val root = pageRoot()
        header(root, "Panel de administración")
        val welcome = card()
        welcome.addView(label("BIENVENIDO", 11, teal, true))
        welcome.addView(label("Tu negocio, bajo control", 21, white, true))
        welcome.addView(label("Administra tus equipos y solicitudes desde un solo lugar.", 14, muted, false))
        root.addView(welcome)
        root.addView(space(18))

        root.addView(sectionTitle("LICENCIA Y EQUIPOS"))
        val license = card()
        license.addView(row("Espacios de la licencia", "0 de 3 vinculados", white, teal))
        license.addView(space(12))
        license.addView(slot("SENE PATRÓN", "Dispositivo principal", "Este equipo"))
        license.addView(space(10))
        license.addView(slot("SENE VENTAS · EQUIPO 1", "Primer dispositivo de ventas", "Pendiente"))
        license.addView(space(10))
        license.addView(slot("SENE VENTAS · EQUIPO 2", "Segundo dispositivo de ventas", "Pendiente"))
        root.addView(license)
        root.addView(space(20))

        root.addView(sectionTitle("ADMINISTRACIÓN"))
        val admin = card()
        menuItem(admin, "Vinculación de equipos", "Revisar solicitudes para autorizar o rechazar dispositivos", "devices")
        admin.addView(separator())
        menuItem(admin, "Solicitudes operativas", "Consultar solicitudes que requieren tu autorización", "requests")
        admin.addView(separator())
        menuItem(admin, "Horarios y asistencia", "Administrar consultas de horarios de tus equipos", "schedule")
        admin.addView(separator())
        menuItem(admin, "Seguridad de dispositivos", "Bloqueo y sustitución de equipos autorizados", "security")
        root.addView(admin)
        root.addView(space(20))

        val note = card()
        note.addView(label("ESTADO DE CONEXIÓN", 11, muted, true))
        note.addView(label("Configuración inicial", 16, white, true))
        note.addView(label("Firebase aún no está conectado. Esta versión no autoriza equipos ni modifica licencias.", 13, muted, false))
        root.addView(note)
        root.addView(space(18))
        root.addView(label("SENE PATRÓN · Versión 0.2.0", 11, muted, false).apply { gravity = Gravity.CENTER })
        return root
    }

    private fun detailScreen(page: String): View {
        val root = pageRoot()
        val title = when (page) {
            "devices" -> "Vinculación de equipos"
            "requests" -> "Solicitudes operativas"
            "schedule" -> "Horarios y asistencia"
            "security" -> "Seguridad de dispositivos"
            else -> "Administración"
        }
        header(root, title)
        val intro = card()
        intro.addView(label(when (page) {
            "devices" -> "DOS ESPACIOS SENE VENTAS"
            "requests" -> "CENTRO DE AUTORIZACIONES"
            "schedule" -> "CONTROL DE EQUIPOS"
            "security" -> "PROTECCIÓN DE LA LICENCIA"
            else -> "SENE PATRÓN"
        }, 11, teal, true))
        intro.addView(label(when (page) {
            "devices" -> "Equipo 1 y Equipo 2"
            "requests" -> "Solicitudes pendientes"
            "schedule" -> "Horarios y asistencia"
            "security" -> "Bloqueo y sustitución"
            else -> "Administración"
        }, 20, white, true))
        intro.addView(label(when (page) {
            "devices" -> "Cada espacio requiere una solicitud de vinculación y autorización válida del propietario."
            "requests" -> "Aquí aparecerán las solicitudes que requieran una decisión del propietario."
            "schedule" -> "Aquí se consultarán horarios y registros disponibles de los equipos autorizados."
            "security" -> "La pérdida o sustitución de un teléfono deberá validarse con autorización segura."
            else -> "Funciones administrativas de la licencia."
        }, 14, muted, false))
        root.addView(intro)
        root.addView(space(16))

        when (page) {
            "devices" -> {
                root.addView(sectionTitle("ESTADO DE LOS ESPACIOS"))
                root.addView(infoCard("SENE VENTAS · EQUIPO 1", "Sin dispositivo vinculado", "La solicitud de alta aparecerá aquí cuando SENE VENTAS la envíe."))
                root.addView(space(10))
                root.addView(infoCard("SENE VENTAS · EQUIPO 2", "Sin dispositivo vinculado", "Este espacio permanece reservado para el segundo equipo."))
            }
            "requests" -> root.addView(infoCard("BANDEJA DE SOLICITUDES", "Sin conexión al servidor", "No se pueden consultar solicitudes reales hasta integrar autenticación y backend."))
            "schedule" -> root.addView(infoCard("CONSULTA DE HORARIOS", "Aún no hay datos", "Los horarios no se inventan ni se sincronizan hasta definir el mecanismo autorizado con SENE VENTAS."))
            "security" -> {
                root.addView(infoCard("BLOQUEO DE EQUIPO", "Acción todavía deshabilitada", "El bloqueo real debe ejecutarse en el servidor y dejar registro de auditoría."))
                root.addView(space(10))
                root.addView(infoCard("SUSTITUCIÓN DE TELÉFONO", "Requiere autorización", "Un teléfono nuevo no debe ocupar un espacio adicional ni reemplazar al anterior por sí solo."))
            }
        }
        root.addView(space(18))
        val warning = card()
        warning.addView(label("MODO DE DESARROLLO", 11, teal, true))
        warning.addView(label("Esta pantalla es navegación funcional de la interfaz. No realiza cambios en Firebase, licencias ni dispositivos.", 13, muted, false))
        root.addView(warning)
        root.addView(space(18))
        root.addView(actionButton("Volver al panel principal") {
            currentPage = "home"
            render()
        })
        return root
    }

    private fun pageRoot(): LinearLayout {
        val scroll = ScrollView(this).apply {
            setBackgroundColor(navy)
            isFillViewport = true
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(28))
        }
        scroll.addView(root)
        // Return a scroll container while retaining the page content.
        root.tag = scroll
        return root.also { scrollRoot = scroll }
    }

    private var scrollRoot: ScrollView? = null

    private fun header(root: LinearLayout, subtitle: String) {
        root.addView(label("SENE", 15, teal, true))
        root.addView(label("PATRÓN", 30, white, true))
        root.addView(label(subtitle, 14, muted, false))
        root.addView(space(22))
    }

    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(16), dp(16), dp(16))
        background = rounded(panel, 18)
    }

    private fun infoCard(title: String, status: String, description: String): LinearLayout = card().apply {
        addView(label(title, 12, teal, true))
        addView(label(status, 17, white, true))
        addView(label(description, 13, muted, false))
    }

    private fun label(text: String, size: Int, color: Int, bold: Boolean) = TextView(this).apply {
        this.text = text
        textSize = size.toFloat()
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(3), 0, dp(3))
    }

    private fun sectionTitle(text: String) = label(text, 12, muted, true).apply {
        setPadding(dp(2), 0, 0, dp(10))
    }

    private fun row(left: String, right: String, leftColor: Int, rightColor: Int) =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(label(left, 14, leftColor, true), LinearLayout.LayoutParams(0, -2, 1f))
            addView(label(right, 12, rightColor, true))
        }

    private fun slot(name: String, description: String, state: String) =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(9), dp(12), dp(9))
            background = rounded(Color.rgb(32, 55, 82), 12)
            addView(row(name, state, white, if (state == "Este equipo") teal else muted))
            addView(label(description, 12, muted, false))
        }

    private fun menuItem(parent: LinearLayout, title: String, description: String, destination: String) {
        val item = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(12), 0, dp(12))
            isClickable = true
            isFocusable = true
            addView(label(title, 15, white, true))
            addView(label(description, 12, muted, false))
            setOnClickListener {
                currentPage = destination
                render()
            }
        }
        parent.addView(item)
    }

    private fun actionButton(text: String, action: () -> Unit) = TextView(this).apply {
        this.text = text
        textSize = 15f
        setTextColor(white)
        gravity = Gravity.CENTER
        setPadding(dp(16), dp(14), dp(16), dp(14))
        background = rounded(Color.rgb(35, 126, 125), 14)
        isClickable = true
        isFocusable = true
        setOnClickListener { action() }
    }

    private fun separator() = View(this).apply {
        setBackgroundColor(Color.rgb(49, 69, 91))
        layoutParams = LinearLayout.LayoutParams(-1, dp(1))
    }

    private fun space(height: Int) = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(1, dp(height))
    }

    private fun rounded(color: Int, radius: Int) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius).toFloat()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
