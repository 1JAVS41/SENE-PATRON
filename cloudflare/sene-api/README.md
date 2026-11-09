# SENE Licensing API (Cloudflare Workers + D1)

Backend en construcción para SENE PATRÓN / SENE VENTAS. Objetivo: Cloudflare Workers Free + D1 Free, sin Firebase Blaze, tarjeta ni plan de pago.

## Estado real en esta rama

El Worker incluye actualmente:

- `GET /health`.
- Retos firmados de dos minutos ligados a método, ruta, hash del cuerpo, propósito e identidad.
- Verificación ECDSA P-256 compatible con Android Keystore (firma DER convertida a P-1363 para WebCrypto), consumo de reto de un solo uso y validación de dispositivo.
- Alta inicial privada de licencia, confirmación manual y auditable de pagos de $500 + $80, y activación por 30 días solo después de ambos pagos.
- QR opaco de dos usos para vincular los dos equipos VENTAS.
- Sesión de dispositivo y cuota semanal atómica de 20 operaciones remotas por instalación.
- Solicitudes de trabajador, bandeja y decisiones separadas por equipo, actualizaciones de respuesta, reportes de cierre de turno y reportes de nómina.
- Solicitud de renovación y canje de código de un solo uso; código no caduca por tiempo y queda ligado a solicitud, licencia y PATRÓN.
- Reemplazo autorizado de Equipo 1/2: solicitud desde PATRÓN, bandeja privada de operador, aprobación/rechazo, revocación del equipo anterior, invalidación de QR y liberación del mismo slot.
- Correcciones de venta: solicitud idempotente, bandeja por equipo, aprobación/rechazo y permiso ligado a una venta, dispositivo y licencia, consumible una sola vez.
- Alta y operaciones privadas de operador protegidas por secreto del Worker. El secreto nunca debe incluirse en las APK.

## Estado de despliegue

**El código está en GitHub, pero no está desplegado en el Worker de Cloudflare.** El Worker remoto continúa en el estado de prueba Hello World. La D1 real contiene únicamente la migración inicial 0001; las migraciones 0002–0006 todavía no se aplican allí.

No desplegar ni aplicar migraciones remotas hasta completar revisión y pruebas E2E en un entorno de pruebas, y recibir autorización explícita.

## Verificación automatizada

El workflow `.github/workflows/cloudflare-check.yml` ejecuta:

1. `node --check` para detectar errores de sintaxis.
2. Migraciones 0001–0006 sobre SQLite temporal e `integrity_check`.
3. Prueba del límite semanal de 20 operaciones y rechazo de la número 21.
4. Pruebas de renovación, pago inicial de $580 y activación por 30 días.
5. Pruebas de historial y reemplazo de dispositivos, unicidad de solicitudes pendientes, revocación e invalidación de QR.
6. Prueba del permiso de corrección de un solo uso.
7. Prueba de que el código de activación no se consume si falta confirmar la primera renta.

Último resultado comprobado al actualizar este documento: CI exitoso para el commit `288c8f21ca50d01d51615760e70c18e29d00d87d`. Estas pruebas SQLite no sustituyen pruebas de extremo a extremo contra Workers/D1 reales.

## Migraciones y base D1

- Base D1: `sene-licencias`.
- ID: `22f73e97-e43e-44f1-870b-58fad88e7028`.
- Binding del Worker: `DB`.
- Migraciones versionadas: 0001 a 0006.
- La migración 0001 ya se aplicó manualmente a la D1 real. **No volver a ejecutarla.**
- Las migraciones 0002–0006 solo se han probado en CI sobre SQLite temporal.

## Pendientes antes de producción

1. Diseñar y probar recuperación segura de un PATRÓN perdido.
2. Sustituir el mecanismo temporal de secreto de operador por un proceso privado de operación seguro; nunca incluir secretos en APK.
3. Completar idempotencia/recuperación segura del código de alta si la respuesta privada se pierde.
4. Revisar exhaustivamente transacciones, límites, reintentos, concurrencia y errores D1.
5. Ejecutar E2E en un Worker y D1 de pruebas, incluidos retos vencidos/replay, pairing concurrente, pagos duplicados, cuota, reemplazos y correcciones.
6. Integrar cliente HTTP y firma Android en SENE PATRÓN y SENE VENTAS sin alterar funciones comerciales.
7. Compilar y probar ambas APK en dispositivos reales, con y sin Internet.
8. Integrar notificaciones WhatsApp Business API solo si se habilita un proveedor oficial; actualmente no están automatizadas.

## Reglas de continuidad

- Ventas, caja, inventario y gastos permanecen localmente en SENE VENTAS; no se sincronizan al servidor.
- Si falla Internet, servidor o cuota, SENE VENTAS conserva sus funciones comerciales locales.
- Ningún fallo remoto debe borrar datos locales ni conceder permisos.
- Nunca poner `ADMIN_TOKEN` u `OPERATOR_TOKEN` en las APK.
- Mantener Cloudflare Workers y D1 en plan Free; no activar Workers Paid ni Firebase Blaze.


## Recuperación de códigos

Se implementaron `POST /v1/operator/licenses/reissue-activation-code` y `POST /v1/operator/renewals/reissue-code`. Rotan el hash del código, invalidan el anterior, exigen pago confirmado y dejan auditoría. Los códigos no se guardan en texto claro. Migración 0007 añade `authorized_by` a renovaciones. CI debe aplicar 0001–0007.


**Lectura de notificaciones (migración 0008):** cada solicitud operativa y cada corrección tiene su propio `seen_at`. Al abrir la bandeja del Equipo 1 o 2 se marcan como vistas únicamente las notificaciones pendientes de ese equipo y categoría; el estado de la solicitud permanece `pending` hasta que el patrón aprueba o rechaza. El contador por equipo suma solo notificaciones pendientes aún no vistas. Así el botón puede pasar de verde con número exacto a rojo al consultar, sin borrar solicitudes ni historial.
