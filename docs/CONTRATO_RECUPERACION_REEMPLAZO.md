# Contrato de recuperación y reemplazo de equipos SENE

Estado: diseño técnico para revisión; **no habilitado en producción**.
Fecha: 2026-11-09.

## Objetivo y límites

Permitir sustituir un teléfono perdido o dañado sin borrar su historial ni permitir que una instalación nueva se apropie de una licencia por conocer el nombre del negocio, el número de espacio o el identificador Android.

Una licencia conserva tres espacios fijos:
- slot 1: SENE PATRÓN.
- slot 2: SENE VENTAS Equipo 1.
- slot 3: SENE VENTAS Equipo 2.

El reemplazo crea un nuevo `device_id`. Nunca se reutiliza ni se modifica la clave pública del dispositivo anterior.

## Principio de seguridad

La posesión del nombre de empresa, `continuityId`, `installationId`, número telefónico o un código de solicitud **no autentica** por sí sola al titular ni autoriza un reemplazo.

La recuperación debe autorizarla el operador privado autenticado fuera de las APK, después de verificar manualmente la solicitud y la titularidad/pago por los canales oficiales. Ninguna credencial de operador ni `ADMIN_TOKEN` se incluye en SENE VENTAS o SENE PATRÓN.

## Flujo propuesto

1. La instalación nueva genera su par P-256 en Android Keystore y conserva la clave privada local.
2. Desde el flujo de recuperación, la app obtiene un challenge de un solo uso y firma la solicitud con la clave nueva. El servidor valida la prueba criptográfica de esa instalación no registrada.
3. La solicitud incluye únicamente:
   - tipo de app (`PATRON` o `VENTAS`);
   - slot solicitado para VENTAS, si aplica;
   - nombre de empresa declarado;
   - identificadores de instalación/continuidad y clave pública/huella;
   - motivo y una clave de idempotencia.
   La app no puede seleccionar libremente una licencia ni desplazar un equipo activo.
4. El servidor guarda una solicitud pendiente y devuelve un identificador no secreto. No revela datos de licencia ni acepta el dispositivo.
5. El operador privado revisa el caso y aprueba o rechaza desde un canal autenticado separado. La decisión queda auditada y es de un solo uso.
6. En caso de aprobación, el servidor emite una autorización opaca de recuperación vinculada a solicitud, licencia, slot, tipo de app, huella nueva y expiración/estado de uso. No es un código genérico transferible.
7. La instalación presenta la autorización y prueba de posesión de la misma clave privada. El servidor consume autorización, revoca el dispositivo anterior y registra el nuevo dispositivo en el slot en una transacción atómica.
8. El servidor invalida los pairing tokens pendientes emitidos por el PATRÓN anterior cuando el slot 1 sea reemplazado.
9. El nuevo dispositivo consulta su sesión y obtiene su rol/slot. Las referencias históricas permanecen ligadas al ID anterior.

## Reglas de autorización

- Para sustituir VENTAS, la autorización debe identificar exactamente slot 2 o 3 y el dispositivo activo que se reemplazará.
- Para sustituir PATRÓN, la autorización debe identificar slot 1. La instalación PATRÓN nueva no puede autoaprobarse usando el QR o la clave del PATRÓN perdido.
- Si ya no existe dispositivo activo en el slot, el operador puede autorizar una recuperación del espacio vacío, sin inventar un dispositivo anterior.
- Una solicitud pendiente no bloquea indefinidamente el espacio; el operador puede cancelarla.
- No permitir dos autorizaciones vigentes para la misma solicitud/slot.
- Un token aprobado solo se consume una vez. Reintentos con la misma clave de idempotencia devuelven el resultado original sin crear otro equipo.
- Rechazar si licencia suspendida, revocada, vencida o si el slot no coincide.
- La aprobación no confirma pagos ni amplía vigencia; son procesos separados.
- Toda decisión y cambio debe escribirse en `audit_log`.

## Endpoints propuestos (no implementados)

- `POST /v1/recovery/requests`: solicitud firmada con challenge de bootstrap para clave nueva.
- `POST /v1/recovery/status`: consulta de estado firmada por la misma clave nueva y ligada al ID de solicitud.
- Operación privada de operador para revisar y aprobar/rechazar. Debe vivir detrás de autenticación del operador; no debe aceptar `ADMIN_TOKEN` enviado por una APK.
- `POST /v1/recovery/complete`: presenta autorización opaca y prueba de posesión; consumo atómico y alta del nuevo dispositivo.

Los nombres son propuestas de contrato, no rutas disponibles.

## Datos/migración que faltan

La tabla actual `replacement_requests` no contiene tipo de aplicación, nueva instalación, nueva huella/clave, idempotencia, autorización opaca ni estado de consumo. Antes de implementar endpoints, agregar una migración aditiva que:
- incorpore esos datos con límites y restricciones;
- separe estado de solicitud de estado de autorización;
- garantice unicidad de idempotencia;
- registre expiración/revocación/consumo de la autorización;
- permita auditar actor operador y dispositivo anterior/nuevo.

No guardar claves privadas, tokens de QR en claro ni secretos de operador.

## Pruebas obligatorias

1. Solicitud firmada válida y firma inválida.
2. No revelar si una licencia existe cuando la instalación no está autorizada.
3. Aprobación de operador válida; rechazo y cancelación.
4. Token ligado a otra huella, slot, licencia o tipo: rechazado.
5. Reutilización de token: rechazada.
6. Dos solicitudes concurrentes para un mismo slot: solo una puede completarse.
7. Fallo entre revocación e inserción: rollback total, nunca dejar dos activos ni dejar el slot accidentalmente vacío.
8. Sustitución de VENTAS conserva solicitudes, reportes, uso semanal y autorizaciones históricas.
9. Sustitución de PATRÓN invalida pairing tokens anteriores.
10. Reintentos de red idempotentes no crean dispositivos duplicados.
11. Cuota semanal, vigencia y estado de licencia se aplican sin permitir bypass.
12. `PRAGMA foreign_key_check` e `integrity_check` sin errores.

## Estado de implementación

- Migración 0004 de historial de dispositivos: creada y probada en SQLite temporal.
- Prueba de retención de referencias históricas y slot único activo: GitHub Actions run `42707459022`, success.
- Endpoints de recuperación y autorización de operador: pendientes.
- Integración Android: pendiente.
- D1 real y Worker Cloudflare: sin cambios; no desplegar todavía.
