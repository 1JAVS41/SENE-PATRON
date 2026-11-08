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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = navy
        window.navigationBarColor = navy
        window.decorView.systemUiVisibility = 0
        setContentView(buildScreen())
    }

    private fun buildScreen(): View {
        val scroll = ScrollView(this).apply {
            setBackgroundColor(navy)
            isFillViewport = true
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(28))
        }
        scroll.addView(root)

        root.addView(label("SENE", 15, teal, true))
        root.addView(label("PATRÓN", 30, white, true).apply {
            setPadding(0, 0, 0, dp(4))
        })
        root.addView(label("Panel de administración", 14, muted, false))
        root.addView(space(22))

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
        admin.addView(action("Vinculación de equipos", "Revisar solicitudes para autorizar o rechazar dispositivos"))
        admin.addView(separator())
        admin.addView(action("Solicitudes operativas", "Consultar solicitudes que requieren tu autorización"))
        admin.addView(separator())
        admin.addView(action("Horarios y asistencia", "Administrar consultas de horarios de tus equipos"))
        admin.addView(separator())
        admin.addView(action("Seguridad de dispositivos", "Bloqueo y sustitución de equipos autorizados"))
        root.addView(admin)
        root.addView(space(20))

        val note = card()
        note.addView(label("ESTADO DE CONEXIÓN", 11, muted, true))
        note.addView(label("Configuración inicial", 16, white, true))
        note.addView(label("La vinculación con Firebase todavía no está activa. Esta pantalla es la base visual; no autoriza equipos ni modifica licencias.", 13, muted, false))
        root.addView(note)
        root.addView(space(18))
        root.addView(label("SENE PATRÓN · Versión 0.1.0", 11, muted, false).apply {
            gravity = Gravity.CENTER
        })
        return scroll
    }

    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(16), dp(16), dp(16))
        background = rounded(panel, 18)
    }

    private fun label(text: String, size: Int, color: Int, bold: Boolean): TextView =
        TextView(this).apply {
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

    private fun slot(name: String, description: String, state: String): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(9), dp(12), dp(9))
            background = rounded(Color.rgb(32, 55, 82), 12)
            addView(row(name, state, white, if (state == "Este equipo") teal else muted))
            addView(label(description, 12, muted, false))
        }

    private fun action(title: String, description: String): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(9), 0, dp(9))
            addView(label(title, 15, white, true))
            addView(label(description, 12, muted, false))
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
