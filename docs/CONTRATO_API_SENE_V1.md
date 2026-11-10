# Contrato API v1 — SENE PATRÓN / SENE VENTAS

**Estado: especificación para implementación; no significa que los endpoints estén desplegados.**
Base propuesta: `https://<worker>.workers.dev/v1`
Formato: JSON UTF-8. Todas las fechas y tiempos se calculan en el servidor como Unix seconds UTC. No se aceptan fechas, roles, vencimientos, slots ni contadores dictados por el cliente.

## 1. Principios obligatorios

1. Una licencia tiene tres espacios fijos: `PATRON`, `VENTAS_1`, `VENTAS_2`.
2. Solo el operador privado SENE crea licencias, confirma pagos, renueva, suspende y autoriza reemplazos. Esas acciones nunca se exponen como privilegios dentro de la APK de cliente.
3. PATRÓN administra únicamente los dos equipos VENTAS vinculados a su propia licencia.
4. VENTAS conserva ventas, caja, inventario, gastos y archivos en el teléfono. No se envían al servidor.
5. Toda acción de equipo requiere dispositivo registrado y firma ECDSA P-256 verificada con la clave pública registrada.
6. La autorización de corrección está vinculada a licencia, equipo, solicitud y venta; se consume una sola vez en una operación atómica.
7. La cuota inicial documentada es 20 operaciones remotas autorizadas por semana y por instalación. El servidor calcula la semana en `America/Mexico_City`.
8. Errores, cuota agotada, licencia vencida o indisponibilidad nunca equivalen a autorización. No se borran ni bloquean los datos comerciales locales.
9. El código de activación del negocio no tiene caducidad temporal automática: es de un solo uso y el operador puede revocarlo. Los retos criptográficos sí caducan pronto. El QR tendrá vencimiento configurable y dos usos como máximo.
10. No incluir `ADMIN_TOKEN`, secretos de firma ni credenciales administrativas en APK.

## 2. Identidad criptográfica Android

VENTAS ya expone en `DeviceIdentitySnapshot`:
- `installationId`: UUID de instalación.
- `continuityId`: SHA-256 hexadecimal del packageName + ANDROID_ID.
- `publicKeyBase64`: clave pública X.509 EC P-256 codificada Base64 estándar.
- `fingerprint`: SHA-256 hexadecimal de los bytes X.509.
- `signChallenge(context, challengeBytes)`: firma `SHA256withECDSA`; Android devuelve firma ECDSA ASN.1 DER codificada Base64 estándar.

El servidor debe validar formato, curva P-256 y que la huella corresponda a la clave. `continuityId` solo ayuda a recuperar una instalación; nunca sustituye la firma de posesión ni permite recuperar el acceso por sí solo.

**Mensaje exacto firmado:** el servidor devuelve `signingMessage` como Base64URL sin padding. La APK decodifica `signingMessage` y firma esos bytes exactos con `DeviceIdentity.signChallenge(context, decodedSigningMessage)`. No debe firmar el campo `challenge` (ese campo es solo el nonce). La firma Android es ECDSA ASN.1 DER codificada en Base64 estándar sin saltos; el Worker la convierte a P1363 antes de verificarla con WebCrypto.

## 3. Envolvente común

Cabeceras:
- `Content-Type: application/json`
- `X-SENE-Version: 1`
- En llamadas autenticadas: `X-SENE-Device: <deviceId>`
- En llamadas autenticadas: `X-SENE-Challenge: <challengeId>`
- En llamadas autenticadas: `X-SENE-Signature: <base64 DER>`

`challengeId` y `signature` viajan únicamente en cabeceras; nunca dentro del JSON firmado. El hash `bodySha256` es SHA-256 de los bytes UTF-8 exactos del cuerpo JSON que se enviará al endpoint de destino. El cuerpo no cambia después de solicitar el reto.

El servidor construye un mensaje canónico UTF-8 con versión, purpose, método, ruta, hash del cuerpo, deviceId o fingerprint provisional, challengeId y nonce aleatorio. Devuelve ese mensaje como `signingMessage` Base64URL. La APK firma los bytes decodificados exactamente; el servidor verifica esos mismos bytes. El reto se consume una vez y expira en 2 minutos. Las llamadas de consulta que no mutan también se firman. La APK calcula SHA-256 del cuerpo exacto que enviará y no puede cambiarlo después de pedir el reto.

Respuesta de error uniforme:
```json
{"error":"LICENSE_EXPIRED","message":"La licencia venció.","requestId":"uuid"}
```
Códigos HTTP: 400 solicitud inválida, 401 identidad/firma no válida, 403 rol o permiso insuficiente, 404 recurso no encontrado, 409 conflicto/uso ya consumido, 410 reto/QR vencido, 429 cuota, 503 servicio o D1 no disponible.

## 4. Endpoints públicos de estado y retos

### `GET /health`
Sin datos privados. Respuesta:
```json
{"service":"SENE licensing API","status":"ok","version":1}
```

### `POST /v1/challenges`
Emite reto para registro inicial o dispositivo ya vinculado.
Solicitud:
```json
{"purpose":"PATRON_ACTIVATE","installationId":"uuid","continuityId":"hex","publicKeyBase64":"...","fingerprint":"hex","targetMethod":"POST","targetPath":"/v1/patron/activate","bodySha256":"hex del cuerpo exacto que se firmará"}
```
Para sesiones existentes, se envían `deviceId`, `targetMethod`, `targetPath` y `bodySha256`; se omiten los datos de clave/instalación porque el servidor recupera la clave pública registrada. Valores implementados para emisión inicial de reto: `PATRON_ACTIVATE`, `VENTAS_PAIR`, `DEVICE_AUTH` y `PATRON_PAIRING_TOKEN`. `PATRON_REPLACEMENT_REQUEST` está implementado para solicitar la sustitución de un dispositivo VENTAS; el alta bootstrap de un PATRÓN perdido sigue pendiente.
Respuesta:
```json
{"challengeId":"uuid","challenge":"base64url","signingMessage":"base64url","expiresAt":unix}
```
El servidor genera el nonce y construye `signingMessage` incluyendo purpose, challengeId, nonce, método, ruta, hash del cuerpo y deviceId o fingerprint provisional. El cliente firma exactamente los bytes de `signingMessage` decodificados desde Base64URL; el campo `challenge` contiene el nonce y no se firma directamente. El endpoint de negocio debe recibir exactamente el cuerpo cuyo hash se incluyó en el reto. El servidor no acepta que el cliente elija el nonce ni el vencimiento.

## 5. Alta y activación inicial

### Operador privado
El alta se crea mediante `POST /v1/operator/licenses/create` (ver sección 5-A). El operador confirma manualmente el pago completo de $580 MXN: $500 de alta y $80 de primera renta. El código de activación solo se entrega tras verificar ambos importes.

### `POST /v1/patron/activate`
Cuerpo:
```json
{"activationCode":"código","installationId":"uuid","continuityId":"hex","publicKeyBase64":"...","fingerprint":"hex"}
```
Requiere reto vigente `PATRON_ACTIVATE`, firma válida y coincidencia de identidad. En una operación D1 atómica registra el dispositivo PATRÓN, consume el código y activa la licencia por 30 días desde la hora del servidor. El Worker exige `setup_paid_at` y `first_rent_paid_at`; si falta cualquiera, no registra el dispositivo ni consume el código. El código es de un solo uso y el servidor conserva únicamente su hash.

Respuesta exitosa:
```json
{"deviceId":"uuid","slot":"PATRON","licenseStatus":"ACTIVE","periodEndsAt":unix}
```

## 5-A. Alta privada y confirmación del pago inicial — implementación en rama

La rama incluye estas operaciones privadas, protegidas con `OPERATOR_TOKEN` (secret del Worker, nunca APK):

- `POST /v1/operator/licenses/create`: requiere `businessName`; crea licencia pendiente con tres espacios y devuelve una sola vez el código de activación. El importe inicial indicado es $580 MXN.
- `POST /v1/operator/licenses/confirm-initial-payment`: requiere `licenseId` y `paymentReference`. Registra dos conceptos confirmados e idempotentes: alta $500 MXN y primera renta $80 MXN. Solo después de esta confirmación puede entregarse el código al cliente.
- `POST /v1/patron/activate`: al registrar PATRÓN, si ambos pagos ya están confirmados, activa la licencia por 30 días desde la hora del servidor. Si falta la primera renta, permanece pendiente.

La confirmación es manual y presupone que el operador verificó el dinero recibido. No hay pasarela de pago automática ni notificación automática de WhatsApp. La interfaz segura de operación y el canal de aviso están pendientes.

## 6. Vinculación de SENE VENTAS por QR

### `POST /v1/patron/pairing-tokens`
Requiere dispositivo PATRÓN autenticado y licencia vigente. El reto usa el propósito `PATRON_PAIRING_TOKEN`; el cuerpo firmado es `{"uses":2}`. El QR se genera con 2 usos máximos y vencimiento de 24 horas. El token aleatorio se almacena únicamente como hash.

**Implementación en Worker (parcial):** emisión firmada de QR y vinculación firmada de VENTAS ya tienen handlers. El alta de VENTAS inserta el dispositivo y descuenta un uso del QR en un `DB.batch`, asignando únicamente slots 2 y 3 y rechazando licencias no activas/vencidas, token vencido/revocado, huellas duplicadas o slots ocupados. El plazo QR se fijó en 24 horas como valor recomendado; puede ajustarse antes de producción. Cuerpo:
```json
{"uses":2}
```
El servidor genera token aleatorio de alta entropía, almacena solo hash, vincula licencia/PATRÓN, fija máximo dos usos y vencimiento. Respuesta:
```json
{"qrPayload":"SENEPAIR1:<token-opaco>","remainingUses":2,"expiresAt":unix}
```
El QR no contiene licenseId ni información del negocio.

### `POST /v1/ventas/pair`
Cuerpo:
```json
{"qrToken":"token-opaco","installationId":"uuid","continuityId":"hex","publicKeyBase64":"...","fingerprint":"hex"}
```
Reto de propósito `VENTAS_PAIR`; firma válida. La transacción verifica licencia activa/vigente, PATRÓN activo, token no revocado/no vencido, usos disponibles, fingerprint no duplicada y slot VENTAS libre; registra equipo y descuenta exactamente un uso de forma atómica. Respuesta:
```json
{"deviceId":"uuid","slot":"VENTAS_1","licenseStatus":"ACTIVE","periodEndsAt":unix}
```
El segundo equipo ocupará `VENTAS_2`. No hay tercer equipo VENTAS.

## 7. Autenticación y estado de licencia

### `POST /v1/device/session`
Dispositivo registrado solicita un reto `DEVICE_AUTH` indicando su `deviceId`, firma el `signingMessage` para el cuerpo `{}` y envía `X-SENE-Device`, `X-SENE-Challenge` y `X-SENE-Signature` en cabeceras. El Worker ya valida la firma, el hash exacto del cuerpo, método/ruta, vigencia y consumo único del reto en este endpoint. Devuelve:
```json
{"deviceId":"uuid","role":"VENTAS","slot":"VENTAS_1","licenseStatus":"ACTIVE","serverTime":unix,"periodEndsAt":unix,"weeklyQuota":{"limit":20,"used":3,"remaining":17,"weekKey":"YYYY-WW"},"payroll":{"configured":true,"dueToday":false,"mexicoDate":"YYYY-MM-DD","paymentDay":15,"paymentDates":[]}}
```
El campo `payroll` solo se devuelve para VENTAS y permite que la APK habilite el envío de nómina únicamente cuando el servidor confirma que es fecha de pago. Para PATRÓN es `null`. No entrega ventas, inventario, caja ni gastos.

## 8. Solicitudes de corrección de venta

**Estado real:** los cuatro endpoints están implementados en el Worker de la rama. Se añadió prueba CI SQLite de autorización y consumo único. Aún falta E2E en Cloudflare y conexión Android; no están desplegados.

### `POST /v1/ventas/corrections`
Solo VENTAS autenticado. Cuerpo:
```json
{"saleId":"id local de venta","reason":"Motivo breve","idempotencyKey":"uuid"}
```
No enviar monto, artículos, cliente ni historial de ventas. El backend obtiene licenseId y deviceId de la sesión firmada. Crea solicitud pendiente. Repetir la misma clave en el mismo dispositivo devuelve el registro existente.

### `POST /v1/patron/corrections/inbox`
Solo PATRÓN autenticado. Cuerpo `{"slot":"VENTAS_1","status":"pending"}`; también admite `VENTAS_2` y `status:"all"`. Devuelve los metadatos mínimos: requestId, saleId, reason, status y fechas. Los equipos se consultan por separado.

### `POST /v1/patron/corrections/decision`
Solo PATRÓN autenticado. Cuerpo `{"requestId":"uuid","decision":"approve"}` o `{"requestId":"uuid","decision":"reject"}`. Aprobación crea un grant único ligado a solicitud, licencia, dispositivo VENTAS y venta. Decisión, grant y auditoría se guardan en un batch D1. No se puede decidir dos veces.

### `POST /v1/ventas/corrections/consume`
Solo el dispositivo VENTAS de la solicitud. Cuerpo `{"requestId":"uuid","grantId":"uuid","saleId":"id"}`. Verifica licencia vigente, dispositivo, venta y permiso aprobado no consumido; marca grant y solicitud consumidos en batch. Una repetición devuelve conflicto. La APK solo habilita una corrección tras respuesta positiva.


## 8-A. Consulta de dispositivos vinculados

### `POST /v1/patron/devices/list`
PATRÓN autenticado, propósito `PATRON_DEVICES_LIST`, cuerpo `{}`. Devuelve únicamente los dispositivos VENTAS activos de la licencia del PATRÓN: identificador, slot, fecha de alta y última conexión. No expone claves públicas ni huellas. Se utiliza para que el titular pueda solicitar la sustitución del equipo correcto.

## 9. Sustitución por pérdida

**Estado real:** el flujo de sustitución de equipos VENTAS está implementado en la rama y tiene pruebas CI SQLite. La migración 0004 conserva el historial; la 0006 impide solicitudes pendientes duplicadas. El flujo no está desplegado ni probado E2E.

### `POST /v1/patron/devices/replacement-request`
PATRÓN autenticado. Cuerpo: `{"deviceId":"uuid del equipo VENTAS perdido","reason":"Equipo perdido"}`. Solo admite Equipo 1 o Equipo 2 de la misma licencia. Crea una solicitud pendiente; el equipo anterior sigue activo hasta la decisión privada.

### Operador privado
- `GET /v1/operator/replacements/pending`: lista solicitudes pendientes con empresa, equipo y motivo.
- `POST /v1/operator/replacements/approve`: cuerpo `{"requestId":"uuid"}`. Revoca el dispositivo perdido, aprueba la solicitud, invalida los QR previos de la licencia y registra auditoría en una operación D1 atómica. El espacio queda libre; el PATRÓN debe generar un QR nuevo y el reemplazo se vincula como VENTAS normal.
- `POST /v1/operator/replacements/reject`: cuerpo `{"requestId":"uuid"}`. Rechaza la solicitud sin revocar el dispositivo.

La API no permite liberar un espacio desde VENTAS. El reemplazo conserva solicitudes/reportes históricos ligados al ID del equipo revocado. La recuperación segura de PATRÓN perdido está implementada mediante código privado de un solo uso, firma bootstrap y reemplazo atómico del dispositivo anterior; falta la prueba E2E en Cloudflare.

## 10. Estado, cuota y renovaciones

**Estado real:** la cuota atómica de 20 operaciones por semana y dispositivo sí está implementada y probada en SQLite temporal. La gestión privada de pagos/renovaciones, suspensión y revocación operativa todavía no está completa. No se debe tratar este contrato como API desplegada.

- El backend calcula expiración; la APK no la puede extender.
- Al vencer: estado `PAST_DUE`; se niegan operaciones remotas. La APK conserva todas sus funciones y datos locales no dependientes de autorización remota.
- El límite es 20 solicitudes remotas autorizadas por semana y dispositivo. Incremento atómico solo después de validar la operación y antes de ejecutar su efecto. Los rechazos por vencimiento o cuota no incrementan.
- Las lecturas de estado, health y retos de bootstrap no consumen cuota; las operaciones de negocio autenticadas sí, de acuerdo con matriz de cuota que se debe fijar antes del lanzamiento.
- Renovación: operador confirma pago con referencia única; la operación es idempotente y agrega 30 días según la regla comercial. No se aceptan importes enviados por APK.
- Se registra auditoría mínima de activación, vinculación, revocación, reemplazo, decisión/consumo de corrección y renovación.

## 11. Tabla de errores estables

| Código | Significado | Conducta APK |
|---|---|---|
| `INVALID_REQUEST` | Campos/formato inválido | Mostrar error, no modificar datos |
| `INVALID_SIGNATURE` | Firma no válida | Denegar operación remota |
| `CHALLENGE_EXPIRED` | Reto vencido/consumido | Solicitar reto nuevo |
| `ACTIVATION_CODE_INVALID` | Código no válido/revocado/usado | Pedir soporte, no borrar identidad |
| `LICENSE_EXPIRED` | Licencia vencida | Mantener operación local |
| `LICENSE_SUSPENDED` | Licencia suspendida | Mantener operación local |
| `PAIRING_FULL` | Dos VENTAS ya vinculados | No crear otro equipo |
| `PAIRING_TOKEN_INVALID` | QR inválido/revocado/vencido | Solicitar QR nuevo |
| `CORRECTION_NOT_PENDING` | Solicitud ya decidida | Actualizar bandeja |
| `GRANT_ALREADY_CONSUMED` | Permiso ya usado | No permitir otra corrección |
| `QUOTA_EXCEEDED` | 20 consultas semanales usadas | Reintentar tras reinicio de semana |
| `SERVICE_UNAVAILABLE` | Worker/D1 no disponible | No autorizar, conservar datos locales |

## 12. Pendientes antes de implementar

- Acordar la regla exacta de alta: el documento comercial exige confirmar $500 de instalación y $80 de primera renta antes de activar el periodo de 30 días.
- Elegir autenticación del operador privado: debe ser identidad individual validada por servidor; nunca una contraseña compartida dentro de la APK. El scaffold actual usa `ADMIN_TOKEN` para una primera herramienta de operador, no como sistema de producción.
- Definir si el QR vence en 24 horas (recomendado) o si se desea otro plazo. El código de activación no vence por tiempo, pero puede revocarse.
- Definir qué endpoints consumen la cuota semanal y si las consultas de bandeja se agrupan para evitar consumo excesivo.
- Implementar pruebas automatizadas de concurrencia para cupos QR, decisiones y consumo de grant.
- Implementar y probar backend antes de cambiar ambas APK o publicar el Worker.


## 12-A. Renovación mensual — endpoints implementados en rama (no desplegados)

La rama incorpora una primera implementación del flujo manual de renovación:

- `POST /v1/patron/renewals/request`: PATRÓN autenticado crea o recupera una única solicitud abierta de renovación para su licencia. Permite que el dispositivo PATRÓN solicite la renovación aunque la licencia esté vencida, siempre que el dispositivo siga activo y la licencia no esté suspendida/revocada.
- `GET /v1/operator/renewals/pending`: consulta privada de solicitudes pendientes. Requiere `Authorization: Bearer <OPERATOR_TOKEN>`; el secreto debe configurarse únicamente como secret del Worker y nunca en APK.
- `POST /v1/operator/renewals/authorize`: acción privada después de verificar manualmente el pago recibido. Recibe `requestId` y `paymentReference`, registra un pago confirmado de $80 MXN, genera un código de 12 caracteres de un solo uso y devuelve el código una sola vez al operador.
- `POST /v1/patron/renewals/redeem`: PATRÓN presenta `requestId` y `authorizationCode` mediante challenge y firma del dispositivo. Consume el código ligado a licencia, solicitud y dispositivo, y extiende 30 días desde el mayor valor entre la fecha actual del servidor y el vencimiento anterior.
- `POST /v1/operator/renewals/cancel`: operador cancela una solicitud pendiente o revoca un código emitido aún no consumido. La cancelación queda auditada.

El código no tiene caducidad temporal automática. Una solicitud abierta evita duplicados por licencia; una renovación cancelada ya no se puede canjear. Las llamadas firmadas de PATRÓN consumen la cuota semanal conforme a la regla general.

**Limitación pendiente:** todavía no existe integración con WhatsApp Business/API ni notificación automática al número oficial. Por ahora el operador tendría que consultar la bandeja privada. Tampoco existe aún una interfaz privada de operador terminada. La API no se ha desplegado y las APK no la llaman.

## 13. Matriz de implementación verificada (2026-11-09)

| Función | Código Worker en rama | Prueba CI | Producción |
|---|---|---|---|
| Health | Implementado | Sintaxis | No desplegado |
| Emisión y verificación de challenges | Implementado para purposes declarados | Sintaxis/SQLite | No desplegado |
| Sesión de dispositivo | Implementado | Sintaxis | No desplegado |
| Activación inicial PATRÓN | Parcial; depende de pago/código cargados por operador | Sintaxis | No desplegado |
| QR PATRÓN y vinculación VENTAS | Implementado en Worker | Sintaxis | No desplegado |
| Solicitudes de trabajador y bandeja PATRÓN | Implementado en Worker | Sintaxis/SQLite | No desplegado |
| Decisiones de solicitudes | Implementado en Worker | Sintaxis/SQLite | No desplegado |
| Reportes de cierre y nómina | Implementado en Worker | Sintaxis/SQLite | No desplegado |
| Cuota 20 por semana | Implementado con UPSERT condicional atómico | Prueba 20/21 aprobada | No desplegado |
| Historial de dispositivos / un activo por slot | Migración 0004 | Prueba de referencias e integridad aprobada | Migración no aplicada |
| Correcciones de venta | Implementadas: solicitud idempotente, bandeja por equipo, decisión y grant de un uso | Prueba CI SQLite añadida | No desplegado / falta E2E y Android |
| Reemplazo autorizado de VENTAS | Implementado: solicitud PATRÓN, aprobación/rechazo privada, revocación e invalidación QR | CI SQLite añadido | No desplegado / falta E2E |
| Recuperación de PATRÓN perdido | Pendiente; requiere recuperación de identidad/bootstrap segura | No | No |
| Renovación mensual por código manual | Implementada en Worker y migración 0005 | Prueba SQL/CI aprobada; falta E2E | No |
| Autenticación robusta de operador | Solo scaffold temporal `ADMIN_TOKEN` | No | No |

### Infraestructura comprobada en archivos

El `wrangler.toml` de la rama apunta a:
- Worker: `sene-licensing-api`
- Binding: `DB`
- D1: `sene-licencias`
- ID D1: `22f73e97-e43e-44f1-870b-58fad88e7028`

Ese ID coincide con el recurso D1 que el usuario creó. Esto solo confirma la configuración versionada; no prueba que el Worker del panel Cloudflare haya sido actualizado ni que las migraciones se hayan aplicado en la D1 real.

### Regla de despliegue

No desplegar ni conectar APK hasta que las filas pendientes de correcciones, recuperación/reemplazo, pagos/renovación y operador tengan implementación, pruebas automatizadas y una verificación E2E controlada. Mantener los datos comerciales en los teléfonos.


**Protección de activación:** el Worker exige la confirmación de los dos pagos (alta $500 y primera renta $80) antes de registrar el PATRÓN o consumir el código. Si falta uno, el código permanece utilizable y la licencia pendiente.


### Recuperación de códigos privados (implementada en rama)

- `POST /v1/operator/licenses/reissue-activation-code`: cuerpo `{"licenseId":"uuid"}`. Solo permite reemitir si alta y primera renta están confirmadas, la licencia sigue pendiente y no existe PATRÓN activo. Invalida el hash anterior y devuelve el código nuevo una sola vez.
- `POST /v1/operator/renewals/reissue-code`: cuerpo `{"requestId":"uuid"}`. Solo permite rotar el código de una renovación autorizada con pago mensual confirmado. Invalida el código anterior y devuelve el nuevo una sola vez.
- Ningún código se almacena en texto claro. Ambas acciones requieren autenticación privada de operador y quedan auditadas. No hay recuperación del código antiguo; se emite uno nuevo.


**Contador independiente por equipo:** la respuesta de `POST /v1/patron/requests/inbox` incluye `pendingByTeam` con `VENTAS_1` y `VENTAS_2`. Cada número suma solicitudes operativas pendientes y correcciones de venta pendientes del dispositivo activo en ese slot. Cero se representa sin notificación (botón rojo); uno o más muestra botón verde con el número exacto. Consultar o atender una solicitud actualiza el conteo sin mezclar historiales de equipos.


**Lectura de notificaciones (migración 0008):** cada solicitud operativa y cada corrección tiene su propio `seen_at`. Al abrir la bandeja del Equipo 1 o 2 se marcan como vistas únicamente las notificaciones pendientes de ese equipo y categoría; el estado de la solicitud permanece `pending` hasta que el patrón aprueba o rechaza. El contador por equipo suma solo notificaciones pendientes aún no vistas. Así el botón puede pasar de verde con número exacto a rojo al consultar, sin borrar solicitudes ni historial.


## Recuperación de SENE PATRÓN perdido

**Implementación en rama:** existe un flujo privado de recuperación. El operador solo lo inicia después de verificar la identidad del titular y el negocio por los canales oficiales.

- `POST /v1/operator/patron-recovery/create`: requiere `licenseId` y `reason`; exige que exista un PATRÓN activo en la licencia. Devuelve un código aleatorio de un solo uso, sin vencimiento temporal. Solo se almacena su hash.
- `GET /v1/operator/patron-recovery/pending`: bandeja privada de solicitudes pendientes.
- `POST /v1/operator/patron-recovery/reissue-code`: requiere `recoveryRequestId`; rota el hash e invalida el código anterior.
- `POST /v1/operator/patron-recovery/cancel`: cancela una recuperación pendiente.
- `POST /v1/patron/recover`: nueva instalación PATRÓN envía `recoveryCode` más identidad bootstrap y firma un reto `PATRON_RECOVERY`.

La recuperación exitosa revoca el PATRÓN anterior, invalida los QR de vinculación previos, registra el nuevo PATRÓN en el mismo slot 1 y consume el código en un batch D1. Conserva historial de licencia y de los dos equipos VENTAS. Si la licencia está vencida, el nuevo PATRÓN queda recuperado pero debe renovar antes de usar funciones remotas. El código no se puede reutilizar.

Este flujo está en GitHub, pero no está desplegado ni probado E2E contra Cloudflare.


## Nómina por equipo y validación de fecha de pago

- Migración `0010_payroll_settings.sql`: configuración separada por slot VENTAS_1/VENTAS_2, sueldo base en centavos, día fijo mensual y/o fechas específicas.
- `POST /v1/patron/payroll/settings/get`: PATRÓN consulta ambas configuraciones.
- `POST /v1/patron/payroll/settings/set`: PATRÓN guarda sueldo y fechas para un solo equipo.
- `POST /v1/ventas/payroll-reports`: el Worker comprueba la fecha local de `America/Mexico_City` contra la configuración del slot de origen antes de aceptar el reporte. Si no corresponde, devuelve `PAYROLL_NOT_DUE`; si no hay configuración, `PAYROLL_NOT_CONFIGURED`.
- La identidad del slot procede del dispositivo firmado, nunca del campo enviado por VENTAS.


Los reportes de nómina conservan el historial reciente en `requests` y separan el conjunto del periodo en `payrollRequestIds`. Para el cálculo, PATRÓN utiliza `payrollEntries`, que el servidor construye consultando las solicitudes y decisiones autoritativas de D1 dentro del ciclo entre reportes; no confía en estados ni cantidades de descuento enviados por el APK VENTAS. Los reintentos idempotentes devuelven el reporte original almacenado.
