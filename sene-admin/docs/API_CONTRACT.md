# Contrato API previsto — SENE ADMINISTRADOR

Todos los endpoints serán servidos por el Worker central. Rutas propuestas; no habilitadas todavía.

## Sesión y permisos
- `POST /v1/admin/session` — iniciar sesión con identidad administrativa.
- `POST /v1/admin/session/refresh` — renovar sesión.
- `POST /v1/admin/session/revoke` — cerrar sesión.
- `GET /v1/admin/me` — identidad y permisos efectivos.

No usar el secreto de operador actual como credencial permanente dentro de una APK. La futura autenticación deberá emitir sesiones cortas, revocables y con permisos por rol.

## Panel
- `GET /v1/admin/dashboard`
- `GET /v1/admin/audit`

## Empresas, licencias y dispositivos
- `GET /v1/admin/companies`
- `GET /v1/admin/companies/{companyId}`
- `GET /v1/admin/licenses/{licenseId}`
- `GET /v1/admin/devices/{deviceId}`

## Pagos y comprobantes
- `GET /v1/admin/payments/pending`
- `POST /v1/admin/payments/{paymentId}/proof-upload` — solicitar URL de carga temporal firmada.
- `POST /v1/admin/payments/{paymentId}/confirm` — confirmar tras verificación bancaria real.
- `POST /v1/admin/payments/{paymentId}/reject` — rechazar con motivo.
- `GET /v1/admin/payments/{paymentId}` — metadatos y estado; no exponer URL pública del objeto.

La descarga/visualización de evidencia será mediante URL firmada de muy corta duración y solo tras comprobar permiso. No habrá bucket público ni enlaces permanentes.

## Política de confirmación
El endpoint de confirmación debe:
1. Validar sesión, permiso `payments.confirm`, CSRF/origen cuando corresponda y rate limit.
2. Comprobar solicitud, folio, importe esperado y estado pendiente.
3. Registrar actor, fecha del servidor, referencia bancaria y decisión en una transacción D1.
4. Encolar la eliminación del objeto de evidencia con clave idempotente.
5. Responder con estado confirmado y estado de limpieza independiente.

## Respuesta de confirmación
Campos previstos: `paymentId`, `status`, `confirmedAt`, `confirmedBy`, `proofRetentionStatus` (`pending_delete`, `deleted`, `retrying`, `not_uploaded`). Nunca devolver el contenido binario ni secretos.

## Integración con SENE ADMINISTRADOR
Los contratos se versionarán y compartirán entre el Worker y el cliente. Las rutas existentes de VENTAS/PATRÓN no se cambiarán por construir este módulo.