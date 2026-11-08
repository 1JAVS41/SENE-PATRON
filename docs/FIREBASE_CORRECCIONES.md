# Flujo Firebase: autorizaciones de corrección SENE

## Principio de operación
SENE VENTAS realiza localmente ventas, inventario, caja, gastos, horarios y administración. Los reportes se comparten por WhatsApp. No se suben ventas, inventarios ni reportes a Firebase.

Firebase se usa exclusivamente para enviar una solicitud explícita de corrección de una venta y recibir la decisión del patrón. No existe cuota semanal de consultas: se evita el gasto con consultas bajo demanda, sin sondeo periódico.

## Flujo
1. El trabajador selecciona una venta concreta y envía una solicitud con motivo. La app crea una solicitud pendiente asociada a su licencia y espacio (EQUIPO 1 o EQUIPO 2).
2. Si ya existe una solicitud pendiente para esa misma venta y equipo, se reutiliza/indica la pendiente; no se crea otra solicitud duplicada.
3. SENE PATRÓN muestra pendientes separadas por equipo. El patrón revisa los datos mínimos de la venta y el motivo.
4. El patrón acepta o rechaza. Rechazar cierra la solicitud sin conceder permiso.
5. Aceptar concede un permiso de un solo uso, ligado a la licencia, equipo, identificador de venta y solicitud. SENE VENTAS consume el permiso al aplicar esa corrección. Un permiso consumido, vencido o ligado a otra venta no puede reutilizarse.

## Modelo Firestore propuesto
- licenses/{licenseId}/correctionRequests/{requestId}
  - teamSlot: 1 o 2
  - saleId: identificador local estable de la venta
  - workerInstallationId: identidad vinculada del equipo
  - reason: motivo escrito por el trabajador
  - status: PENDING, APPROVED, REJECTED, CONSUMED
  - createdAt, decidedAt, consumedAt
  - oneTimeGrantId: identificador opaco del permiso emitido al aceptar
- La unicidad de pendientes se protege en backend por combinación de licencia + equipo + venta. La creación debe ser transaccional.
- La decisión y emisión del permiso deben realizarse en una operación de backend confiable. La app patrón no debe poder inventar grants localmente.
- El consumo debe ser atómico en backend: validar licencia, equipo, venta, estado aprobado y que no exista consumo previo; marcar como consumido en la misma transacción.

## Reglas de ahorro
- SENE VENTAS no mantiene listeners de Firebase durante la operación normal.
- Al enviar una solicitud: una escritura. No enviar la solicitud si ya existe una pendiente local para esa venta.
- SENE PATRÓN escucha/lee pendientes solo al abrir la bandeja de autorizaciones; al salir de ella, cancela el listener.
- Mientras el menú de equipos esté abierto, puede existir una sola suscripción a solicitudes pendientes de la licencia; la app separa el conteo por equipo en memoria. Sin temporizadores ni polling.
- SENE VENTAS comprueba el resultado al volver a la solicitud o al intentar aplicar la corrección, no continuamente.
- No guardar datos completos de venta, inventario ni caja en Firestore; solo los identificadores mínimos y el motivo necesario.

## Requisitos antes de activar el servicio real
La integración no debe considerarse activa hasta incorporar la configuración Firebase del proyecto, Authentication/identidad de licencia, reglas Firestore y una función backend confiable para aprobar/rechazar y consumir grants. Las reglas deben impedir que SENE VENTAS apruebe solicitudes o que cualquier cliente cambie directamente el estado a APPROVED o CONSUMED.