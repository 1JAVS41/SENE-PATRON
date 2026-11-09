# SENE Licensing API (Cloudflare Workers + D1)

Backend en construcción para SENE PATRÓN / SENE VENTAS. Objetivo: Workers Free + D1 Free, sin Firebase Blaze, tarjeta ni plan de pago.

## Estado real

- Implementado en el Worker: `GET /health` y `POST /admin/licenses` de scaffold. Este último usa `ADMIN_TOKEN`; todavía no es un panel privado de operador listo para producción.
- Esquema inicial `0001_initial.sql`: licencias, dispositivos, QR, retos y correcciones.
- Migración aditiva `0002_security_billing_usage.sql`: pagos en centavos MXN, campos para retos ligados al método/ruta/hash del cuerpo, idempotencia de solicitudes, cuota semanal por dispositivo, reemplazos y auditoría.
- `wrangler.toml` ya apunta a la D1 existente `sene-licencias` y su ID real.
- La migración 0002 fue validada localmente contra SQLite usando el esquema 0001. **Todavía no se ha aplicado a la D1 remota ni se ha probado desde el Worker.**

## No conectar APKs todavía

No conectar ni distribuir las APK como producción hasta implementar y probar activación PATRÓN, firma de retos ECDSA, QR de dos usos, sesiones, vigencia/pagos, cuotas, correcciones de un solo uso y reemplazos. La autenticación del operador debe validarse en servidor; ningún secreto administrativo va dentro de las APK.

## Base D1 existente

Nombre: `sene-licencias`

ID: `22f73e97-e43e-44f1-870b-58fad88e7028`

Binding del Worker: `DB`

La base ya contiene las tablas de `0001_initial.sql`. **No volver a ejecutar manualmente la migración 0001.** Aplicar únicamente `0002_security_billing_usage.sql` una vez, después de revisar el SQL y confirmar que la base remota sigue teniendo las tablas esperadas.

## Configuración y despliegue

1. Mantener Cloudflare en Free. No activar Workers Paid ni agregar tarjeta.
2. Aplicar la migración 0002 a la D1 existente. No volver a crear la base.
3. Configurar secretos solo en Cloudflare cuando exista un flujo de operador seguro. No ponerlos en el repositorio ni en APK.
4. Implementar endpoints de forma incremental y probarlos con casos de seguridad y concurrencia.
5. Desplegar el Worker solo después de completar las pruebas; verificar `GET /health`.

## Límites gratuitos de referencia

- Workers Free: 100,000 solicitudes/día.
- D1 Free: 5 millones de filas leídas/día, 100,000 filas escritas/día y 5 GB de almacenamiento total de cuenta (límite por base según plan).
- Si D1/Worker falla o agota cuota, las acciones remotas se deniegan; los datos comerciales locales de VENTAS permanecen intactos.

