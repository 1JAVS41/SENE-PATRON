# SENE ADMINISTRADOR — estructura preparada

Este directorio reserva el espacio del futuro panel de administración central de SENE. **No es todavía una aplicación operativa** y no debe desplegarse ni conectarse a producción.

## Principios
- Un único backend Cloudflare Workers + D1 compartido por SENE VENTAS, SENE PATRÓN y SENE ADMINISTRADOR.
- El administrador es el único rol que puede revisar pagos y confirmar pagos reales; la captura o el comprobante nunca confirma un pago por sí solo.
- La aplicación administradora no tendrá acceso directo a D1 ni a R2. Toda operación pasa por endpoints autenticados del Worker.
- Separación estricta entre pruebas y producción. Esta estructura no cambia el Worker productivo ni la base D1 productiva.
- Las APK de VENTAS/PATRÓN no deben contener credenciales administrativas.

## Estructura
- `docs/ARQUITECTURA.md`: módulos, permisos y flujo operativo.
- `docs/API_CONTRACT.md`: contrato HTTP previsto para la futura app.
- `docs/SEGURIDAD.md`: roles, sesiones, auditoría y protección de comprobantes.
- `docs/RETENCION_COMPROBANTES.md`: ciclo de vida y eliminación posterior a confirmación.
- `docs/IMPLEMENTACION_PENDIENTE.md`: tareas para habilitar el producto.

## Módulos previstos
1. Inicio y métricas operativas.
2. Empresas y licencias.
3. Solicitudes de alta, renovación y reposición.
4. Bandeja de pagos: referencia/folio, importe esperado, fecha, comprobante temporal y decisión.
5. Gestión de dispositivos (PATRÓN + VENTAS 1 + VENTAS 2).
6. Notificaciones y eventos pendientes de ACK.
7. Soporte y contactos oficiales.
8. Auditoría y diagnóstico técnico.

## Regla de almacenamiento de comprobantes
Las imágenes se almacenarán en Cloudflare R2 privado; D1 conservará solo metadatos mínimos. Al confirmar el pago, el backend marcará la evidencia como eliminable y borrará el objeto de R2. La operación será idempotente y tendrá reintentos si R2 no responde. Se conservará el registro de auditoría de la confirmación, pero no la imagen.

## Estado
Estructura documental y contratos iniciales. No hay todavía interfaz Android/Web de SENE ADMINISTRADOR, login administrativo de producción, bucket R2 creado ni flujo de carga de comprobantes habilitado.