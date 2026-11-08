# Modelo de renta y administración de licencias SENE

## Decisiones comerciales

- Una licencia representa un negocio completo; no se venden licencias separadas por aplicación.
- Cada licencia admite exactamente 3 espacios: 1 SENE PATRÓN y 2 SENE VENTAS.
- Cuota de instalación y vinculación inicial: $500 MXN, pago único.
- Renta: $80 MXN cada 30 días.
- Límite inicial: 20 consultas autorizadas por semana para cada instalación (SENE PATRÓN, SENE VENTAS 1 y SENE VENTAS 2). Máximo teórico: 60 consultas por semana por licencia.
- Ventas, caja, inventario y gastos permanecen locales. No se sincronizan con Firebase.
- Las consultas a Firebase son bajo demanda; no se implementa polling periódico.
- Los precios son importes comerciales configurados; el backend debe almacenar importes en centavos enteros (50000 y 8000) y moneda MXN.

## Separación de roles (obligatoria)

Hay dos tipos de panel y no deben confundirse:

1. **Panel privado del operador SENE**: solo el propietario de la plataforma puede dar de alta negocios, registrar pagos, renovar, suspender y reactivar licencias. Debe autenticar al operador mediante Firebase Authentication y validar su rol en backend. No se debe habilitar por una contraseña compartida dentro de la APK de los clientes.
2. **SENE PATRÓN de cada negocio**: solo puede consultar el estado de su propia licencia y administrar sus dos espacios SENE VENTAS. Nunca puede listar ni modificar licencias de otros negocios.

No se deben incluir acciones globales de operador en la APK que se entrega a todos los clientes. La interfaz privada del operador debe desplegarse separadamente o protegerse mediante identidad y autorización de servidor verificadas.

## Modelo de datos Firestore propuesto

### `licenses/{licenseId}`

- `businessName`: nombre del negocio.
- `status`: `PENDING_SETUP`, `ACTIVE`, `PAST_DUE`, `SUSPENDED` o `CANCELLED`.
- `currency`: `MXN`.
- `setupFeeAmount`: `50000` (centavos).
- `monthlyRentAmount`: `8000` (centavos).
- `setupPaidAt`: timestamp o null.
- `periodStartAt`: timestamp o null.
- `periodEndAt`: timestamp o null.
- `gracePeriodDays`: `0` inicialmente; cualquier periodo de gracia requiere decisión comercial explícita.
- `createdAt`, `updatedAt`: timestamps del servidor.
- `deviceSlots`: mapa fijo con `patron`, `sales1`, `sales2`; cada espacio guarda solo installationId, estado y timestamps mínimos.

### `licenses/{licenseId}/payments/{paymentId}`

- `type`: `SETUP` o `MONTHLY_RENT`.
- `amount`: centavos enteros.
- `currency`: `MXN`.
- `status`: `PENDING_VERIFICATION`, `CONFIRMED` o `REJECTED`.
- `method`: referencia descriptiva del medio de pago, sin almacenar datos bancarios sensibles.
- `reference`: referencia/folio opcional.
- `reportedAt`, `confirmedAt`, `confirmedBy`: auditoría.

### `licenses/{licenseId}/usage/{installationId}_{weekKey}`

- `installationId`: instalación registrada en uno de los tres espacios.
- `weekKey`: periodo semanal calculado por servidor, zona horaria `America/Mexico_City`.
- `used`: contador de consultas autorizadas consumidas.
- `limit`: 20.
- `updatedAt`: timestamp del servidor.

## Reglas de negocio

### Alta inicial

1. El operador crea la licencia en estado `PENDING_SETUP`.
2. Registra el pago único de $500 MXN y lo confirma tras verificarlo.
3. Vincula un máximo de tres instalaciones: un espacio PATRÓN y dos espacios VENTAS.
4. Cuando el alta y la vinculación estén completas, el backend activa la licencia e inicia el primer periodo de 30 días solo cuando se haya confirmado también el primer pago mensual de $80 MXN. El pago de instalación no sustituye la primera mensualidad.

### Renovación mensual manual

1. El negocio paga $80 MXN.
2. El operador registra y confirma el pago desde el panel privado.
3. Una función backend extiende el periodo 30 días. Si la licencia aún está vigente, añade 30 días al vencimiento actual; si ya venció, inicia el nuevo periodo desde la confirmación.
4. Se registra el pago y la acción en auditoría. La app cliente solo vuelve a consultar el estado de su propia licencia.

### Vencimiento

- El estado y vencimiento son calculados y escritos por backend, nunca por el dispositivo cliente.
- Al vencer, el backend cambia la licencia a `PAST_DUE` o `SUSPENDED` según la política que configure el operador.
- La suspensión nunca borra ni modifica ventas, caja, inventario, gastos ni archivos locales.
- La aplicación informa el estado y restringe únicamente las funciones remotas/licenciadas que se definan. La política exacta de bloqueo de funciones locales debe aprobarse antes de activarla.

### Cuota de consultas

- El límite inicial es 20 por semana y por instalación, no 20 para todo el paquete.
- Cada una de las tres instalaciones tiene su contador independiente: hasta 60 por licencia en total por semana.
- El backend calcula la semana y realiza la comprobación e incremento atómicos en una transacción.
- Una solicitud denegada por licencia vencida o por cuota agotada no incrementa el contador.
- Los clientes no pueden escribir ni reiniciar sus propios contadores.
- El contador mide solicitudes remotas autorizadas de SENE; no equivale necesariamente a una sola lectura/escritura de Firestore. El número real de operaciones y costos se medirá con pruebas y métricas de facturación.

## Seguridad obligatoria

- No confiar en importes, fechas, estados, contadores, slots ni roles enviados por la APK.
- Todas las acciones de alta, confirmación de pagos, renovación, suspensión, reactivación, vinculación y consumo de cuota deben pasar por backend autenticado y autorizado.
- Las reglas Firestore deniegan por defecto escrituras de clientes a pagos, estado de licencia, fechas, roles y contadores.
- SENE PATRÓN y SENE VENTAS solo acceden a la licencia asignada y a su propio espacio.
- El operador SENE debe tener un rol privado verificado por backend; ocultar botones o pantallas no es una medida de seguridad.
- No guardar números completos de tarjetas, contraseñas bancarias ni información financiera sensible.

## Criterios de aceptación antes de cobrar a clientes

1. Una licencia creada contiene exactamente los tres espacios previstos.
2. El pago inicial de instalación se registra una sola vez.
3. Sin confirmación de la instalación y de la primera mensualidad no se activa el servicio.
4. Cada renovación confirmada agrega exactamente 30 días según la regla anterior.
5. Un pago duplicado no extiende dos veces el vencimiento.
6. Una instalación no puede consumir la cuota de otra.
7. El límite de 20 se aplica de forma atómica por instalación y semana.
8. Un cliente no puede modificar su vencimiento, pagos, estado ni cuota aunque manipule la APK.
9. La suspensión no elimina datos locales.
10. Las métricas de Firebase y Cloud Functions se verifican con carga simulada antes de estimar un costo mensual definitivo.

## Estado de implementación

Este documento define la lógica y el contrato de datos. No significa que Firebase ya esté conectado ni que los cobros, renovaciones, reglas o funciones estén activos. Para activarlos faltan el proyecto/configuración Firebase, Authentication, reglas Firestore y backend confiable; el panel privado del operador debe autenticarse por separado de la APK de los negocios.
