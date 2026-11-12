# Consolidación SENE PATRÓN y Worker

## Base seleccionada

La rama de consolidación se basa en `integration/ack-universal`, no en `sene-cloudflare-backend`.

La auditoría de GitHub mostró que `integration/ack-universal` estaba 128 commits por delante de `sene-cloudflare-backend` y contenía capacidades necesarias para el sistema completo:
- Autenticación administrativa `/v1/admin/login` y cierre de sesión.
- Sesiones administrativas revocables y eventos durables con ACK.
- Contrato de folio de pago y pruebas específicas.
- Migraciones adicionales y pruebas de ACK universal.
- Flujos recientes de nómina, inventario y auditoría.

La rama anterior `consolidation/patron-unificada`, creada desde `sene-cloudflare-backend`, queda superada por esta rama y no debe utilizarse para generar entregas.

## Rama activa

`consolidation/patron-unificada-v2`

## Cambios propios de la consolidación

- Se conserva la aplicación Android avanzada de la rama base.
- Se aplica la identidad visual azul/verde de SENE, conservando el logotipo original.
- La actividad principal queda fijada en orientación vertical.
- Las restauraciones gratuitas del mismo teléfono actualizan la clave pública y huella dentro del mismo registro de dispositivo.
- Se conserva el mismo `deviceId`, slot, reportes, solicitudes, renovaciones y referencias de auditoría.
- Los QR pendientes se revocan durante la restauración y el cambio de huella queda auditado.
- Se amplían las pruebas SQLite para comprobar restauración PATRÓN y VENTAS sin cambiar el `deviceId`.

## Límite criptográfico importante

Android Keystore no permite exportar ni reconstruir una clave privada eliminada al desinstalar la aplicación. Por eso, después de reinstalar en el mismo teléfono se genera una nueva clave P-256 y una nueva huella pública. El servidor valida la continuidad del mismo perfil/teléfono y los datos registrados, pero conserva el mismo `deviceId` y el mismo espacio de licencia. No se crea una licencia ni un slot nuevo.

## Estado de validación

- La sintaxis del Worker y las suites de autenticación/ACK/folios/migraciones deben pasar en GitHub Actions para esta rama.
- La APK debe compilar, verificar package name, etiqueta y logotipo, e iniciar en emulador Android 35.
- El Worker no se despliega desde esta rama automáticamente; las pruebas E2E contra D1/Worker de pruebas quedan pendientes.
- No se despliega ni modifica producción.
- La liberación comercial requiere APK Release firmada y pruebas en teléfonos reales.

## Pendientes de cierre

1. Confirmar las suites Worker y SQLite de esta rama.
2. Confirmar compilación Android y smoke test de arranque.
3. Configurar los cuatro secretos de autenticación ADMIN únicamente en el entorno de pruebas y verificar el inicio de sesión.
4. Desplegar manualmente esta rama al Worker/D1 de pruebas cuando se autorice esa validación.
5. Probar QR de ambos slots, restauración, solicitudes, correcciones, reportes, nómina, renovación y reposición en teléfonos reales.
6. Preparar APK Release firmada y comprobar instalación/actualización.

## Bloqueos detectados en el Worker de pruebas

El despliegue aislado de pruebas terminó correctamente y el endpoint `/health` respondió `status=ok`. El registro de despliegue confirmó que aún faltan:
- `SENE_TEST_CONTACTS_SIGNING_PRIVATE_JWK`: sin esta clave, AYUDA firmado no estará disponible y PATRÓN debe ocultar contactos no verificables.
- Los cuatro secretos `SENE_TEST_ADMIN_*`: sin ellos, el login de SENE ADMIN responde `ADMIN_AUTH_NOT_CONFIGURED`.

Estos secretos no se inventan ni se incrustan en la APK o en el repositorio. Se deben configurar en GitHub Actions del repositorio `1JAVS41/SENE-PATRON` antes de dar por terminada la integración real de AYUDA y ADMIN.
