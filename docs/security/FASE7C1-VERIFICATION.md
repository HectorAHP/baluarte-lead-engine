# Fase 7C.1 — Reliable Delivery Final Verification

Este documento cubre exclusivamente lo que la Fase 7C.1 pidió por escrito (auditoría, corrección de
afirmaciones imprecisas, documentación de prerrequisitos reales) — no repite el contenido ya
correcto de los reportes de Fase 7C/7B. Nada de lo descrito aquí se ha ejecutado en producción; ver
el reporte final de la fase para la confirmación explícita.

## §4/§5 — Qué activa realmente `HUBSPOT_OUTBOX_ENABLED`, y qué más hace falta

### Corrección de una afirmación falsa del reporte de Fase 7C

El reporte de Fase 7C dio a entender que `HUBSPOT_OUTBOX_ENABLED=true` era "la única acción
necesaria" para activar el outbox en producción. Eso es **falso** — es una condición NECESARIA
pero lejos de ser SUFICIENTE. La lista real y completa de prerrequisitos, en orden:

1. **Migración `020_hubspot_sync_outbox.sql` aplicada** — la tabla y el RPC de claim deben existir
   antes de que cualquier código intente usarlos.
2. **Migración `021_hubspot_outbox_atomicity_and_lease.sql` aplicada** — el RPC atómico
   `create_fiscal_score_with_outbox` y el nuevo `claim_hubspot_sync_outbox_batch` (3 argumentos,
   con reclaim de filas `PROCESSING` obsoletas) deben existir. Sin esto, el código nuevo de
   `WebLeadCaptureService`/`HubSpotOutboxProcessorService` fallaría en tiempo de ejecución al
   llamar un RPC que no existe.
3. **Backend desplegado** con el código de Fase 7C + 7C.1 (este mismo branch/commit).
4. **`HUBSPOT_OUTBOX_ENABLED=true`** — activa el path de escritura (ver semántica exacta abajo).
5. **`HUBSPOT_SYNC_RUNNER_SECRET` configurado** — sin esto, `POST /internal/hubspot-sync/run`
   siempre responde 401 (fail-closed) y ningún outbox se procesa jamás, aunque la tabla se esté
   llenando correctamente.
6. **Un scheduler externo configurado** para llamar `POST /internal/hubspot-sync/run` con ese
   secreto a intervalos regulares (este proyecto no incluye un cron interno — ver el Fase 7A
   `/internal/reminders/run` como precedente del mismo patrón).
7. **Verificar que el endpoint responde 200** con un run manual antes de confiar en el scheduler.
8. **Credencial de HubSpot disponible** (`HUBSPOT_PRIVATE_APP_TOKEN`) — sin esto, cada intento de
   entrega falla con un error de "HubSpot no configurado" y termina, tras reintentos, en
   `FAILED_PERMANENT` (nunca silenciosamente perdido, pero tampoco útil).
9. **QA de un lead controlado** — un envío real (o cuidadosamente simulado) del calculador,
   verificado end-to-end: fila en `hubspot_sync_outbox` → `SUCCEEDED` → contacto real en HubSpot
   con las 37 propiedades `bc_fiscal_*` completas y `calculationVersion` correcto.

Ninguno de estos 9 pasos se ha ejecutado en esta sesión. `HUBSPOT_OUTBOX_ENABLED` sigue en `false`
por defecto (`config.ts`).

### Semántica exacta de `HUBSPOT_OUTBOX_ENABLED` (sin ambigüedad)

- **Sí controla**: si `WebLeadCaptureService.scoreFiscalCalculatorSubmission` escribe una fila en
  `hubspot_sync_outbox` (`true`) o llama `HubSpotFiscalSyncService.syncFiscalCalculatorLead` de
  forma síncrona e inline, tal como antes de Fase 7C (`false`, default). Es un interruptor binario
  de UN solo flujo de escritura — nunca ambos a la vez para la misma submission.
- **NO controla, y nunca lo hizo**: si el WORKER (`HubSpotOutboxProcessorService`, invocado por
  `POST /internal/hubspot-sync/run`) procesa filas existentes. El worker SIEMPRE intenta drenar
  cualquier fila `PENDING`/`FAILED_RETRYABLE` (y, desde Fase 7C.1, `PROCESSING` obsoleta) que
  encuentre en la tabla, sin importar el valor actual del flag. Esto es deliberado: si el flag se
  apaga después de haber estado encendido, el trabajo YA encolado no debe quedar huérfano —
  el worker lo sigue drenando hasta vaciar la tabla.
- **Consecuencia práctica de lo anterior**: apagar el flag detiene la creación de NUEVAS filas,
  pero NO detiene el procesamiento de las que ya existen. Para detener el worker por completo hay
  que dejar de invocar `POST /internal/hubspot-sync/run` (quitar el scheduler), no solo apagar el
  flag.
- **Nunca hay ambigüedad de flags redundantes**: es deliberadamente UN solo flag (no
  "outbox write enabled" + "outbox processing enabled" por separado) — no existe un estado
  intermedio "escribe pero nunca procesa" ni viceversa que valga la pena exponer como
  configuración explícita.

## §15 — Procedimiento futuro para el contacto QA `246658425738` ("Diagnostico Test")

**No se ha tocado el contacto en esta sesión** (Fase 7C.1). Sigue existiendo en el portal real de
HubSpot ("Baluarte Capital", accountId 51466309), creado sin autorización previa durante la
verificación ad-hoc de una fase anterior. El procedimiento para cuando se autorice explícitamente
su eliminación es:

1. **Verificar el contacto** — releer sus propiedades actuales vía la conexión de HubSpot ya
   autenticada, confirmar que sigue siendo `diagnostico-test-...@example.com` / "Diagnostico Test"
   y que ninguna actividad real (un asesor, un formulario real) lo ha tocado desde entonces.
2. **Verificar asociaciones** — deals, tickets, notas, tareas, o cualquier objeto de HubSpot
   asociado a ese contacto. Un contacto de prueba con asociaciones reales creadas después NO debe
   borrarse sin revisar esas asociaciones primero.
3. **Verificar registros correspondientes en Supabase** — buscar en `leads` por el email/teléfono
   usado al crear el contacto de prueba; si existe un lead de Supabase correspondiente, incluirlo
   explícitamente en el plan de borrado (no solo el lado de HubSpot).
4. **Mostrar el plan de borrado exacto** al usuario antes de ejecutar nada — qué se borra en
   HubSpot, qué se borra (si acaso) en Supabase, qué NO se toca.
5. **Solicitar confirmación final explícita** — nunca inferir autorización de un mensaje anterior
   ni de "ya lo mencionamos antes".
6. **Borrar únicamente lo aprobado** — si el usuario aprueba solo el contacto de HubSpot y no el
   lead de Supabase (o viceversa), respetar exactamente esa distinción.

## §20 — Auditoría de la migración 020 (+ 021)

| Aspecto | Migración 020 | Migración 021 |
|---|---|---|
| PK | `id uuid primary key default gen_random_uuid()` | (no crea tablas nuevas) |
| FK | `lead_id references leads(id) on delete cascade` | (sin cambios) |
| UNIQUE | `unique (lead_id, submission_id)` — ancla de idempotencia | (reutilizada por el nuevo RPC vía `on conflict`) |
| CHECK | `status in ('PENDING','PROCESSING','SUCCEEDED','FAILED_RETRYABLE','FAILED_PERMANENT')` | (sin cambios) |
| Índices | `(status, next_attempt_at)` para el claim original | + `(updated_at) where status='PROCESSING'` para el reclaim de filas obsoletas (agregado en 021 tras auditar que el índice de 020 no cubre esa rama) |
| RLS | `enable row level security`, sin políticas — acceso exclusivo vía `service_role` (bypassea RLS) | (sin cambios) |
| RPC permisos | `claim_hubspot_sync_outbox_batch`: `REVOKE ALL` de `public`/`anon`/`authenticated`, `GRANT EXECUTE` solo a `service_role` | Mismo patrón aplicado a la nueva firma de 3 argumentos Y a `create_fiscal_score_with_outbox` |
| `SECURITY DEFINER` | Sí, con `set search_path = public` explícito (evita el vector clásico de "search_path hijacking" en funciones `SECURITY DEFINER`) | Igual en ambas funciones nuevas/modificadas de 021 |
| Alcance del `SECURITY DEFINER` | Limitado a la lógica de claim (una sola sentencia UPDATE con `FOR UPDATE SKIP LOCKED`) | `create_fiscal_score_with_outbox` está limitado ESTRICTAMENTE a dos INSERTs (`fiscal_lead_scores`, `hubspot_sync_outbox`), nunca al INSERT/UPDATE de `leads` — ninguna lógica de negocio (dedupe, merge) se movió a SQL |

**Ninguna migración histórica fue modificada** — 021 es puramente aditiva más un `drop function` +
`create function` explícito para cambiar la firma de `claim_hubspot_sync_outbox_batch` (documentado
en el propio archivo, con su rollback exacto).

## §21 — Plan de rollout futuro (NO ejecutado) con rollback por paso

Ninguno de estos 10 pasos se ha ejecutado. Cada uno lista su rollback inmediato.

1. **Aplicar migraciones 020 (si aún no aplicada) y 021 en producción.**
   Rollback: ejecutar el bloque "Rollback:" al final de cada archivo `.sql` — ninguno borra datos
   de negocio, solo funciones/índices/la tabla `hubspot_sync_outbox` si se revierte hasta el final.
2. **Desplegar el backend de este branch con `HUBSPOT_OUTBOX_ENABLED=false` (sin cambio de
   comportamiento todavía).**
   Rollback: revertir el deploy al commit anterior (Render conserva el build previo).
3. **Configurar `HUBSPOT_SYNC_RUNNER_SECRET` en Render (variable de entorno nueva, valor
   aleatorio, nunca reutilizado de otro secreto).**
   Rollback: eliminar la variable — el endpoint vuelve a fail-closed (401) inmediatamente.
4. **Verificar manualmente `POST /internal/hubspot-sync/run` con el secreto correcto responde 200
   con `{claimed:0,...}` (tabla vacía todavía).**
   Rollback: N/A — paso de solo lectura, no cambia estado.
5. **Activar `HUBSPOT_OUTBOX_ENABLED=true` en el modo más seguro disponible (ambiente de
   staging/QA si existe; si no, producción con aviso explícito y ventana de bajo tráfico).**
   Rollback: volver `HUBSPOT_OUTBOX_ENABLED=false` — las submissions nuevas vuelven al path
   síncrono inline inmediatamente; cualquier fila ya en el outbox sigue procesándose sola (ver
   semántica del flag en §5) sin necesitar intervención adicional.
6. **Configurar el scheduler externo** (cron/Render Cron Job/GitHub Actions programado) para
   invocar `POST /internal/hubspot-sync/run` cada N minutos.
   Rollback: eliminar/pausar el scheduler — las filas quedan `PENDING` en la tabla, sin pérdida de
   datos, listas para procesarse en cuanto se reactive.
7. **Procesar un lead QA controlado de extremo a extremo** (un envío real del calculador o uno
   explícitamente autorizado por el usuario) y observar el ciclo completo.
   Rollback: si algo falla, `HUBSPOT_OUTBOX_ENABLED=false` (paso 5) detiene nuevas escrituras; la
   fila QA problemática se puede inspeccionar/borrar manualmente en Supabase sin afectar leads
   reales (unique constraint por `submission_id`, aislado).
8. **Inspeccionar en Supabase la fila del outbox (`status=SUCCEEDED`), y en HubSpot el contacto
   resultante**: confirmar las 37 propiedades `bc_fiscal_*`, `calculationVersion` correcto (si el
   patch de `impuestos.html`, sección 0 de `FASE7C-FRONTEND-CHANGES.md`, ya fue aplicado; si no,
   confirmar el fallback honesto `"unknown"`).
   Rollback: N/A — paso de solo lectura.
9. **Observar el comportamiento de reintentos/backoff con al menos un fallo inducido de forma
   controlada** (p. ej., un token de HubSpot temporalmente inválido en un ambiente de prueba) y
   confirmar que el classifier/backoff se comporta según lo documentado (ver
   `domain/hubspot-sync-retry.ts` y sus tests).
   Rollback: N/A — observación, ningún cambio de estado persistente más allá de lo que el propio
   sistema de reintentos ya revertiría solo.
10. **Solo después de satisfacer el criterio objetivo de retiro del Forms API legacy** (sección
    "Criterio objetivo de retiro" de `FASE7C-FRONTEND-CHANGES.md` §13 — las 6 condiciones
    verificables ahí listadas), aplicar el patch que elimina `enviarHubSpot()` de `impuestos.html`.
    Rollback: revertir el commit del patch en el repo de `impuestos.html` — el Forms API legacy
    vuelve a correr en paralelo con el outbox exactamente como hoy.

## Confirmación explícita

Ninguno de los pasos anteriores se ejecutó durante la Fase 7C.1. No hubo escritura de producción en
HubSpot, Supabase, WhatsApp, Calendar, ni cambios en Render/Hostinger. Ver el reporte final de la
fase para la lista completa de verificaciones (36 puntos).
