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

## Integración Android actual en la rama

SENE PATRÓN ya contiene una primera integración Android real, aún no validada E2E:

- Identidad P-256 en Android Keystore con clave privada no exportable.
- Cliente HTTPS firmado con retos de dos minutos y hash del cuerpo exacto.
- Activación inicial y recuperación de PATRÓN con códigos de un solo uso.
- Consulta de sesión/licencia, creación de QR de dos usos y vinculación de VENTAS.
- Consulta de dispositivos vinculados y solicitud de reemplazo.
- Bandejas separadas por Equipo 1 y Equipo 2, aprobación/rechazo de solicitudes y correcciones.
- Contadores independientes de notificaciones: rojo con 0 y verde con el número exacto cuando hay pendientes.
- Configuración separada de sueldo/día de pago y consulta de reportes de cierre y nómina por equipo.
- Solicitud y canje de renovación mensual.

SENE VENTAS ya incluye cliente HTTPS firmado, vinculación QR, solicitudes de trabajador, recepción de respuestas, cola local de cierres de turno y envío de reportes de nómina. La integración sigue pendiente de E2E y de ajustes de disponibilidad de envío en la fecha de pago.

**Importante:** la interfaz Android y el cliente firmado no hacen que el servicio esté operativo por sí solos. La API aún no está desplegada en Cloudflare y la D1 real todavía no tiene las migraciones 0002–0010. No introducir la URL de Hello World como servidor productivo ni activar equipos hasta completar el entorno de pruebas.

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

1. Probar E2E la recuperación segura de un PATRÓN perdido (el flujo y cliente Android ya existen en la rama).
2. Sustituir el mecanismo temporal de secreto de operador por un proceso privado de operación seguro; nunca incluir secretos en APK.
3. Completar idempotencia/recuperación segura del código de alta si la respuesta privada se pierde.
4. Revisar exhaustivamente transacciones, límites, reintentos, concurrencia y errores D1.
5. Ejecutar E2E en un Worker y D1 de pruebas, incluidos retos vencidos/replay, pairing concurrente, pagos duplicados, cuota, reemplazos y correcciones.
6. Completar la integración visual/funcional de los módulos restantes de ambas APK y probarlos en teléfonos reales.
7. Compilar y probar ambas APK en dispositivos reales, con y sin Internet.
8. Integrar notificaciones WhatsApp Business API solo si se habilita un proveedor oficial; actualmente no están automatizadas.

## Reglas de continuidad

- Ventas, caja, inventario y gastos permanecen localmente en SENE VENTAS; no se sincronizan al servidor.
- Si falla Internet, servidor o cuota, SENE VENTAS conserva sus funciones comerciales locales.
- Ningún fallo remoto debe borrar datos locales ni conceder permisos.
- Nunca poner `ADMIN_TOKEN` u `OPERATOR_TOKEN` en las APK.
- Mantener Cloudflare Workers y D1 en plan Free; no activar Workers Paid ni Firebase Blaze.


## Recuperación de códigos

Se implementaron `POST /v1/operator/licenses/reissue-activation-code` y `POST /v1/operator/renewals/reissue-code`. Rotan el hash del código, invalidan el anterior, exigen pago confirmado y dejan auditoría. Los códigos no se guardan en texto claro. Migración 0007 añade `authorized_by` a renovaciones. CI debe aplicar 0001–0010.


**Lectura de notificaciones (migración 0008):** cada solicitud operativa y cada corrección tiene su propio `seen_at`. Al abrir la bandeja del Equipo 1 o 2 se marcan como vistas únicamente las notificaciones pendientes de ese equipo y categoría; el estado de la solicitud permanece `pending` hasta que el patrón aprueba o rechaza. El contador por equipo suma solo notificaciones pendientes aún no vistas. Así el botón puede pasar de verde con número exacto a rojo al consultar, sin borrar solicitudes ni historial.


## Recuperación de PATRÓN perdido

La migración 0009 y el Worker incluyen recuperación privada de PATRÓN. El operador crea un código de un solo uso tras verificar al titular; puede listar pendientes, reemitir o cancelar. El nuevo PATRÓN firma reto bootstrap; el Worker revoca el anterior, invalida QR, registra el nuevo slot 1 y consume el código atómicamente. El cliente Android PATRÓN incluye el método de recuperación. Sigue sin desplegarse ni probarse E2E.


## Nómina por equipo

Migración 0010 añade sueldo y fechas de pago por separado para VENTAS_1 y VENTAS_2. PATRÓN puede consultar/guardar el sueldo base, día fijo mensual y/o fechas específicas. El Worker valida en servidor que el reporte de nómina se envíe solo en una fecha configurada para el slot real del equipo, usando America/Mexico_City. Si no está configurado o no es día de pago, rechaza el envío.
