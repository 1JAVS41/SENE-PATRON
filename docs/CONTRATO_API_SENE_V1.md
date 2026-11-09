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
Para sesiones existentes, se envían `deviceId`, `targetMethod`, `targetPath` y `bodySha256`; se omiten los datos de clave/instalación porque el servidor recupera la clave pública registrada. Valores implementados para emisión inicial de reto: `PATRON_ACTIVATE`, `VENTAS_PAIR`, `DEVICE_AUTH`. `DEVICE_RECOVERY` queda pendiente de diseño e implementación.
Respuesta:
```json
{"challengeId":"uuid","challenge":"base64url","signingMessage":"base64url","expiresAt":unix}
```
El servidor genera el nonce y construye `signingMessage` incluyendo purpose, challengeId, nonce, método, ruta, hash del cuerpo y deviceId o fingerprint provisional. El cliente firma exactamente los bytes de `signingMessage` decodificados desde Base64URL; el campo `challenge` contiene el nonce y no se firma directamente. El endpoint de negocio debe recibir exactamente el cuerpo cuyo hash se incluyó en el reto. El servidor no acepta que el cliente elija el nonce ni el vencimiento.

## 5. Alta y activación inicial

### Operador privado — `POST /v1/admin/licenses`
Requiere autenticación de operador verificada en servidor; el secreto de administración solo vive como secret de Worker. Cuerpo:
```json
{"businessName":"Nombre del negocio","setupPaymentReference":"folio opcional"}
```
Crea licencia `PENDING_SETUP`, los tres slots fijos y un código aleatorio de activación de un solo uso. Respuesta única:
```json
{"licenseId":"uuid","activationCode":"código mostrado una sola vez","slots":["PATRON","VENTAS_1","VENTAS_2"],"status":"PENDING_SETUP"}
```
El operador confirma el pago de instalación de $500 MXN en una acción privada separada y auditable.

### `POST /v1/patron/activate`
Cuerpo:
```json
{"activationCode":"código","installationId":"uuid","continuityId":"hex","publicKeyBase64":"...","fingerprint":"hex"}
```
Condiciones: código válido/no revocado/no usado; reto vigente de propósito `PATRON_ACTIVATE`; firma válida; pago de instalación confirmado; no hay PATRON vinculado. El código se consume en la misma transacción que registra el PATRÓN. No inicia los 30 días hasta confirmar la primera renta mensual y completar el alta comercial según la política de pagos.

**Implementación en Worker (parcial):** el handler verifica firma, identidad, hash del código y `setup_paid_at`; inserta el slot PATRON y consume el código en un `DB.batch`. La licencia queda `pending` y la respuesta `PENDING_PAYMENT`. La confirmación privada del pago de instalación y la primera renta todavía deben implementarse; por ello este endpoint no puede completar una activación comercial hasta que el flujo privado registre `setup_paid_at`. Respuesta:
```json
{"deviceId":"uuid","slot":"PATRON","licenseStatus":"PENDING_PAYMENT","periodEndsAt":null}
```

El operador confirma por separado la primera mensualidad de $80 MXN. Al confirmar, backend activa licencia por 30 días. Las renovaciones confirmadas agregan 30 días al vencimiento futuro; si ya venció, empiezan desde la confirmación. La confirmación de un pago tiene identificador único para impedir doble extensión.

## 6. Vinculación de SENE VENTAS por QR

### `POST /v1/patron/pairing-tokens`
Requiere dispositivo PATRÓN autenticado y licencia vigente. Cuerpo:
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
{"deviceId":"uuid","role":"VENTAS","slot":"VENTAS_1","licenseStatus":"ACTIVE","serverTime":unix,"periodEndsAt":unix,"weeklyQuota":{"limit":20,"used":3,"remaining":17,"weekKey":"YYYY-WW"}}
```
No entrega ventas, inventario, caja ni gastos.

## 8. Solicitudes de corrección de venta

### `POST /v1/ventas/corrections`
Solo VENTAS autenticado. Cuerpo:
```json
{"saleId":"id local de venta","reason":"Motivo breve"}
```
No enviar monto, artículos, cliente ni historial de ventas. El backend obtiene licenseId y deviceId de la sesión firmada. Crea solicitud pendiente. Respuesta:
```json
{"requestId":"uuid","status":"pending","createdAt":unix}
```
Idempotencia: cada solicitud lleva `Idempotency-Key` UUID; repetir la misma clave devuelve el mismo resultado sin duplicar.

### `GET /v1/patron/corrections?slot=VENTAS_1&status=pending`
Solo PATRÓN autenticado. Lista metadatos mínimos:
```json
{"items":[{"requestId":"uuid","slot":"VENTAS_1","saleId":"id","reason":"Motivo","status":"pending","createdAt":unix}]}
```
Nunca devuelve contenido de la venta.

### `POST /v1/patron/corrections/{requestId}/decision`
Solo PATRÓN autenticado. Cuerpo:
```json
{"decision":"approve"}
```
o `{"decision":"reject"}`. Aprobación crea un grant único ligado al request, license, device y sale. Decisión y grant se guardan atómicamente. No se puede decidir dos veces. Respuesta:
```json
{"requestId":"uuid","status":"approved","grantId":"uuid","usesAllowed":1}
```

### `POST /v1/ventas/corrections/consume`
Solo el dispositivo VENTAS al que pertenece la solicitud. Cuerpo:
```json
{"requestId":"uuid","grantId":"uuid","saleId":"id"}
```
Transacción atómica comprueba que grant aprobado, no consumido, del mismo license/device/sale y que licencia sigue autorizada para operaciones remotas; marca grant consumido y request `consumed`. Respuesta:
```json
{"authorized":true,"requestId":"uuid","saleId":"id","consumedAt":unix,"usesRemaining":0}
```
Una repetición devuelve `409 GRANT_ALREADY_CONSUMED`. La APK solo habilita una corrección tras respuesta positiva del servidor.

## 9. Sustitución por pérdida

### `POST /v1/patron/devices/{deviceId}/replacement-request`
PATRÓN autenticado. Cuerpo: `{"reason":"Equipo perdido"}`. Marca solicitud pendiente; no libera el slot todavía.

### Operador privado — `POST /v1/admin/replacements/{requestId}/approve`
Solo operador autenticado. Revoca dispositivo anterior, invalida sesiones/QR relacionados y libera el mismo slot en una transacción. La siguiente vinculación requiere nuevo QR del PATRÓN. Mantiene el máximo de tres espacios y registra auditoría. Nunca permite al cliente liberar un slot por sí mismo.

## 10. Estado, cuota y renovaciones

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
