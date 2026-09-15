# Fase 2.2 — Launch Blocker Closure (Baluarte Content Intelligence)

Origen: hallazgos de la Launch Readiness Audit (Fase 2.1) del sistema de marketing/campañas
("Baluarte Content Intelligence"), un proyecto separado de este repo que consume su API pública
(`POST /api/leads`) desde `impuestos.html`. Este documento existe en `docs/` (no en
`docs/security/`, para no implicar que es parte de la numeración "Fase 7X" de este repo) porque
modifica código real de este repo y cualquier sesión futura (humana o de Claude Code) que toque
`leads`, `qualification-fields.ts` o el outbox de HubSpot debe encontrar el porqué aquí.

**Nota de concurrencia**: al empezar esta fase, el working tree ya tenía cambios sin commitear en
`src/app.ts`, `src/domain/fiscal-calculator-lead-note.ts` y dos archivos de test (rama
`feature/fiscal-calculator-v1-1`, trabajo de calculadora fiscal V1.1 — RESICO/ISR general, no
relacionado). Ninguno de esos archivos fue tocado por este cambio. No se hizo commit de nada —
todo queda como working tree modificado, para que quien continúe decida cómo secuenciar los
commits.

## A. Qué se resolvió

### 1. Atribución first-party (antes: solo vivía en HubSpot)

`WebLeadCaptureService.capture()` recibía el objeto `attribution` (utm_source/medium/campaign/
content/term/fbclid/landing_page/referrer) y lo usaba EXCLUSIVAMENTE para construir el payload de
sync a HubSpot — nunca lo pasaba a `leadService.createLead()`. Confirmado leyendo el código antes
de tocar nada (no se asumió).

**Fix** (additivo, sin romper compatibilidad):
- `domain/lead.ts`: nuevo tipo `WebAttribution` + campo opcional `Lead.attribution`.
- `supabase/migrations/022_leads_attribution.sql`: `alter table leads add column if not exists attribution jsonb;` — nullable, sin backfill, reversible.
- `infrastructure/supabase-lead-repository.ts`: `LeadRow.attribution`, mapeo en `mapRowToLead`/`mapLeadToInsertRow`/`mapLeadPatchToRow`.
- `application/services.ts`: `LeadService.createLead()` acepta `attribution` opcional (pass-through, ya cubierto por el spread `...rest` existente).
- `application/web-lead-capture.ts`: (a) al crear un lead nuevo, pasa `attribution: input.attribution` a `createLead()`; (b) al hacer merge con un lead existente, aplica la MISMA regla de "primer touch preservado" que ya existe para `campaignName`/`source`/`productVertical`/`productInterest` — nunca sobreescribe una atribución ya guardada, solo llena el hueco si el lead no tenía ninguna.

`app.ts` (ruta `POST /api/leads`) **no requirió ningún cambio** — ya validaba y pasaba `attribution` completo a `WebLeadCaptureInput`; el gap estaba exclusivamente entre ese input y `createLead()`.

`leads.campaign_name` **ya se poblaba** desde `attribution.utm_campaign` (línea ~909 de `app.ts`, `campaignName: attribution?.utm_campaign`) — corrección a la Fase 2.1, que había asumido incorrectamente que también quedaba en null.

`campaign_id`/`adset_id`/`ad_id` (identificadores nativos de Meta) siguen sin poblarse — el frontend (`impuestos.html`) nunca los captura de la URL (confirmado en vivo durante Fase 2.1). No se inventó ningún valor.

### 2. Creative ID

Se documenta (no se implementa campo nuevo): `attribution.utm_content` ES el creative id para esta campaña — ya viaja completo en el nuevo campo `leads.attribution`. No se justificó una columna dedicada.

### 3. Campos de diagnóstico de la llamada de 30 min

`domain/qualification-fields.ts`: se agregaron 7 valores nuevos al whitelist ya existente (`PATRIMONIAL_QUALIFICATION_FIELDS`/`GMM_QUALIFICATION_FIELDS`), sin tabla ni columna nueva: `ad_need_state, diagnosed_need_state, primary_concern, solution_category, product_fit, insurer_fit, next_step`. Se escriben en `qualification_answers` (append-only, ya existente) con `source: "MANUAL"`.

### 4. Scheduler de HubSpot Outbox

Confirmado (búsqueda exhaustiva: `.github/workflows`, `render.yaml`, grep de todo el repo): **no existía ningún disparador real** de `POST /internal/hubspot-sync/run` — el endpoint existía y funcionaba, pero nada lo llamaba nunca en producción. `docs/security/FASE7D-ROLLOUT-PLAN.md` §10 ya documentaba esto como pendiente, con 3 opciones evaluadas (Render Cron Job, cron-job.org, GitHub Actions) sin implementar ninguna.

**Fix**: `.github/workflows/hubspot-sync-cron.yml` — implementa la opción "GitHub Actions scheduled workflow" ya documentada como fallback, con la frecuencia (`*/2 * * * *`) y el request exacto (headers, método) que ese mismo documento especifica. No crea infraestructura nueva — reutiliza el repo de GitHub donde este código ya vive. Requiere, para activarse (no hecho en esta fase): (1) push de este archivo a `origin`, (2) secret `HUBSPOT_SYNC_RUNNER_SECRET` y variable `LEAD_ENGINE_BASE_URL` configurados en GitHub (Settings → Secrets and variables → Actions).

## B. Tests

- `tests/lead-attribution-persistence.test.ts` (nuevo, 4 tests) — Golden Test 1 (persistencia) y Golden Test 3 (segundo touch no sobreescribe) de la Fase 2.2, contra `WebLeadCaptureService` real (repos en memoria, sin red).
- `tests/qualification-fields-diagnosis.test.ts` (nuevo, 15 tests) — los 7 campos nuevos son aceptados por el whitelist en ambos verticales; un campo no listado sigue rechazándose.
- `tests/supabase-mapping.test.ts` (editado) — se agregó `attribution: null` al fixture existente (rompía sin esto) + un test nuevo de round-trip row→Lead→insert→patch.
- Regresión completa: **antes** de tocar nada, `npm test` dio 1823 passed / 6 failed (los 6 son timeouts de 5000ms en tests e2e de WhatsApp no relacionados — confirmados como flaky de entorno, no de lógica). **Después** de todos los cambios de esta fase: **143/143 archivos, 1834/1834 tests, 0 fallos** (`npm run typecheck` limpio en ambos momentos).

## C. Deployment Plan (no ejecutado — requiere autorización)

```
FILES:      supabase/migrations/022_leads_attribution.sql (nueva)
            src/domain/lead.ts, src/domain/qualification-fields.ts,
            src/application/services.ts, src/application/web-lead-capture.ts,
            src/infrastructure/supabase-lead-repository.ts (modificados)
            .github/workflows/hubspot-sync-cron.yml (nuevo)
            tests/lead-attribution-persistence.test.ts,
            tests/qualification-fields-diagnosis.test.ts (nuevos)
            tests/supabase-mapping.test.ts (modificado)

MIGRATION:  022_leads_attribution.sql — aditiva, nullable, sin backfill. Aplicar ANTES de
            desplegar el código nuevo (el código nuevo escribe attribution; sin la columna,
            el INSERT/UPDATE fallaría).

ENV:        Nuevas variables a configurar en GitHub (no en Render, no en este código):
            HUBSPOT_SYNC_RUNNER_SECRET (repository secret, mismo valor que ya existe en Render)
            LEAD_ENGINE_BASE_URL (repository variable, ej. https://baluarte-lead-engine.onrender.com)

ORDER:      1. Revisar y decidir cómo commitear (hay trabajo concurrente sin commit, ver nota
               de concurrencia arriba — probablemente 2 commits separados).
            2. Aplicar la migración 022 a Supabase (producción).
            3. Deploy del backend a Render con el código de esta fase.
            4. Push de .github/workflows/hubspot-sync-cron.yml a la rama que Render despliega.
            5. Configurar los 2 secrets/variables de GitHub Actions.
            6. Verificar manualmente: workflow_dispatch (trigger manual) una vez, confirmar
               HTTP 200 y revisar hubspot_sync_outbox en Supabase.

TEST:       npm run typecheck && npm test (ya verificado limpio en esta fase, repetir tras
            cualquier commit/rebase). Golden Test 1 de negocio (lead real → Supabase → HubSpot)
            sigue pendiente de ejecutarse en producción, con un lead de QA (ver
            docs/security/FASE7D-ROLLOUT-PLAN.md §11 para el procedimiento ya diseñado).

ROLLBACK:   Código: revert de los commits de esta fase (aditivo, sin romper nada existente).
            Migración: `alter table leads drop column if exists attribution;` (documentado en el
            propio archivo de migración).
            Workflow: eliminar/deshabilitar `.github/workflows/hubspot-sync-cron.yml`, o borrar
            los secrets de GitHub (el workflow falla cerrado sin ellos, no hace nada dañino).
```

**No se hizo ningún deploy, push, ni migración a producción en esta fase.**
