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


## Actualización de auditoría: cuota semanal y reemplazo de equipos (2026-11-09)

### Pruebas CI verificadas
- El commit `49890b35fe0f468c4b623ba5e0df8c2b63aa1d9b` incorpora el consumo atómico de 20 operaciones autenticadas por dispositivo y semana de calendario de `America/Mexico_City`. `DEVICE_AUTH` no consume cuota.
- El commit `2baa1c1d8fad810a37c415c7d7ffa4700bef2de7` añade una prueba que acepta las operaciones 1 a 20 y rechaza la 21 sin incrementar el contador.
- GitHub Actions run `42706725029` terminó **success**. Pasaron comprobación de sintaxis, aplicación de migraciones 0001–0003 en SQLite temporal y prueba del límite semanal 20/21.
- Esto valida sintaxis y comportamiento de la cuota en SQLite temporal; no equivale a una prueba E2E contra Cloudflare Workers/D1.

### Bloqueo crítico descubierto: historial y reemplazo de dispositivos
La tabla `devices` de `0001_initial.sql` tiene la restricción `UNIQUE (license_id, slot_number)`. Aunque las consultas de vinculación buscan espacios activos, la restricción también impide insertar un equipo nuevo en un espacio si ya existe un registro histórico revocado en ese mismo espacio.

Consecuencias:
- No se puede conservar el dispositivo anterior como revocado y registrar un reemplazo en el mismo espacio.
- La activación PATRÓN también busca cualquier registro del espacio 1, no solamente uno activo.
- `replacement_requests` existe en 0002, pero todavía no hay flujo de servidor que autorice y ejecute el reemplazo.
- No se debe resolver reutilizando el mismo `device_id` ni sobrescribiendo su clave pública: solicitudes, retos, reportes y autorizaciones históricas referencian el identificador anterior.

### Diseño requerido antes de habilitar reemplazos
1. Mantener cada instalación/dispositivo como fila histórica independiente e inmutable en identidad.
2. Permitir varias filas históricas por licencia y espacio, pero garantizar **un solo dispositivo activo por espacio** mediante un índice único parcial sobre `(license_id, slot_number) WHERE status = 'active'`.
3. Hacer que el reemplazo aprobado revoque el dispositivo anterior y active el nuevo en una misma operación transaccional, validando licencia, espacio, solicitud pendiente y autorización del operador.
4. Mantener las referencias históricas de `work_requests`, `shift_reports`, `payroll_reports`, `weekly_usage`, `challenges`, `correction_requests`, `correction_grants`, `pairing_tokens` y `audit_log` ligadas al ID original.
5. Revisar el caso especial del espacio PATRÓN y revocar/invalidar tokens QR pendientes del dispositivo sustituido.

### Migración 0004: no aplicar todavía
La restricción problemática es una restricción de tabla (no un índice ordinario que pueda eliminarse con `DROP INDEX`). En SQLite, reconstruir `devices` requiere una migración cuidadosamente ensayada por las claves foráneas que apuntan a ella. No se debe improvisar un `ALTER TABLE`, renombrar la tabla ni ejecutar esta migración sobre la D1 real sin probar el procedimiento completo con todas las tablas dependientes y validar `PRAGMA foreign_key_check`.

Hasta que exista esa migración y el endpoint de reemplazo con pruebas de concurrencia, el reemplazo de equipos debe considerarse **no disponible**. No activar ni desplegar el backend para clientes.

### Estado de despliegue
- Worker del panel Cloudflare: sigue siendo la plantilla Hello World según la última comprobación registrada.
- D1 real `sene-licencias`: contiene solamente la migración 0001; 0002 y 0003 siguen pendientes.
- No se desplegó código nuevo ni se modificó la D1 real.
- Las APK todavía no están integradas con este backend ni verificadas como entregables online.


### Actualización: migración 0004 ensayada y corrección del diagnóstico (2026-11-09)

La migración `0004_device_history_replacements.sql` ya está creada en la rama `sene-cloudflare-backend`. Reconstruye `devices` conservando sus columnas e identidades, activa la postergación de comprobación de claves foráneas durante la migración y sustituye la unicidad global del espacio por un índice único parcial para dispositivos con estado `active`.

Cambios y verificaciones:
- GitHub Actions run `42707424950`: migración 0004 creada y aplicada en SQLite temporal; **success**.
- GitHub Actions run `42707434160`: activación PATRÓN ajustada para ignorar filas históricas revocadas al comprobar el espacio 1; **success**.
- GitHub Actions run `42707459022`: prueba de reemplazo con referencias históricas, inserción del nuevo equipo en el mismo espacio, rechazo de un segundo equipo activo y `PRAGMA foreign_key_check` / `integrity_check`; **success**.
- La prueba inserta referencias de prueba desde pairing_tokens, challenges, correction_requests/grants, weekly_usage, replacement_requests, audit_log, work_requests, shift_reports y payroll_reports para comprobar que el historial sigue apuntando al dispositivo antiguo.
- El índice parcial evita dos dispositivos activos en el mismo espacio, pero permite conservar filas revocadas.

Límites que siguen vigentes:
- La migración 0004 **no se ha aplicado** a la D1 real.
- El endpoint y la autorización operativa de reemplazo todavía no están implementados. La tabla `replacement_requests` existe, pero no debe confundirse con un flujo funcional.
- El Worker y las APK todavía no están conectados/desplegados como sistema completo.
- Las pruebas son de sintaxis y SQLite temporal; no son pruebas E2E en Cloudflare.

### Siguiente trabajo obligatorio antes del despliegue
1. Diseñar el contrato de solicitud y autorización de reemplazo: la app PATRÓN no puede autorizar por sí sola un teléfono perdido si ya no tiene credenciales válidas; debe existir recuperación autenticada por el operador privado.
2. Implementar autorización de operador en servidor sin incluir secretos en APK, aprobación de reemplazo de un solo uso y revocación atómica del equipo anterior.
3. Añadir invalidación de pairing tokens pendientes ligados al PATRÓN sustituido.
4. Probar carreras/concurrencia, reintentos e idempotencia.
5. Integrar el contrato con ambas aplicaciones y después preparar despliegue controlado.
