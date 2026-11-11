# SENE Licensing API (Cloudflare Workers + D1)

Backend en construcción para SENE PATRÓN / SENE VENTAS. Objetivo: Cloudflare Workers Free + D1 Free, sin Firebase Blaze, tarjeta ni plan de pago.

## Estado real en esta rama

El Worker incluye actualmente:

- `GET /health`.
- Retos firmados de dos minutos ligados a método, ruta, hash del cuerpo, propósito e identidad.
- Verificación ECDSA P-256 compatible con Android Keystore (firma DER convertida a P-1363 para WebCrypto), consumo de reto de un solo uso y validación de dispositivo.
- Registro inicial solicitado desde SENE PATRÓN, nombre de empresa reservado mientras la solicitud está abierta, confirmación manual y auditable de $500 + $80, código único entregado solo tras verificar el pago y activación por 30 días después de canjearlo.
- Dos QR independientes de un solo uso, fijos a VENTAS_1 y VENTAS_2; se recupera el mismo QR pendiente tras cerrar la app. El token se conserva cifrado con AES-GCM en D1.
- Sesión de dispositivo y cuota semanal atómica de 20 operaciones remotas por instalación.
- Solicitudes de trabajador, bandeja y decisiones separadas por equipo, actualizaciones de respuesta, reportes de cierre de turno y reportes de nómina.
- Solicitud de renovación y canje de código de un solo uso; código no caduca por tiempo y queda ligado a solicitud, licencia y PATRÓN.
- Reemplazo autorizado de Equipo 1/2: solicitud desde PATRÓN, bandeja privada de operador, aprobación/rechazo, revocación del equipo anterior, invalidación de QR y liberación del mismo slot.
- Correcciones de venta: solicitud idempotente, bandeja por equipo, aprobación/rechazo y permiso ligado a una venta, dispositivo y licencia, consumible una sola vez.
- Alta y operaciones privadas de operador protegidas por secreto del Worker. El secreto nunca debe incluirse en las APK.

## Integración Android actual en la rama

SENE PATRÓN ya contiene una primera integración Android real, aún no validada E2E:

- Identidad P-256 en Android Keystore con clave privada no exportable.
- Cliente HTTPS firmado con retos de dos minutos y hash del cuerpo exacto.
- Activación inicial y recuperación de PATRÓN con códigos de un solo uso.
- Consulta de sesión/licencia, creación/recuperación de QR fijo de un solo uso por equipo y vinculación de VENTAS.
- Consulta de dispositivos vinculados y solicitud de reemplazo.
- Bandejas separadas por Equipo 1 y Equipo 2, aprobación/rechazo de solicitudes y correcciones.
- Contadores independientes de notificaciones: rojo con 0 y verde con el número exacto cuando hay pendientes.
- Configuración separada de sueldo/día de pago y consulta de reportes de cierre y nómina por equipo.
- Solicitud y canje de renovación mensual.

SENE VENTAS ya incluye cliente HTTPS firmado, vinculación QR, solicitudes de trabajador, recepción de respuestas, cola local de cierres de turno y envío de reportes de nómina. La integración sigue pendiente de E2E y de ajustes de disponibilidad de envío en la fecha de pago.

**Importante:** la interfaz Android y el cliente firmado no hacen que el servicio esté operativo por sí solos. La API aún no está desplegada en Cloudflare y la D1 real todavía no tiene las migraciones 0002–0013. No introducir la URL de Hello World como servidor productivo ni activar equipos hasta completar el entorno de pruebas.

## Panel privado de reposiciones

La ruta `/operator/replacements` muestra la bandeja de reposiciones de VENTAS y permite:
- consultar solicitudes pendientes de pago y pagos ya autorizados;
- registrar la referencia del pago y solicitar la autorización;
- emitir o recuperar el mismo código de un solo uso tras validar el pago;
- copiar el código para entregarlo manualmente solo al número oficial AYUDA.

El panel pide `OPERATOR_TOKEN` en cada sesión y lo mantiene únicamente en memoria del navegador; no lo guarda en almacenamiento local. El Worker vuelve a validar el token en cada endpoint y verifica que el teléfono destino sea un contacto AYUDA oficial. El código se conserva cifrado en D1 para permitir recuperar la misma autorización si se pierde la respuesta.

**El panel no envía WhatsApp automáticamente.** El operador debe copiar el código y entregarlo por el canal oficial AYUDA. Nunca configurar `OPERATOR_TOKEN` en una APK ni compartirlo con clientes.

## Estado de despliegue

**El código está en GitHub, pero no está desplegado en el Worker de Cloudflare.** El Worker remoto continúa en el estado de prueba Hello World. La D1 real contiene únicamente la migración inicial 0001; las migraciones 0002–0014 todavía no se aplican allí.

No desplegar ni aplicar migraciones remotas hasta completar revisión y pruebas E2E en un entorno de pruebas, y recibir autorización explícita.

## Verificación automatizada

El workflow `.github/workflows/cloudflare-check.yml` ejecuta:

1. `node --check` para detectar errores de sintaxis.
2. Migraciones 0001–0013 sobre SQLite temporal e `integrity_check`.
3. Prueba del límite semanal de 20 operaciones y rechazo de la número 21.
4. Pruebas de renovación, pago inicial de $580 y activación por 30 días.
5. Pruebas de historial y reemplazo de dispositivos, unicidad de solicitudes pendientes, revocación e invalidación de QR.
6. Prueba del permiso de corrección de un solo uso.
7. Prueba de que el código de activación no se consume si falta confirmar la primera renta.

Último resultado comprobado al actualizar este documento: CI exitoso para el commit `288c8f21ca50d01d51615760e70c18e29d00d87d`. Estas pruebas SQLite no sustituyen pruebas de extremo a extremo contra Workers/D1 reales.

## Migraciones y base D1

- Base D1: `sene-licencias`.
- ID: `22f73e97-e43e-44f1-870b-58fad88e7028`.
- Binding del Worker: `DB`.
- Migraciones versionadas: 0001 a 0014 (con numeración repetida en algunos prefijos; se aplican por nombre de archivo).
- La migración 0001 ya se aplicó manualmente a la D1 real. **No volver a ejecutarla.**
- Las migraciones 0002–0014 solo se han probado en CI sobre SQLite temporal.

## Pendientes antes de producción

1. Probar E2E la recuperación segura de un PATRÓN perdido (el flujo y cliente Android ya existen en la rama).
2. Sustituir el mecanismo temporal de secreto de operador por un proceso privado de operación seguro; nunca incluir secretos en APK.
3. Completar idempotencia/recuperación segura del código de alta si la respuesta privada se pierde.
4. Revisar exhaustivamente transacciones, límites, reintentos, concurrencia y errores D1.
5. Ejecutar E2E en un Worker y D1 de pruebas, incluidos retos vencidos/replay, pairing concurrente, pagos duplicados, cuota, reemplazos y correcciones.
6. Completar la integración visual/funcional de los módulos restantes de ambas APK y probarlos en teléfonos reales.
7. Compilar y probar ambas APK en dispositivos reales, con y sin Internet.
8. Integrar notificaciones WhatsApp Business API solo si se habilita un proveedor oficial; actualmente no están automatizadas.

## Reglas de continuidad

- Ventas, caja, inventario y gastos permanecen localmente en SENE VENTAS; no se sincronizan al servidor.
- Si falla Internet, servidor o cuota, SENE VENTAS conserva sus funciones comerciales locales.
- Ningún fallo remoto debe borrar datos locales ni conceder permisos.
- Nunca poner `ADMIN_TOKEN` u `OPERATOR_TOKEN` en las APK.
- Mantener Cloudflare Workers y D1 en plan Free; no activar Workers Paid ni Firebase Blaze.


## Recuperación de códigos

Se implementaron `POST /v1/operator/licenses/reissue-activation-code` y `POST /v1/operator/renewals/reissue-code`. Rotan el hash del código, invalidan el anterior, exigen pago confirmado y dejan auditoría. Los códigos no se guardan en texto claro. Migración 0007 añade `authorized_by` a renovaciones. CI debe aplicar 0001–0013. Para QR recuperables, configurar PAIRING_TOKEN_ENCRYPTION_KEY como secreto del Worker: 64 caracteres hexadecimales aleatorios (32 bytes). Sin este secreto el servidor rechaza emitir QR, nunca almacena tokens en claro.


**Lectura de notificaciones (migración 0008):** cada solicitud operativa y cada corrección tiene su propio `seen_at`. Al abrir la bandeja del Equipo 1 o 2 se marcan como vistas únicamente las notificaciones pendientes de ese equipo y categoría; el estado de la solicitud permanece `pending` hasta que el patrón aprueba o rechaza. El contador por equipo suma solo notificaciones pendientes aún no vistas. Así el botón puede pasar de verde con número exacto a rojo al consultar, sin borrar solicitudes ni historial.


## Recuperación pagada de PATRÓN perdido

La reposición del equipo SENE PATRÓN cuesta **$500 MXN**. El cliente inicia una solicitud desde AYUDA con nombre de empresa, correo y teléfono registrados. El concepto de pago debe ser exactamente `Reposición SENE PATRÓN`. Las solicitudes repetidas reutilizan la solicitud pendiente de la licencia; el operador verifica el comprobante y entrega el código únicamente por los números oficiales AYUDA.

El código es de un solo uso, se almacena solo como hash y queda ligado a la instalación y huella criptográfica del teléfono que creó la solicitud. La reemisión invalida el código anterior y conserva esa misma vinculación. Al canjearlo, el Worker revoca el PATRÓN anterior, invalida los QR pendientes, registra el nuevo dispositivo en el mismo slot 1, conserva los dos slots VENTAS y transfiere cualquier solicitud de mensualidad abierta al nuevo PATRÓN. La solicitud de recuperación y el consumo del código se procesan de forma transaccional. El endpoint heredado de recuperación manual gratuita está retirado y devuelve `PAID_RECOVERY_REQUIRED`.

La migración 0013 crea los campos de contacto registrado y la tabla de solicitudes de reposición pagada. El cliente Android PATRÓN incluye el formulario y el campo para introducir el código. La identidad lógica de instalación se deriva de `ANDROID_ID` y del paquete de la aplicación para conservarse al reinstalar en el mismo teléfono; la clave P-256 se vuelve a crear en Android Keystore. El endpoint `POST /v1/patron/restore` permite recuperar sin costo la vinculación únicamente si el servidor confirma que la continuidad del teléfono coincide con el PATRÓN activo y que empresa, correo y teléfono coinciden. La restauración revoca la clave anterior, invalida QR pendientes y transfiere cualquier mensualidad abierta. No funciona para un teléfono distinto; para un equipo perdido se mantiene la reposición pagada de $500 MXN. Si existe una solicitud de reposición pagada pendiente, se debe completar ese flujo en lugar de la restauración gratuita. Para licencias antiguas que no tengan correo/teléfono, el operador dispone de `POST /v1/operator/licenses/register-legacy-contacts`, protegido por `OPERATOR_TOKEN`; solo registra los datos si ambos campos estaban vacíos y deja auditoría. No permite sobrescribir contactos ya registrados. Ambos flujos aún requieren pruebas E2E en un entorno Cloudflare de pruebas; no están desplegados en producción.


## Nómina por equipo

Migración 0010 añade sueldo y fechas de pago por separado para VENTAS_1 y VENTAS_2. PATRÓN puede consultar/guardar el sueldo base, día fijo mensual y/o fechas específicas. El Worker valida en servidor que el reporte de nómina se envíe solo en una fecha configurada para el slot real del equipo, usando America/Mexico_City. Si no está configurado o no es día de pago, rechaza el envío.


## Cambios recientes de registro y QR (migraciones 0011–0012)

- Registro inicial iniciado desde la APK PATRÓN con identidad del teléfono firmada; una solicitud pendiente por instalación y una reserva única por nombre normalizado.
- El alta cuesta $580 MXN: $500 de configuración + $80 de primera mensualidad. El concepto de pago debe contener únicamente el nombre exacto de la empresa. La solicitud es idempotente y no crea la licencia activa antes de confirmar el pago.
- Operación privada de operador: consultar solicitudes pendientes y autorizar una sola vez después de revisar el comprobante. El código se entrega al operador para que lo comunique exclusivamente por los números oficiales de AYUDA; no hay envío automático por WhatsApp integrado.
- El canje del código queda ligado a la identidad PATRÓN que creó la solicitud. Solo entonces se crea el dispositivo PATRÓN y se activa la licencia por 30 días.
- QR independientes: VENTAS_1/Equipo 1 (slot 2) y VENTAS_2/Equipo 2 (slot 3), cada uno de un solo uso, sin vencimiento temporal y ligado a empresa/licencia/slot/operación. Cerrar la app no crea otro QR: el servidor recupera el mismo token cifrado.
- La operación REPLACEMENT solo puede generar QR después de que el operador haya aprobado la reposición del slot correspondiente.
- Requiere configurar PAIRING_TOKEN_ENCRYPTION_KEY en Cloudflare Workers antes de habilitar la generación de QR. El secreto no debe incluirse en APK ni en Git.
- Datos bancarios y teléfonos oficiales AYUDA aún deben estar registrados/configurados antes de presentar la experiencia como operativa al cliente.


## Reposición de SENE PATRÓN por pérdida del equipo

- Desde AYUDA, el cliente abre «PERDÍ MI EQUIPO SENE PATRÓN» e introduce nombre de empresa, correo registrado y teléfono registrado.
- El servidor valida los tres datos contra los contactos guardados en la licencia. El registro inicial solicita y guarda correo y teléfono para permitir esta comprobación.
- Al pulsar «YA REALICÉ EL PAGO», se crea una solicitud idempotente por licencia. El pago es de $500 MXN y el concepto debe ser exactamente «Reposición SENE PATRÓN».
- El cliente envía primero el comprobante a uno de los números oficiales de AYUDA. La solicitud queda en la cola privada del operador. Tras comprobar el pago, el operador autoriza y recibe un código de un solo uso; debe entregarlo al cliente exclusivamente por un número oficial AYUDA.
- Al canjear el código en el nuevo teléfono, se revoca el PATRÓN anterior y se recupera la misma licencia y espacios VENTAS 1 y 2. La solicitud se marca consumida.
- Endpoints privados de operador: GET /v1/operator/patron-recovery-payments/pending y POST /v1/operator/patron-recovery-payments/authorize.
- Requiere aplicar la migración 0013 antes de habilitar este flujo en producción. No se despliega ni se modifica la D1 real desde este cambio.
