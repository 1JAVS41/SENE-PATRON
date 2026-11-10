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


### Actualización: revisión del contrato API y configuración de D1 (2026-11-09)

- Se comprobó el archivo `wrangler.toml`: el nombre del Worker, binding `DB`, nombre D1 `sene-licencias` e ID `22f73e97-e43e-44f1-870b-58fad88e7028` coinciden con el recurso D1 creado por el usuario.
- Esto valida la configuración guardada en GitHub, no el despliegue del Worker del panel ni el estado de migraciones de la D1 remota.
- Se revisó el contrato API y se corrigieron descripciones que podían confundirse con funciones ya disponibles. Queda explícito que los endpoints de correcciones de venta, recuperación/reemplazo y gestión privada de pagos/renovaciones no están implementados todavía.
- La matriz de implementación separa: código existente en rama, pruebas CI ejecutadas y estado de producción. Ninguna de estas pruebas locales/CI equivale a despliegue o prueba E2E en Cloudflare.
- No se modificó la D1 real ni el Worker del panel.

### Prioridad técnica siguiente

Antes de implementar recuperación, hay que diseñar la autenticación privada del operador y el ciclo de pagos/renovación. El scaffold `ADMIN_TOKEN` no es todavía un sistema de operador de producción. No exponerlo en APK ni crear endpoints de aprobación que permitan a un cliente autorizar su propio reemplazo.


### Actualización: activación inicial y renovaciones manuales (2026-11-09)

Se implementó en la rama, sin desplegar:
- Migración `0005_monthly_renewals.sql`: solicitudes de renovación por licencia, código hash único, estados pendiente/autorizado/consumido/cancelado y un solo proceso abierto por licencia.
- Alta privada de licencia por nombre de negocio.
- Confirmación privada del pago inicial por $580 MXN, registrada como alta de $500 y primera renta de $80, con claves de idempotencia.
- Activación de PATRÓN por 30 días desde el reloj del servidor cuando ambos pagos están confirmados.
- Solicitud de renovación de $80 MXN desde PATRÓN incluso si la licencia ya venció (si el dispositivo sigue activo y la licencia no está suspendida/revocada).
- Bandeja privada de renovaciones pendientes, emisión de código manual posterior a la verificación del pago, canje firmado de un solo uso y cancelación/revocación del código.
- El código de renovación no tiene vencimiento temporal y queda ligado a solicitud, licencia y dispositivo PATRÓN.
- Los endpoints privados exigen `OPERATOR_TOKEN` con longitud mínima de 32 caracteres como secret del Worker. Nunca se incluye en APK.

Pruebas GitHub Actions:
- Migraciones 0001–0005 e integridad SQLite: aprobadas.
- Límite semanal 20/21: aprobado.
- Renovación con único proceso abierto, pago mensual de $80 y consumo único: aprobado.
- Pago inicial de $580 y activación de 30 días: aprobado.
- Reemplazo conservando referencias históricas: pruebas previas aprobadas.
- Último CI registrado: run `42709305156`, resultado `success`.

Limitaciones que siguen abiertas:
- No hay integración WhatsApp Business/API ni aviso automático al número oficial de Ayuda.
- No hay una interfaz privada segura terminada para operar estos endpoints; el token es solo un mecanismo backend temporal, no debe enviarse al teléfono del usuario ni guardarse en una APK.
- No hay prueba E2E contra Cloudflare Workers/D1.
- La migración 0005 y las migraciones 0002–0004 aún no se aplican a la D1 real.
- Worker del panel Cloudflare sigue sin desplegar este código; no se ha modificado el recurso D1 real.
- APKs Android aún no están conectadas a estas rutas.

No desplegar ni pedir al usuario que ejecute migraciones hasta completar la revisión integral y acordar cómo se operará de forma segura sin exponer secretos.


## Actualización: sustitución de equipo VENTAS (2026-11-09)

- Worker implementa solicitud firmada por PATRÓN, bandeja privada de operador, aprobación y rechazo.
- La aprobación revoca el dispositivo anterior, invalida los QR previos de la licencia, libera el mismo espacio y conserva referencias históricas. La vinculación del reemplazo se hace mediante QR nuevo emitido por PATRÓN.
- Migración `0006_device_replacement_flow.sql` impone una sola solicitud pendiente por equipo y por slot.
- CI incluye prueba SQLite de duplicados, revocación, invalidación QR y reutilización del slot.
- Pendiente: recuperación segura de un PATRÓN perdido; interfaz privada de operador; E2E en Cloudflare; migraciones aún no aplicadas a D1 real. No desplegar.


## Actualización: correcciones de venta y control de cuota (2026-11-09)

- Worker implementa solicitud idempotente de corrección, bandeja PATRÓN filtrada por Equipo 1/2, aprobación/rechazo y permiso de un solo uso ligado a licencia, dispositivo y venta.
- El consumo actualiza grant y solicitud en batch D1; una segunda utilización se rechaza. Se añadió prueba CI SQLite para comprobar single-use.
- La cuota ahora se consume después de validar rol y vigencia de licencia en el contexto del dispositivo. La excepción de renovación permite que un PATRÓN vencido solicite/canjee renovación; los rechazos por licencia no consumen cuota. La emisión de QR sí consume cuota.
- Se corrigió el parseo del encabezado `Authorization: Bearer` en el operador privado.
- Pendiente: revisar integración real Android, ejecutar CI del último commit, pruebas E2E contra entorno de pruebas Cloudflare, y desplegar solo tras aprobación explícita. No se tocó D1 real.


## Corrección de seguridad del alta inicial (2026-11-09)

- Se detectó que el endpoint de activación podía consumir el código y registrar el dispositivo PATRÓN después de confirmar solo el alta de $500, aunque la primera renta de $80 aún no estuviera confirmada. Eso podía dejar un PATRÓN registrado con licencia pendiente y código inutilizable.
- Se corrigió la condición de inserción y consumo: ahora exige que `setup_paid_at` y `first_rent_paid_at` estén confirmados antes de registrar PATRÓN o invalidar el código. La activación de 30 días continúa condicionada a ambos pagos.
- Se añadió un paso CI SQLite que verifica que, si falta la primera renta, no se registra el dispositivo, no se consume el código y la licencia permanece pendiente.


## Recuperación segura de códigos de activación y renovación (2026-11-09)

- Se agregaron rutas privadas para rotar códigos cuando la entrega original se pierde: reemisión de código de activación y de renovación.
- El código previo queda invalidado; solo se devuelve el código nuevo en la respuesta de la operación privada. No se almacena texto claro.
- La reemisión de activación exige ambos pagos confirmados y ausencia de PATRÓN activo. La reemisión de renovación exige solicitud autorizada y pago mensual confirmado.
- Se añadió migración 0007 para registrar el operador que autorizó/reemitió el código de renovación. CI amplió la aplicación de migraciones a 0001–0007 y prueba los guardarraíles de reemisión.


**Lectura de notificaciones (migración 0008):** cada solicitud operativa y cada corrección tiene su propio `seen_at`. Al abrir la bandeja del Equipo 1 o 2 se marcan como vistas únicamente las notificaciones pendientes de ese equipo y categoría; el estado de la solicitud permanece `pending` hasta que el patrón aprueba o rechaza. El contador por equipo suma solo notificaciones pendientes aún no vistas. Así el botón puede pasar de verde con número exacto a rojo al consultar, sin borrar solicitudes ni historial.


## Recuperación de PATRÓN perdido (2026-11-09)

- Migración 0009: solicitud privada con código hash único, ligada a licencia y al PATRÓN anterior.
- El operador puede crear, consultar pendientes, reemitir (rotando e invalidando el código anterior) o cancelar.
- El nuevo PATRÓN firma reto bootstrap P-256. El batch revoca el anterior, invalida pairing tokens, registra el nuevo dispositivo en slot 1, consume código y audita.
- Licencia vencida puede recuperar el dispositivo, pero debe renovar antes de operaciones remotas.
- El cliente Android PATRÓN ya tiene método firmado `recover(recoveryCode)` y guarda el nuevo deviceId.
- CI SQLite de recuperación se añadió; pendiente comprobar el run más reciente y E2E en Cloudflare.


## Configuración de nómina por equipo (2026-11-09)

- Migración 0010 crea `payroll_settings`, aislada por licencia y slot 2/3.
- El patrón configura sueldo base, día fijo mensual, fechas específicas o ambos.
- Worker añade endpoints firmados para consultar/guardar la configuración.
- El endpoint de reporte de nómina valida en servidor que hoy (America/Mexico_City) sea una fecha configurada para el slot real del dispositivo. Se rechaza si no está configurado o no corresponde el día.
- Android PATRÓN tiene pantalla de configuración independiente por Equipo 1 y Equipo 2; Android VENTAS añade menú Día de pago, consulta local y envío del reporte al servidor.
- Pendiente probar flujos E2E y validar el cálculo final de nómina a partir de reglas aprobadas/descuentos; no desplegar todavía.


## Auditoría cruzada Android VENTAS ↔ Worker (2026-11-10)

Se revisaron los archivos activos de la rama `sene-ventas-preparacion-patron`:
- `app/src/main/java/com/sene/ventas/SeneApiClient.kt`
- `app/src/main/java/com/sene/ventas/App.kt`

Y el Worker de esta rama:
- `cloudflare/sene-api/src/worker.js`

### Verificaciones positivas
- Las llamadas activas de VENTAS para vincular, sesión, solicitudes de trabajo, recuperación de respuestas, cierre de turno y reporte de nómina usan los mismos propósitos y rutas declarados en `CHALLENGE_TARGETS`.
- Las solicitudes de trabajo guardan una clave UUID local y el Worker hace deduplicación por dispositivo + clave; los reintentos no crean otra solicitud.
- Los cierres de turno se encolan localmente y se retiran de la cola después de respuesta exitosa. El Worker usa `shiftKey` único por dispositivo para responder idempotentemente.
- Nómina se envía con fecha local del servidor como clave; el Worker valida que sea día de pago del slot real. El cálculo del patrón usa `payrollEntries` consultadas desde D1 y decisiones autorizadas, no el array `requests` enviado por el teléfono.
- El build Android PATRÓN del commit `d098d9ba50f6e9df78728babb4398ab25e6d3cb5` terminó success (run `42730920846`) y publicó el artefacto `SENE PATRON-online` de 1,313,514 bytes.

### Bloqueo funcional encontrado: corrección de venta no conectada en la interfaz VENTAS
- El cliente `SeneApiClient.kt` contiene métodos `createCorrectionRequest()` y `consumeCorrectionGrant()`.
- Sin embargo, la inspección completa de `App.kt` no encuentra referencias a esos métodos ni controles/textos de corrección. Por tanto, la presencia de endpoints y métodos cliente no demuestra que el trabajador pueda solicitar una corrección desde la app ni consumir el permiso de un solo uso al corregir una venta.
- El flujo Worker sí contempla solicitud idempotente, aprobación PATRÓN, grant ligado a solicitud/dispositivo/venta y consumo único. Falta cerrar la integración de interfaz y enlazarla con la venta local concreta, sin alterar ventas/inventario/caja por defecto.
- Este punto debe implementarse y probarse antes de declarar completa la función de corrección. No se modificó la lógica comercial de VENTAS en esta auditoría.

### Estado de compilación y despliegue
- Android PATRÓN: run `42730920846`, **success**, artefacto publicado.
- Android VENTAS: último run consultado `42727055819`, **success** (commit `f4768d6d2c41577714866f75fdba0c5d64c00718`).
- Ambos resultados son compilaciones CI; no son pruebas de flujo en teléfonos ni pruebas E2E.
- El Worker del panel Cloudflare continúa sin desplegar el código de esta rama y las migraciones 0002–0010 no están aplicadas a la D1 real. No desplegar ni ejecutar migraciones hasta validar el entorno de pruebas y la interfaz privada del operador.


### Seguimiento de integración de correcciones (2026-11-10)

Se verificó además la pantalla activa de SENE PATRÓN:
- `src/main/java/com/sene/patron/MainActivity.kt` contiene `renderCorrectionInbox`.
- Cada equipo muestra su bandeja de correcciones por separado; el patrón puede autorizar o rechazar.
- La autorización genera un permiso de un solo uso ligado a una solicitud, dispositivo y venta.
- El cliente PATRÓN llama al endpoint firmado de decisión y vuelve a consultar la bandeja.

Se confirmó el requisito de producto acordado: el trabajador solicita la corrección desde SENE VENTAS indicando el motivo; el patrón la administra exclusivamente desde SENE PATRÓN (no WhatsApp); el permiso aprobado solo vale para esa venta y una utilización. Los datos comerciales permanecen locales en VENTAS.

Pendiente de integrar en VENTAS:
1. Asignar un identificador estable a cada ticket local (incluidas ventas históricas mediante una clave derivada estable, sin subir el ticket al servidor).
2. Permitir elegir un ticket y enviar motivo + clave UUID idempotente al endpoint existente.
3. Incluir las decisiones de corrección en la respuesta de actualizaciones de VENTAS, para que el trabajador vea pendiente/aprobada/rechazada y el identificador del permiso autorizado.
4. Consumir el permiso firmado y ligado al ticket justo antes de habilitar la operación local de corrección; el servidor debe seguir rechazando cualquier segundo uso o discrepancia de venta/equipo.

**Guardarraíl:** todavía no se debe programar una eliminación o modificación concreta de líneas, inventario o caja. La autorización técnica está definida, pero la acción local exacta que el trabajador podrá ejecutar tras la autorización (anular ticket completo, corregir productos/cantidades u otra operación) debe quedar especificada antes de modificar los registros comerciales. No se debe asumir ni inventar esa semántica.

No se cambió la lógica de ventas, inventario ni caja durante esta revisión.
