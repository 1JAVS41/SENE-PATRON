# Revisión técnica del backend SENE (2026-11-09)

## Resultado de la inspección

Esta revisión se hizo sobre:
- Rama `sene-cloudflare-backend` de `1JAVS1/SENE-PATRON`.
- Rama `sene-ventas-preparacion-patron` de `1JAVS1/sene-pv`.

**Conclusión: el backend todavía no está listo para producción y las APK no deben conectarse todavía.**

## Estado real encontrado

### Cloudflare / Worker
- El repositorio contiene un scaffold en `cloudflare/sene-api/src/worker.js`.
- Ese scaffold implementa únicamente `GET /health` y `POST /admin/licenses`.
- El Worker que el usuario creó desde el panel de Cloudflare continúa siendo la plantilla Hello World. El binding D1 `DB` configurado en el panel no cambia por sí solo el código Hello World.
- `wrangler.toml` todavía tiene un identificador de base de datos de ejemplo y declara `database_name = "sene-licensing"`. La base que el usuario creó en el panel se llama `sene-licencias`. No desplegar usando esa configuración sin reconciliarla.

### Base D1
La migración inicial crea estas tablas: `licenses`, `devices`, `pairing_tokens`, `challenges`, `correction_requests` y `correction_grants`.
La estructura inicial no cubre todavía todos los requisitos de auditoría, reemplazo, pagos/renovaciones ni control de cuota semanal que aparecen en `docs/LICENCIAS_RENTA.md`.

### SENE VENTAS
- `DeviceIdentity.kt` crea una identidad criptográfica P-256 en Android Keystore y permite firmar retos.
- La propia clase declara que todavía no registra, activa ni vincula el dispositivo.
- La pantalla de diagnóstico de identidad en `App.kt` realiza pruebas locales de firma; no llama al backend.
- Las conexiones HTTP encontradas en `App.kt` son para consultar hora de Internet. No son llamadas de licenciamiento.
- Por lo tanto, aún no existe un contrato cliente-servidor implementado en VENTAS para activación, vinculación, solicitudes de corrección o consumo de autorización.

### SENE PATRÓN
- La pantalla actual muestra estados informativos y secciones de administración, pero no se encontraron llamadas HTTP al backend.
- `Protection.kt` valida una contraseña local fija mediante PBKDF2; eso no autentica la licencia en el servidor y no debe confundirse con la autorización remota del titular.
- La aplicación todavía no realiza activación de licencia, emisión de QR, lectura de solicitudes reales ni decisiones remotas de corrección.

## Decisiones de producto que deben mantenerse

- Una licencia corresponde a un negocio y reserva exactamente tres espacios: un PATRÓN y dos VENTAS.
- Los datos de ventas, caja, inventario y gastos permanecen en cada teléfono; no se suben ni sincronizan.
- El backend controla activación, vigencia, vinculación, reemplazos y autorizaciones remotas.
- Una autorización de corrección debe quedar ligada a una solicitud, equipo y venta; solo se puede consumir una vez y el consumo debe ser atómico.
- Si el servidor o una cuota no están disponibles, no se concede una autorización remota por defecto. Los datos comerciales locales se conservan.
- No se debe incluir el secreto administrativo en ninguna APK.
- La solución debe permanecer en Cloudflare Workers Free + D1 Free; no habilitar facturación ni tarjeta.

## Diferencias que deben resolverse antes de programar el flujo final

`docs/LICENCIAS_RENTA.md` define además:
- cuota de 20 consultas por semana y por instalación;
- alta de $500 MXN y renta de $80 MXN cada 30 días;
- confirmación de pagos y renovaciones por un operador privado autenticado;
- estados de licencia y registro de pagos.

Esas reglas son más detalladas que el resumen inicial de licencia de 30 días. Deben aplicarse de forma consistente en el backend y no se deben simular pagos ni renovaciones.

## Orden seguro de trabajo

1. Congelar este diagnóstico como referencia y definir el contrato JSON de ambas APK.
2. Añadir migraciones para los datos que falten sin volver a ejecutar la migración inicial.
3. Implementar y probar cada flujo en un entorno de prueba: alta, activación PATRÓN, QR con dos usos máximos, vínculo con prueba criptográfica, solicitud/decisión/consumo único de corrección, expiración, renovación y reemplazo.
4. Integrar las llamadas en ambas APK conservando los datos comerciales locales.
5. Solo después configurar el Worker real, el secreto administrativo y desplegar.
6. Verificar endpoints y pruebas de seguridad antes de distribuir las APK.

**No ejecutar la plantilla Hello World como backend ni conectar las APK a este scaffold.**
