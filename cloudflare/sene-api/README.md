# SENE Licensing API (Cloudflare Workers + D1)

Backend en construcción para SENE PATRÓN / SENE VENTAS. Objetivo: Cloudflare Workers Free + D1 Free, sin Firebase Blaze, tarjeta ni plan de pago.

## Estado real del código

En la rama `sene-cloudflare-backend` del repositorio:

- `GET /health`: respuesta básica de estado.
- `POST /v1/challenges`: emite retos de dos minutos ligados a método, ruta, hash exacto del cuerpo e identidad del dispositivo.
- Verificación ECDSA P-256: valida firma Android DER, identidad, integridad del cuerpo y consumo de reto de un solo uso.
- `POST /v1/patron/activate`: handler de activación inicial; requiere que el operador ya haya confirmado el pago de instalación en D1.
- `POST /v1/patron/pairing-tokens`: genera QR opaco de dos usos, con vencimiento actual de 24 horas.
- `POST /v1/ventas/pair`: handler de vinculación de VENTAS en los slots 2 y 3.
- `POST /v1/device/session`: devuelve estado, fecha del servidor y contador semanal existente.
- `POST /admin/licenses`: scaffold temporal protegido por `ADMIN_TOKEN`; no es un panel privado de producción y no debe integrarse en las APK.

**Estos handlers están en el repositorio, no desplegados ni probados de extremo a extremo en Cloudflare.** Los flujos de pagos, renovaciones, cuotas de negocio, correcciones, reemplazos y autenticación definitiva del operador siguen pendientes.

## Verificación automatizada añadida

El workflow `.github/workflows/cloudflare-check.yml` ejecuta:

1. `node --check` para detectar errores de sintaxis del Worker.
2. Aplicación de las migraciones 0001 y 0002 sobre una base SQLite temporal.
3. `PRAGMA integrity_check` para comprobar la integridad de esa base temporal.

La creación del workflow no significa que ya haya pasado: hay que revisar el resultado de GitHub Actions después de que GitHub lo ejecute. Estas pruebas no sustituyen una prueba con Cloudflare Workers/D1 reales.

## Base D1 existente

- Nombre: `sene-licencias`
- ID: `22f73e97-e43e-44f1-870b-58fad88e7028`
- Binding del Worker: `DB`

La base remota ya contiene las tablas de `0001_initial.sql`. **No volver a ejecutar manualmente la migración 0001.** La migración `0002_security_billing_usage.sql` aún no se ha aplicado a la base remota.

No aplicar migraciones en Cloudflare hasta revisar compatibilidad y confirmar el plan de despliegue. La migración 0003 para conservar historial y permitir reemplazar dispositivos en un mismo slot aún necesita diseño: el índice UNIQUE actual de `devices(license_id, slot_number)` impide conservar varios registros históricos para un slot.

## Pendientes críticos antes de producción

1. Diseñar y probar la migración que permita reemplazos sin perder historial ni romper claves foráneas.
2. Implementar un panel privado de operador con autenticación individual validada por el servidor. No usar `ADMIN_TOKEN` desde una APK ni exponerlo en código cliente.
3. Implementar alta y confirmación auditable de pagos de $500 MXN y $80 MXN; solo el pago inicial confirmado debe iniciar los 30 días.
4. Implementar renovaciones idempotentes, suspensión y reactivación.
5. Implementar consumo atómico de cuota semanal por dispositivo para cada operación remota autorizada.
6. Implementar solicitudes, decisiones y consumo de permisos de corrección de un solo uso.
7. Implementar solicitudes y autorización privada de reemplazo de equipos.
8. Probar retos vencidos, replay, concurrencia de QR, pagos duplicados, cupos, cuotas y permisos.
9. Probar los flujos completos en un Worker de pruebas y D1 de pruebas antes de modificar la base remota.
10. Conectar las APK solo después de que el contrato y el backend estén completos y probados.

## Seguridad y continuidad

- Las ventas, caja, inventario y gastos permanecen en el teléfono; no se envían al servidor.
- Una falla de servidor o cuota nunca debe borrar datos locales ni conceder permisos remotos.
- Ningún secreto administrativo debe incluirse en las APK.
- Mantener Workers y D1 en el plan Free; no activar Workers Paid ni agregar tarjeta.
