# Retención y eliminación de comprobantes de pago

## Objetivo
Las capturas de comprobante son temporales. Deben eliminarse del almacenamiento del servidor después de que el pago haya sido verificado y confirmado por el administrador.

## Diseño de almacenamiento
- Binario: Cloudflare R2 privado.
- Metadatos: D1 (ID de pago, object key aleatoria, MIME validado, bytes, checksum opcional, fecha de carga, estado).
- Nunca almacenar el binario Base64 en D1.
- Nunca usar nombres de archivo proporcionados por el cliente como object key.
- No publicar el bucket ni indexar imágenes.

## Estados
`not_uploaded` → `pending_review` → `pending_delete` → `deleted`.

En error de eliminación: `pending_delete` → `retrying` → `deleted`.

Un pago confirmado sin captura queda con `not_uploaded`; la confirmación no depende de que exista imagen.

## Regla de borrado
El borrado se inicia únicamente después de una confirmación bancaria registrada correctamente en D1. La solicitud de borrado se inserta en una cola durable dentro de la misma operación lógica. El consumidor elimina el objeto R2 y marca el registro como `deleted`. Si R2 devuelve error o hay timeout, se conserva la tarea con contador de intentos y próximo intento.

La operación de borrado debe aceptar repetición: borrar un objeto inexistente se considera éxito. No se debe borrar evidencia de pagos aún pendientes ni rechazados automáticamente; esos casos requieren una política de expiración separada y aprobada.

## Datos que sí se conservan
- Folio único de pago/solicitud.
- ID de empresa y solicitud.
- Importe y referencia bancaria verificada.
- Estado, fecha y actor que confirmó.
- Metadatos de evidencia y estado de eliminación, sin conservar la imagen.
- Opcional: SHA-256 de la imagen para trazabilidad de integridad sin posibilidad práctica de reconstruirla.

## Datos que no se conservan tras confirmar
- Archivo de imagen original.
- Copias temporales, thumbnails y derivados.
- URL firmada de visualización.
- Base64 o contenido binario en logs.

## Seguridad ante fallos
La confirmación bancaria y la limpieza son procesos separados. Si el borrado falla, el pago sigue confirmado y la cola reintenta. Si el proceso se reinicia, la cola durable permite continuar. Se requiere reconciliación periódica de objetos huérfanos.

## Estado actual
Documento de diseño. El Worker actual no dispone aún de flujo de carga de imágenes de comprobantes ni binding R2 para este propósito. Por tanto, esta regla está definida para implementar y probar antes de habilitar el módulo de pagos en SENE ADMINISTRADOR; no se afirma que imágenes actuales ya se estén borrando.