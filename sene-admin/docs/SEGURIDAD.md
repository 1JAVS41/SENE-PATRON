# Seguridad — SENE ADMINISTRADOR

- Autenticación individual; no compartir una clave maestra dentro de la APK.
- Roles iniciales: `super_admin`, `payments_reviewer`, `support_readonly`, `auditor_readonly`.
- Permisos mínimos por acción; confirmar/rechazar pagos requiere permiso explícito.
- MFA recomendado para cuentas con permiso de pago.
- Tokens de sesión de corta duración, revocables y guardados en Android Keystore cuando el cliente sea Android.
- Toda operación administrativa registra actor, acción, entidad, fecha del servidor y resultado.
- No guardar imágenes de comprobantes en D1, GitHub, logs, Analytics ni almacenamiento público.
- No registrar tokens, códigos de autorización, datos bancarios completos ni URLs firmadas en logs.
- Limitar MIME a JPEG/PNG/WebP, tamaño máximo definido en servidor, validar firma real del archivo y generar nombre aleatorio; rechazar SVG/HTML y formatos ejecutables.
- Bucket R2 privado, cifrado en tránsito, sin acceso anónimo y con separación por entorno.
- URL de lectura firmada de vida muy corta; no guardar la URL firmada en D1.
- Eliminar evidencia al confirmar el pago; conservar solo referencia/folio, huella criptográfica opcional, tamaño/tipo, marcas de tiempo y actor de confirmación, según necesidad operativa.
- La limpieza se ejecuta en backend, nunca depende de que la APK permanezca abierta.
- La eliminación debe ser idempotente y reintentable. Si falla, no revierte la confirmación de pago y genera alerta técnica.
- Retención máxima de evidencia pendiente y política de solicitudes expiradas deberán configurarse antes de habilitar cargas.
- Nunca utilizar credenciales de pruebas en producción ni viceversa.