# Estado de integración Android SENE (2026-11-10)

## SENE PATRÓN
- El código Android que compila está en `src/main`; usa identidad P-256 de Android Keystore y continuidad lógica derivada de `ANDROID_ID`.
- La APK incluye registro inicial, activación, renovación de $80 MXN, reposición pagada de $500 MXN, restauración gratuita en el mismo teléfono, contactos AYUDA firmados, vinculación por QR, administración independiente de Equipo 1 y Equipo 2, bandejas de solicitudes/correcciones, reportes y configuración de nómina.
- La restauración gratuita exige continuidad del mismo teléfono y coincidencia de empresa/correo/teléfono; no libera una plaza ni sustituye la reposición pagada de un teléfono perdido.
- Compilación Android debug verificada en GitHub Actions (run `42919755192`, commit `fcd1d44`). No es una APK release firmada ni prueba en teléfono físico.

## SENE VENTAS
- Rama de integración: `fix/ventas-cloudflare-client`; el proyecto Android compila desde `app/src/main`.
- Cliente HTTPS firmado con pairing QR, sesión, solicitudes operativas, historial de respuestas, reportes de cierre y nómina, y solicitud/consumo de permisos de corrección.
- La pantalla de inicio y el menú de ventas ya permiten configurar el servidor, escanear QR `SENEPAIR2`, verificar sesión, restaurar gratuitamente el mismo equipo tras reinstalar, enviar solicitudes operativas y consultar/generar reportes de día de pago.
- El reporte de cierre final se sincroniza con PATRÓN; los cortes periódicos de dos horas permanecen locales/WhatsApp para no consumir la cuota remota semanal.
- El envío de nómina por WhatsApp se habilita únicamente cuando la sesión del servidor confirma que es la fecha de pago configurada. El periodo parte del último reporte guardado en servidor y el mismo reporte se reutiliza si el usuario vuelve a abrir WhatsApp.
- La solicitud de corrección ya permite seleccionar una venta y renglón, definir código/cantidad/precio correctos, guardar el plan/hash local y compartir el detalle por WhatsApp; el servidor conserva solo motivo, hash y autorización. Se añadió la pantalla para consumir el grant de un solo uso y aplicar el cambio en venta, inventario y caja estimada, con estado local reanudable si la app se cierra. **Esta integración todavía debe superar la compilación de la cabeza actual y pruebas reales de cada tipo de corrección antes de considerarse terminada.**
- Las compilaciones más recientes para los cambios de QR, restauración, solicitudes y nómina están en ejecución; esperar el resultado del run de la cabeza de rama antes de entregar APK. Los builds previos no validan todos los cambios recientes.

## Worker Cloudflare
- La rama `sene-cloudflare-backend` contiene pairing por QR de un solo uso y slot, restauración gratuita de VENTAS en el mismo teléfono, historial de solicitudes/correcciones, consulta de nómina por slot y reportes.
- La suite Worker/migraciones SQLite pasó en run `42921914363` (commit `14823acd`), incluyendo restauración de VENTAS con preservación del historial y revocación del QR pendiente.
- El Worker **no está desplegado en producción**. No hay URL final verificada; no usar el Worker de prueba Hello World ni configurar una URL inventada.
- Las pruebas usan bases SQLite temporales. No prueban todavía una D1 real ni la integración E2E entre APKs y Cloudflare.

## Pendientes antes de producción
1. Confirmar compilación Android de la cabeza actual de SENE VENTAS y generar artefactos verificables.
2. Terminar interfaz de corrección local: seleccionar venta, enviar plan/motivo, recibir grant, aplicar el cambio local y consumir autorización una sola vez.
3. Configurar y probar Worker en entorno Cloudflare de pruebas con secretos correctos y D1 temporal; verificar todos los flujos desde las dos APKs.
4. Probar en teléfonos reales: QR de cada slot, restauración tras reinstalación, conexión intermitente, reportes, nómina, WhatsApp y continuidad de caja/inventario.
5. Preparar APKs release firmadas y verificar instalación/actualización. Nombres acordados: `SENE VENTAS-online.apk` y `SENE PATRON-online.apk`.

No desplegar el Worker ni ejecutar migraciones en la D1 real sin autorización explícita.
