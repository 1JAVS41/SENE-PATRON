# Auditoría inicial de ACK y entregas SENE

Fecha: 2026-11-12  
Rama base auditada: `sene-cloudflare-backend`  
Worker auditado: `cloudflare/sene-api/src/worker.js` (HEAD `07da2298`)

## Resultado comprobado

La implementación actual tiene un ACK específico para el paquete de día de pago:
- Propósito firmado `PATRON_PAYDAY_ACK`.
- Ruta `POST /v1/patron/payday/ack`.
- Función `acknowledgePaydayBundle`.
- El ACK comprueba que la entrega pertenece a la licencia, evita repetir el cambio de estado y elimina snapshots diarios después de marcar la entrega como ACK.

No existe todavía un protocolo ACK general para todos los flujos. La lista `CHALLENGE_TARGETS` contiene consultas de inbox, notificaciones, historial, reportes y snapshots, pero no se observa un ACK equivalente para esas entregas.

## Brechas por flujo detectadas en el Worker

| Flujo actual | Comportamiento observado | Trabajo requerido |
|---|---|---|
| PATRÓN solicitudes `/v1/patron/requests/inbox` | Descarga la bandeja y calcula contadores; no confirma persistencia local | Entrega durable/cursor y ACK por lote |
| PATRÓN correcciones `/v1/patron/corrections/inbox` | Descarga solicitudes de corrección; no confirma persistencia local | Unificar con inbox y ACK por cursor |
| PATRÓN notificaciones `/v1/patron/notifications` | Devuelve contadores pendientes; no es recibo de entrega | Derivar contadores del inbox durable |
| PATRÓN reportes `/v1/patron/reports/inbox` | Consulta reportes de turno/nómina y entradas relacionadas; límite de 50/500; sin cursor ni ACK | Lote incremental, cursor y ACK |
| VENTAS decisiones `/v1/ventas/requests/updates` | Consulta por marca de tiempo `since`; sin ACK | Cursor monotónico y ACK tras persistencia local |
| VENTAS historial `/v1/ventas/requests/history` | Descarga historial limitado; sin ACK | Bootstrap incremental con cursor/versión y ACK |
| VENTAS reportes de cierre/nómina | `saveReport` guarda en servidor y devuelve recibo; no hay ACK de que PATRÓN lo guardó | Entrega durable al destinatario y ACK de PATRÓN |
| VENTAS snapshots diarios | `saveDailyInventory` guarda snapshots; no hay ACK de recepción del paquete diario por PATRÓN | Conservar hasta ACK de paquete |
| PATRÓN paquete de día de pago | Ya tiene `deliveryId` y ACK idempotente | Mantenerlo y corregir limpieza/compactación posterior al ACK |
| ADMIN eventos | Aún no existe app/bandeja/endpoints administrativos operativos | Construir inbox administrativo separado y ACK propio |

## Riesgos concretos

1. PATRÓN puede consultar reportes repetidamente y descargar hasta 50 reportes por equipo sin cursor ni ACK.
2. El historial de VENTAS usa marcas de tiempo y límites; puede repetir registros y no garantiza confirmación de aplicación local.
3. Los contadores y las bandejas no son una única fuente durable y deben consolidarse.
4. El ACK de día de pago borra snapshots de origen, pero el código actual no compacta `payday_deliveries.payload_json` a un recibo pequeño. La copia íntegra del inventario puede permanecer duplicada.
5. El Worker consume la cuota de operación en `signedDeviceContext`; los reintentos deben deduplicarse antes de consumir cuota.
6. El ACK de día de pago confirma por `deliveryId`, pero el contrato futuro debe ligar además `ackId`, cursor y hash del paquete para validar que el cliente guardó exactamente la entrega recibida.
7. Una respuesta HTTP exitosa no prueba que el dispositivo haya persistido el resultado localmente.

## Migraciones

La carpeta `cloudflare/sene-api/migrations` contiene migraciones repetidas con prefijos 0011, 0012 y 0013. Las migraciones existentes no deben renumerarse ni modificarse. La última numeración observada es `0016_daily_inventory_payday_delivery.sql`; la siguiente migración nueva debe comenzar en `0017` y seguir secuencia única.

Antes de aplicar cualquier migración:
- revisar el esquema y el estado real de D1 de pruebas;
- validar SQL en una base de pruebas aislada;
- actualizar tests de Worker;
- no ejecutar migraciones ni despliegues en producción.

## Orden técnico

1. Implementar recibos idempotentes de operaciones originadas por el cliente.
2. Implementar entregas durables por destinatario/flujo con cursor monotónico.
3. Implementar ACK firmado por lote, idempotente y ligado a hash.
4. Migrar inbox, correcciones, reportes, decisiones, configuración y snapshots al protocolo.
5. Integrar persistencia local y ACK en VENTAS y PATRÓN.
6. Crear SENE ADMIN con inbox independiente y ACK.
7. Añadir pruebas de reintento, caída de red, apagado, ACK duplicado, cursor incompleto, hash incorrecto y aislamiento de slots/roles.

La especificación normativa y transversal está en el repositorio SENE-ADMIN, archivo `docs/PROTOCOLO_ACK_UNIVERSAL.md`. Este documento registra las brechas observadas en el Worker actual y no afirma que el protocolo esté implementado.
