# Estado de integración Android SENE (2026-11-09)

## SENE PATRÓN
- Se añadió `PatronDeviceIdentity.kt`: identidad P-256 propia, clave privada en Android Keystore, ID de instalación, continuityId y fingerprint.
- Se añadió `SeneApiClient.kt`: HTTPS obligatorio, challenge firmado y métodos para activar PATRÓN, consultar sesión, emitir QR, consultar solicitudes, decidir solicitudes, consultar reportes, consultar/decidir correcciones, solicitar/canjear renovación y solicitar reemplazo y recuperar un PATRÓN perdido.
- Tras activar correctamente, el cliente guarda el deviceId remoto en preferencias locales.
- Se retiraron el plugin Google Services y las dependencias Firebase que no se utilizaban en este módulo. La integración se prepara para Cloudflare Workers + D1.
- La interfaz principal todavía no invoca el cliente: faltan la configuración del endpoint HTTPS definitivo, pantallas de activación/vinculación y la conexión de botones/equipos a las respuestas del servidor.

## SENE VENTAS
- Se añadió `SeneApiClient.kt` en la rama `sene-ventas-preparacion-patron`.
- Incluye pairing QR, sesión, solicitudes de trabajador, recuperación de respuestas, reporte de cierre, reporte de nómina y solicitud/consumo de corrección.
- El cursor de respuestas usa el campo `since` exigido por el Worker.
- La UI aún no invoca el cliente; falta configurar el endpoint, enlazar el flujo QR y conectar los formularios/cola de envío sin modificar las funciones comerciales locales.

## Compilaciones verificadas
- SENE PATRÓN: GitHub Actions run 42712521622 — success. Artifact `SENE PATRON-online`.
- SENE VENTAS: GitHub Actions run 42712485704 — success. Artifact `SENE VENTAS-online`.
- Son compilaciones de validación del código de esas ramas. No equivalen a APK finales conectadas ni a pruebas E2E.

## Bloqueos para finalizar
1. El Worker remoto sigue siendo la plantilla Hello World y la D1 real solo tiene la migración 0001.
2. No se ha compartido la URL exacta `workers.dev` del Worker; no inventarla ni fijarla en las APK.
3. Faltan pruebas E2E del Worker en un entorno Cloudflare de pruebas y aplicación controlada de migraciones 0002–0008.
4. Integrar el cliente en las pantallas, colas offline/idempotencia y estados de licencia/contadores.
5. Pruebas reales de vinculación, renovación, solicitudes, notificaciones, reportes, permisos de corrección y reemplazo en ambos equipos.
6. Probar funcionamiento offline y confirmar que ventas, caja, inventario y gastos siguen locales.
7. Generar y verificar las APK finales con nombres `SENE VENTAS-online.apk` y `SENE PATRON-online.apk`.

No desplegar el Worker ni ejecutar migraciones en la D1 real sin autorización explícita.
