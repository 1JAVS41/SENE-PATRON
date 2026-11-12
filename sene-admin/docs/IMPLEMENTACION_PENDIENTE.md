# Lista de implementación pendiente

## Infraestructura
- [ ] Crear bucket R2 privado de pruebas.
- [ ] Crear binding R2 solo en configuración de pruebas.
- [ ] Diseñar migración D1 versionada para metadatos de evidencia y cola de borrado.
- [ ] Crear bucket R2 y binding de producción solo después de pruebas y autorización explícita.
- [ ] Configurar límites de tamaño, CORS/origen, rate limit y política de expiración.

## Worker/API
- [ ] Implementar carga temporal con URL firmada y validación de contenido.
- [ ] Implementar lectura temporal autenticada.
- [ ] Implementar confirmación administrativa con auditoría D1.
- [ ] Implementar cola durable de borrado R2 tras confirmación.
- [ ] Implementar reintentos y reconciliación de objetos huérfanos.
- [ ] Probar idempotencia, concurrencia, caídas de R2 y reinicios.
- [ ] Mantener intactos los endpoints actuales de VENTAS/PATRÓN.

## Cliente SENE ADMINISTRADOR
- [ ] Definir tecnología y repositorio Android/Web.
- [ ] Diseñar login individual y MFA.
- [ ] Implementar dashboard y módulos de pagos/licencias/equipos.
- [ ] Integrar contratos API versionados.
- [ ] No incrustar secretos administrativos en el cliente.

## Pruebas de aceptación
- [ ] Una captura pendiente puede verla solo un administrador autorizado.
- [ ] Un usuario VENTAS/PATRÓN no puede listar ni descargar comprobantes.
- [ ] Pago pendiente/rechazado no dispara borrado.
- [ ] Confirmar pago crea exactamente una tarea de borrado.
- [ ] Repetir confirmación no duplica efectos.
- [ ] Si R2 falla, pago permanece confirmado y borrado se reintenta.
- [ ] Tras borrar, el objeto no puede descargarse; metadatos/auditoría permanecen.
- [ ] No se usa ni modifica producción durante pruebas.