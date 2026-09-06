# Fase 7C / 7C.1 — cambios pendientes en `impuestos.html` (fuera de este repo)

**`impuestos.html` no vive en `baluarte-lead-engine`** — está en el repo/hosting de
`baluartecapital.com.mx` (Hostinger), al cual esta sesión no tiene acceso de escritura. Nada de
este documento se ha aplicado; es el patch exacto para que alguien con acceso a ese repo lo aplique
manualmente.

**Aclaración importante (Fase 7C.1 §11)**: el backend ya sabe transportar `calculationVersion`
desde Fase 6F.2 (ver `tests/hubspot-fiscal-calculation-version.test.ts`) — eso es trabajo de este
repo, ya hecho. Lo que **nunca se ha aplicado** es el cambio correspondiente en el `impuestos.html`
real (Hostinger): hoy ese archivo NO envía `calculationVersion` en absoluto, así que cada submission
real cae en el placeholder `CALCULATION_VERSION_UNKNOWN` ("unknown"). La sección 0 de este documento
es el patch exacto, todavía sin aplicar, para cerrar esa brecha.

## 0. Enviar `calculationVersion` real (Fase 7C.1 §11) — patch exacto, NO aplicado

Ubicación: junto a las demás constantes del motor de cálculo (`UMA_ANUAL_2026`,
`LIMITE_5_UMAS`, etc.), cerca del inicio del `<script>` principal, ANTES de la función
`buildLeadEnginePayload()`:

```diff
+  var FISCAL_CALCULATION_VERSION = "ppr_calc_2026_v1";
```

Y dentro de `buildLeadEnginePayload()`, en el objeto `fiscalCalculator: {...}` que ya arma esa
función (mismo objeto donde van `age`, `city`, `taxRegime`, `monthlyIncome`, `deductions`,
`calculation`, etc. — ver `tests/hubspot-fiscal-calculation-version.test.ts` para el shape exacto
que el backend espera), agregar UNA clave nueva:

```diff
   fiscalCalculator: {
     age: edad,
     city: ciudad,
     taxRegime: regimen,
     ...
+    calculationVersion: FISCAL_CALCULATION_VERSION,
   }
```

**Por qué es seguro y por qué no se aplica solo**: el backend YA sabe manejar ambos casos desde Fase
6F.2 — con `calculationVersion` presente, la transporta verbatim a
`bc_fiscal_calculation_version`; sin ella (el comportamiento actual, real, de producción), cae al
placeholder honesto `"unknown"` (`CALCULATION_VERSION_UNKNOWN`), nunca inventa un valor. Este patch
solo vive en `impuestos.html` (Hostinger), fuera del alcance de escritura de este repo/sesión — no
se aplica aquí, solo se documenta con precisión para quien tenga acceso.

**REGLA EXPLÍCITA (Fase 7C.1 §11)**: este cambio es exclusivamente hacia adelante. NUNCA
reemplazar retroactivamente el valor `"unknown"` ya guardado en registros históricos (Supabase o
HubSpot) — un submission histórico que nunca declaró su versión de cálculo se queda como
`"unknown"` para siempre; inferir o adivinar cuál pudo haber sido sería fabricar datos que nunca
existieron.

## 1. Subir el timeout (defensa adicional — spec §3)

Ubicación: bloque `CONFIG` cerca del inicio del `<script>` principal.

```diff
   var CONFIG = {
     WHATSAPP_NUMBER_FUNNEL: "524774127452",
     AGENDA_URL: "index.html#diagnostico",
     LEAD_SOURCE: "fiscal_calculator",
     LEAD_SOURCE_LEAD_ENGINE: "WEB_FISCAL_CALCULATOR",
     LEAD_ENGINE_URL: "https://baluarte-lead-engine.onrender.com",
-    LEAD_ENGINE_TIMEOUT_MS: 4000
+    LEAD_ENGINE_TIMEOUT_MS: 15000
   };
```

**Esto es defensa adicional, NO la solución arquitectónica** (spec §3) — la solución real es el
outbox de HubSpot ya implementado en el backend (ver el reporte de Fase 7C): con
`HUBSPOT_OUTBOX_ENABLED=true`, `POST /api/leads` ya NO espera a HubSpot en absoluto, así que el
tiempo real de respuesta baja a solo lo que tardan las escrituras a Supabase (lead +
fiscal_lead_scores + outbox) — decenas de milisegundos, no segundos. Subir este timeout sigue
siendo correcto como margen de seguridad independiente (red del usuario, latencia variable), pero
ya no es la pieza crítica una vez que el flag esté activo en producción.

**Corrección explícita (Fase 7C.1 §12)**: este timeout **nunca fue, y no es**, una respuesta a
"Render duerme por inactividad" — Render corre en plan de pago y NO tiene cold start (ver el
contexto de la Fase 7C original). El único problema real que este patch mitiga es tolerancia de
red/latencia genérica del lado del cliente (una red lenta del usuario, un pico de latencia
puntual), nunca una suposición sobre el estado del servidor. La causa raíz real de la pérdida de
datos de HubSpot (Fase 7C) fue la ausencia de reintentos en la llamada síncrona original — eso lo
cierra el outbox, no este timeout.

## 2. Nada más cambia en el frontend por ahora

`buildLeadEnginePayload()`, `submitToLeadEngine()`, y el `Promise.allSettled([...])` que llama a
ambos (`enviarHubSpot`, `submitToLeadEngine`) se quedan exactamente como están. El contrato HTTP
de `POST /api/leads` no cambió (sigue devolviendo `{ok:true, leadId}` con 200/201) — Fase 7C
decidió deliberadamente preservar ese contrato (spec §7: "preferir conservar contrato actual").

## 3. Plan futuro: retirar `enviarHubSpot()` (legacy Forms API) — NO ejecutar todavía

Spec §21 — solo después de que el outbox esté validado en producción real (Fase D/E del rollout,
ver el reporte). Cuando llegue ese momento, el cambio en `impuestos.html` es exactamente:

1. Eliminar la función `enviarHubSpot()` completa (busca `function enviarHubSpot`).
2. En el handler de `btn-p2-calc`, dentro del array de `Promise.allSettled([...])`, quitar la
   entrada `enviarHubSpot(...)`, dejando únicamente `submitToLeadEngine(leadEnginePayload)`.
3. Nada más en `impuestos.html` depende de `enviarHubSpot` — el UTM/atribución, el consentimiento
   y el resultado fiscal ya fluyen exclusivamente por `submitToLeadEngine`'s propio payload.

**Precondición explícita antes de hacer esto**: confirmar en HubSpot real que, durante al menos
unas semanas con `HUBSPOT_OUTBOX_ENABLED=true` en producción, el outbox está entregando con éxito
(`hubspot_sync_outbox` con `SUCCEEDED` para la gran mayoría de submissions, `FAILED_PERMANENT` bajo
control) — de lo contrario, retirar el Forms API dejaría de nuevo la única vía de respaldo que hoy
funciona.

### Criterio objetivo de retiro (Fase 7C.1 §13) — riesgo del doble-write concurrente mientras tanto

Mientras `enviarHubSpot()` (Forms API legacy) y `submitToLeadEngine()` (outbox) sigan corriendo en
paralelo (el mismo `Promise.allSettled([...])` de hoy), CADA submission real escribe el mismo
contacto en HubSpot por DOS vías independientes, sin coordinación entre ellas — un riesgo de
condición de carrera / doble-escritura ya documentado, aceptado temporalmente, nunca resuelto por
diseño. El retiro de `enviarHubSpot()` no debe depender de una fecha ni de una sensación de
"ya está listo" — requiere que TODAS las condiciones siguientes se cumplan a la vez, verificables
directamente en Supabase/HubSpot (nunca solo en logs o solo de memoria):

1. Migración `021_hubspot_outbox_atomicity_and_lease.sql` aplicada en producción.
2. `HUBSPOT_OUTBOX_ENABLED=true` en producción durante al menos 14 días consecutivos, sin
   rollback intermedio a `false`.
3. Al menos 20 submissions reales consecutivas (no de prueba) con `hubspot_sync_outbox.status =
   'SUCCEEDED'` — cero `FAILED_PERMANENT` inexplicados en esa muestra (uno explicado y resuelto
   manualmente no invalida el conteo, pero debe quedar documentado cuál y por qué).
4. Cero filas atascadas en `PROCESSING` por más del umbral de staleness
   (`HUBSPOT_OUTBOX_STALE_PROCESSING_THRESHOLD_MS`, default 10 min) durante esa ventana — evidencia
   de que el mecanismo de recuperación de workers (Fase 7C.1 §6) nunca tuvo que intervenir, o que
   intervino correctamente cuando fue necesario.
5. Al menos un caso real (no simulado) de conflicto de identidad (`identityConflict` o un 409 de
   HubSpot) observado y resuelto correctamente por el outbox durante esa ventana — o, si no
   ocurrió ninguno de forma natural, una prueba QA controlada y explícitamente autorizada que lo
   fuerce y confirme el comportamiento esperado.
6. Confirmación manual, comparando un puñado de contactos reales en el portal de HubSpot, de que
   las 37 propiedades `bc_fiscal_*` (ver `hubspot-fiscal-snapshot-completeness.ts`) llegan
   completas para esos registros.

Solo cuando las 6 condiciones anteriores estén satisfechas y documentadas, se aplica el patch de la
sección 3 (arriba). Ninguna condición se asume — cada una requiere evidencia verificable.
