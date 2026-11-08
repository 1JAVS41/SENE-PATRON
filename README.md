# SENE PATRÓN

Aplicación Android independiente para administrar una licencia SENE y sus dos equipos SENE VENTAS.

## Reglas principales

- Una licencia admite exactamente 3 espacios: 1 dispositivo SENE PATRÓN y 2 dispositivos SENE VENTAS (Equipo 1 y Equipo 2).
- La asignación, aprobación, bloqueo y sustitución de dispositivos se valida en el servidor; la aplicación no puede concederse permisos a sí misma.
- Reinstalar la aplicación en el mismo teléfono debe permitir recuperar la vinculación existente mediante autenticación y prueba criptográfica. Un identificador local por sí solo no demuestra identidad.
- Una sustitución de teléfono requiere autorización del titular de la plataforma; no debe liberar ni duplicar espacios automáticamente.

## Firebase: uso mínimo y controlado

Firebase se utilizará únicamente para autenticación, licencia, identidad/vinculación de dispositivos, solicitudes, aprobaciones, revocaciones y metadatos indispensables.

**No se subirán a Firebase** ventas, inventario, catálogo, productos, movimientos ni datos comerciales. Esos datos permanecen locales en SENE VENTAS.

- Sin consultas repetitivas ni listeners permanentes para revisar cambios.
- Lecturas y escrituras solo ante acciones o eventos necesarios.
- Datos compactos, caché local y operaciones agrupadas cuando proceda.
- No habilitar facturación Blaze ni servicios de pago sin autorización expresa del propietario.

## Módulos previstos

1. Panel principal del propietario.
2. Estado de licencia y los tres espacios.
3. Administración de SENE VENTAS Equipo 1 y Equipo 2.
4. Solicitudes de vinculación: aprobar o rechazar.
5. Solicitudes operativas que requieran autorización.
6. Bloqueo y sustitución de equipos.
7. Consultas de horarios y asistencia, sujetas al diseño de privacidad y sincronización aprobado.

## Seguridad y etapas

- Las reglas de Firestore deben permanecer cerradas por defecto hasta definir y probar el modelo de autorización.
- Las operaciones sensibles deben validarse en backend con identidad autenticada y permisos comprobados.
- No simular una vinculación real mientras no estén implementados y conectados el backend y SENE VENTAS.
- No incluir secretos, claves privadas ni archivos de configuración Firebase en el repositorio.

## Estado

Repositorio inicial. La implementación Android y el backend se desarrollarán por etapas, con compilación y pruebas verificables en cada entrega.
