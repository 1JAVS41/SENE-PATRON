# Estado de integración Android SENE (2026-11-10)

## SENE PATRÓN
- Identidad P-256 en Android Keystore; la identidad lógica de instalación se deriva de `ANDROID_ID` y del paquete para mantenerse estable tras reinstalar en el mismo teléfono.
- Cliente HTTPS obligatorio con retos firmados, hash del cuerpo y consumo de reto de un solo uso.
- La interfaz ya conecta el registro inicial de $580 MXN, introducción del código de activación, renovación de $80 MXN, introducción del código de renovación, reposición pagada de $500 MXN y canje del código de reposición.
- AYUDA obtiene contactos firmados digitalmente; muestra opciones para reposición de teléfono perdido y restauración gratuita en el mismo teléfono cuando la continuidad criptográfica y los datos registrados coinciden.
- Tras activar, recuperar o restaurar, el cliente guarda el deviceId remoto y consulta la sesión/licencia.
- Los módulos de equipos, notificaciones, solicitudes, correcciones, reportes y nómina conservan las llamadas del cliente HTTPS firmado.
- La reemisión de códigos se realiza por endpoints privados de operador; los secretos de operador no se incluyen en la APK.

## SENE VENTAS
- El cliente HTTPS firmado de la rama `sene-ventas-preparacion-patron` incluye pairing QR, sesión, solicitudes de trabajador, recuperación de respuestas, reportes de cierre y nómina, y solicitud/consumo de corrección.
- El cursor de respuestas usa `since` conforme al contrato del Worker.
- La integración E2E con el Worker de producción sigue pendiente; los datos comerciales permanecen locales.

## Compilación y pruebas
- El workflow Android automático está configurado para compilar el proyecto y generar el icono con el logotipo original.
- GitHub Actions está creando los runs, pero actualmente los jobs terminan sin asignación de runner (`runner_id=0`, sin pasos ni logs). Por eso no hay una compilación reciente verificable ni APK que entregar.
- El workflow Cloudflare contiene comprobaciones de sintaxis, migraciones SQLite y pruebas de licencia, pagos, códigos de un solo uso, reposición pagada, restauración en el mismo teléfono y transferencia de mensualidad; los jobs recientes tampoco han podido ejecutarse por falta de runner.
- Las comprobaciones estáticas del Worker y la correspondencia de rutas/propósitos del cliente sí se han realizado, pero no sustituyen CI ni E2E.

## Pendientes antes de producción
1. Habilitar/recuperar la ejecución de GitHub Actions para obtener runners y validar compilación y pruebas.
2. Confirmar la URL HTTPS exacta del Worker; no inventarla ni fijarla en las APK.
3. Crear un entorno Cloudflare de pruebas y aplicar allí todas las migraciones en orden; no tocar la D1 real todavía.
4. Probar E2E activación, renovación, reposición, restauración del mismo teléfono, QR, vinculación de ambos equipos, solicitudes, correcciones y nómina.
5. Probar los flujos offline y verificar que ventas, caja, inventario y gastos sigan locales.
6. Generar e instalar las APK finales, con sus nombres acordados: `SENE VENTAS-online.apk` y `SENE PATRON-online.apk`.

No desplegar el Worker ni ejecutar migraciones en la D1 real sin autorización explícita.