# Flujo de solicitudes, cierre de turno, nómina y notificaciones

Estado: requisitos aprobados para implementación. Este documento no afirma que los endpoints estén implementados ni desplegados.

## Reglas obligatorias

- Las solicitudes del trabajador se envían a SENE PATRÓN inmediatamente al crearse. No se espera al cierre de turno.
- El servidor solo transporta y registra solicitudes y decisiones. No es chat y no contiene mensajes libres ni medios de comunicación.
- Las decisiones del patrón se guardan en el servidor y quedan disponibles para el equipo VENTAS correspondiente.
- Al pulsar **Cerrar turno**, VENTAS genera un reporte de cierre y lo entrega tanto al número de WhatsApp configurado localmente como al servidor.
- El reporte de cierre se genera una sola vez por turno. Debe tener una clave estable de turno y un identificador idempotente. Si no hay Internet, se conserva en una cola local persistente y se reintenta al recuperar conexión; el servidor debe aceptar reintentos sin duplicar el reporte.
- Los reportes habituales que ya existen mantienen su funcionamiento y destinatarios. No se cambia el número local de WhatsApp.
- En el día de pago, VENTAS genera un reporte resumido de nómina y lo envía al servidor. SENE PATRÓN realiza el cálculo; no se envían ventas, inventario, caja ni datos comerciales.
- La identidad del dispositivo determina el equipo. No se acepta un número de equipo enviado libremente por el cliente.

## Separación de equipos en SENE PATRÓN

- Equipo 1 corresponde al dispositivo con slot `VENTAS_1`; Equipo 2 corresponde a `VENTAS_2`.
- Solicitudes, respuestas, trabajador, sueldo, calendario de pago, descuentos autorizados, reportes e historial son independientes por dispositivo.
- Cada botón muestra el número de notificaciones pendientes de su propio equipo.
- Cero pendientes: estado visual rojo y sin contador.
- Una o más pendientes: estado visual verde y contador exacto (1, 2, 3...).
- Una notificación deja de contar como pendiente al atenderse/consultarse según su tipo; la decisión del patrón no debe borrar el historial.
- Las solicitudes rechazadas no generan descuentos. Faltas/retardos descuentan solo si el patrón activa expresamente el descuento al aprobar. Préstamos/consumos descuentan únicamente cuando el patrón autoriza ese descuento.

## Datos mínimos y privacidad

- `work_requests`: tipo, detalle estrictamente necesario, estado, decisión y dispositivo origen.
- `shift_reports`: resumen de cierre por turno, separado por dispositivo.
- `payroll_reports`: resumen del periodo de pago, separado por dispositivo.
- No almacenar ni transmitir ventas completas, artículos, inventario, caja, clientes, credenciales WhatsApp, conversaciones ni archivos multimedia.
- Respuestas y decisiones no modifican automáticamente ventas, inventario ni caja.

## Endpoints añadidos al Worker (pendientes de pruebas end-to-end)

Todos los endpoints de negocio exigen reto de un solo uso y firma ECDSA P-256 del dispositivo registrado, además de licencia vigente. Las rutas y propósitos ya se añadieron al allowlist de retos del Worker. La implementación requiere pruebas de sintaxis, migración, concurrencia e integración con Android antes de habilitar clientes.

- `POST /v1/ventas/requests`: crear solicitud inmediata; clave idempotente.
- `POST /v1/patron/requests/inbox`: consultar solicitudes pendientes y contador por slot.
- `POST /v1/patron/requests/decision`: aprobar/rechazar una solicitud; incluir si autoriza descuento y su importe/regla cuando aplique.
- `POST /v1/ventas/requests/updates`: recuperar decisiones destinadas al dispositivo.
- `POST /v1/ventas/shift-reports`: guardar el reporte de cierre; único por dispositivo y `shiftKey`.
- `POST /v1/ventas/payroll-reports`: guardar el resumen de nómina; único por dispositivo y `periodKey`.
- `POST /v1/patron/reports/inbox`: obtener reportes de cierre y nómina por equipo, nunca combinados entre trabajadores.

Las consultas deben agruparse cuando sea posible para evitar llamadas innecesarias. No usar listeners permanentes ni polling frecuente. La sincronización debe ser por eventos: al crear solicitud, al consultar bandeja, al responder y al cerrar turno/día de pago.

## Estado de esta entrega

Se añadió la migración aditiva 0003 y los handlers firmados del Worker para crear solicitudes, consultar bandeja/contadores, aprobar o rechazar, recuperar decisiones y guardar/consultar cierres de turno y reportes de nómina. Las inserciones de solicitudes y reportes son idempotentes por equipo y clave de origen. El contador se calcula por slot y solo incluye solicitudes pendientes.

La migración es local al repositorio: **no debe ejecutarse todavía en la base D1 real**. Falta validar la sintaxis del Worker y las rutas contra D1, agregar pruebas de concurrencia/idempotencia, conectar ambos clientes Android, construir el cierre de turno con entrega local a WhatsApp y cola offline, implementar la pantalla/contadores de SENE PATRÓN y probar todo end-to-end. No se ha desplegado el Worker ni se han modificado las APK.


**Contador independiente por equipo:** la respuesta de `POST /v1/patron/requests/inbox` incluye `pendingByTeam` con `VENTAS_1` y `VENTAS_2`. Cada número suma solicitudes operativas pendientes y correcciones de venta pendientes del dispositivo activo en ese slot. Cero se representa sin notificación (botón rojo); uno o más muestra botón verde con el número exacto. Consultar o atender una solicitud actualiza el conteo sin mezclar historiales de equipos.


**Lectura de notificaciones (migración 0008):** cada solicitud operativa y cada corrección tiene su propio `seen_at`. Al abrir la bandeja del Equipo 1 o 2 se marcan como vistas únicamente las notificaciones pendientes de ese equipo y categoría; el estado de la solicitud permanece `pending` hasta que el patrón aprueba o rechaza. El contador por equipo suma solo notificaciones pendientes aún no vistas. Así el botón puede pasar de verde con número exacto a rojo al consultar, sin borrar solicitudes ni historial.
