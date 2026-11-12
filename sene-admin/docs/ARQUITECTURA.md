# Arquitectura de SENE ADMINISTRADOR

## Componentes
- Cliente futuro: aplicación Android/Web SENE ADMINISTRADOR.
- API central: Cloudflare Worker `sene-licensing-api`.
- Datos operativos: Cloudflare D1 existente.
- Evidencias temporales: bucket privado Cloudflare R2, separado por entorno.
- Auditoría: D1, sin almacenar imágenes ni secretos.

## Separación por entornos
- Desarrollo/pruebas: Worker de pruebas y D1 `sene-licencias-pruebas`; bucket R2 de pruebas independiente.
- Producción: Worker y D1 productivos; bucket R2 productivo independiente.
- Nunca reutilizar el binding, bucket, token o base de producción en pruebas.
- La estructura no crea recursos Cloudflare ni modifica recursos existentes.

## Módulos de la app
- Dashboard: indicadores y alertas.
- Empresas: consulta y estado de licencias.
- Pagos: solicitudes pendientes, comprobante temporal, validación manual y confirmación.
- Equipos: los tres slots exactos por empresa.
- Reposiciones/renovaciones: folios, solicitudes y códigos.
- Notificaciones: cola, entrega y ACK.
- Soporte: números oficiales y datos de contacto.
- Auditoría: quién hizo qué, cuándo y sobre qué solicitud.

## Límites de autoridad
Solo un usuario con permiso `payments.confirm` puede confirmar pagos. La app no debe confiar en importes, estados ni identidad enviados por el cliente; el Worker valida el estado actual y calcula el importe esperado. Los comprobantes sirven como evidencia visual auxiliar, no como prueba automática de transferencia.

## Ciclo de pago
1. Se crea solicitud con ID y folio únicos.
2. Se reserva el nombre comercial durante 48 horas según hora oficial del servidor.
3. El cliente adjunta opcionalmente una imagen de comprobante al almacenamiento privado temporal.
4. El administrador verifica la transferencia en la fuente bancaria oficial.
5. Al confirmar, D1 registra estado, actor, fecha, folio e importe.
6. El comprobante pasa a eliminación; R2 borra el objeto y el backend conserva solo metadatos mínimos y auditoría.
7. Si la eliminación falla, una cola de limpieza reintenta sin revertir la confirmación del pago.

La confirmación del pago y la eliminación de la imagen son operaciones distintas: una falla de almacenamiento nunca debe deshacer una confirmación bancaria válida.