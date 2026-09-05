# Fase 7C — cambios pendientes en `impuestos.html` (fuera de este repo)

**`impuestos.html` no vive en `baluarte-lead-engine`** — está en el repo/hosting de
`baluartecapital.com.mx` (Hostinger), al cual esta sesión no tiene acceso de escritura. Nada de
este documento se ha aplicado; es el patch exacto para que alguien con acceso a ese repo lo aplique
manualmente.

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
