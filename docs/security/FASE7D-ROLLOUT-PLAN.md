# Fase 7D — Production Rollout Plan & Deployment Checklist

**Nada de este documento se ejecutó.** No hubo `git merge`, no hubo deploy, no hubo escritura en
producción (HubSpot/Supabase/WhatsApp/Calendar), no hubo cambios en Render ni en Hostinger, no se
creó ningún scheduler, no se rotó ningún secreto, no se activó ninguna flag. Este documento es
auditoría + plan, nada más.

Branch auditada: `feature/reliable-lead-hubspot-delivery`. Commit final: `5f96883`.

---

## 1. Auditoría del diff total desde producción actual

**No se asumió que producción está en `main`/`master`.** Este repo no tiene `render.yaml` ni
`Procfile` que declaren explícitamente qué branch/commit despliega Render — esa configuración vive
únicamente en el dashboard de Render, al que esta sesión no tiene acceso. Lo que SÍ se pudo
verificar directamente en el repo:

- El remote `origin` (`https://github.com/HectorAHP/baluarte-lead-engine.git`) reporta `HEAD branch:
  master` — es decir, `master` es la rama default del repo en GitHub. Esto es evidencia (no
  confirmación) de que Render probablemente apunta a `master`, ya que esa es la convención más común
  para un servicio con un solo ambiente de producción.
- `git merge-base origin/master 5f96883` = `f35a9f8` = exactamente el tip actual de `origin/master`.
  Es decir, **`feature/reliable-lead-hubspot-delivery` contiene TODO lo que hay en `master` más 27
  commits adicionales** — no hay divergencia, solo adelanto lineal.

**HALLAZGO CRÍTICO que refuerza la advertencia de "no asumir main/master"**: el propio `master`
tiene una inconsistencia interna que sugiere que su tip (`f35a9f8`) podría no ser exactamente lo que
Render ejecuta hoy:

- `master`'s `package.json` tiene `"start": "node dist/server.js"`.
- `master`'s `tsconfig.json` (sin diff respecto a `5f96883` — es decir, es EL MISMO archivo) tiene
  `"outDir": "dist"`, `"rootDir": "."`, `"include": ["src/**/*.ts", ...]` — con este `tsconfig`,
  `tsc` SIEMPRE compila `src/server.ts` a `dist/src/server.js`, nunca a `dist/server.js`.
- Es decir: si Render ejecuta literalmente `npm start` sobre el commit `f35a9f8` de `master`, el
  proceso fallaría al arrancar (`Cannot find module 'dist/server.js'`) — lo cual es incompatible con
  que el servicio esté corriendo hoy en producción (asumimos que sí lo está, porque el negocio
  opera). Esto implica una de dos cosas, y **debe confirmarse en el dashboard de Render antes de
  cualquier deploy**, no asumirse:
  1. El **Start Command** configurado en Render está **hardcodeado** (p. ej. `node dist/src/server.js`
     o algo distinto de `npm start`) y por eso el `package.json` de `master` nunca importó — en cuyo
     caso, al desplegar `5f96883`, hay que confirmar que ese mismo Start Command sigue siendo
     correcto (si ya apuntaba a `dist/src/server.js`, no cambia nada).
  2. Lo que realmente está corriendo en Render **no es exactamente `f35a9f8`** sino un commit
     posterior no fusionado a `master` en este repo local (por ejemplo, si alguien alguna vez
     desplegó directo desde una rama feature sin mergear) — en cuyo caso el "diff total desde
     producción" de abajo podría estar sub-o-sobre-estimado.
  - **Acción requerida antes del deploy (no ejecutada aquí)**: abrir el dashboard de Render →
    el servicio → **Settings → Build & Deploy** y confirmar (a) qué branch está configurada, (b) el
    Start Command exacto, (c) el commit SHA del último deploy exitoso (Render lo muestra en la
    pestaña Events/Deploys).

Con esa reserva explícita, y usando `origin/master` (`f35a9f8`) como la mejor aproximación
disponible sin acceso a Render, la lista cronológica de los 27 commits pendientes de desplegar es:

```
f35a9f8  <- HEAD asumido de producción (master), NO CONFIRMADO contra Render
---------------------------------------------------------------------------
fe229a9  feat: dedupe/idempotent web lead capture for POST /api/leads
78d0bd4  chore: prepare Node runtime for Render                      [cambia start script]
0f9f4e8  chore: harden production server
b52b235  chore: upgrade production runtime to Node 22                [engines: node >=22.0.0]
f1471b0  feat: add fiscal lead scoring and context bridge
2222d0d  chore: finalize fiscal scoring deployment wiring
78c1ca0  feat: connect fiscal context to whatsapp inbound
625cc51  fix: recognize fiscal context on first whatsapp inbound
5c4f86c  fix: reply to qualified fiscal leads on follow-up
a45e122  feat: route qualified whatsapp conversations
0d3c40c  feat: restore google calendar booking in whatsapp
6b39797  feat: introduce Lia conversation experience
c77c56a  feat: sync fiscal calculator data to hubspot
c73c70b  fix: complete hubspot fiscal snapshot
6ad0470  fix: finalize hubspot fiscal schema and calculator version
ab857fb  fix: preserve qualified options menu context
a08bdad  fix: allow rebooking after past appointment
d54903b  fix: preserve conversational follow-up and rebooking flow
6b25a46  fix: scope booking round cap to current episode
abe5fac  fix: route fiscal welcome follow-up selections
6c44b75  fix: recover hubspot concurrent contact conflicts
eb229c9  fix: persist fiscal welcome menu state
2cc439c  feat: add appointment reminders and confirmation flow        [FASE 7A]
3f8e171  chore: harden production security and lead integrity         [FASE 7B]
ce9e38c  feat: add reliable hubspot outbox delivery                   [FASE 7C]
5f96883  fix: finalize reliable hubspot delivery guarantees            [FASE 7C.1] <- HEAD de la branch
```

**Migraciones nuevas pendientes**: 017, 018, 019, 020, 021 (detalle completo en §2).

**Variables nuevas pendientes**: ver tabla completa en §4 — en resumen, todas las de Fase 7A/7B/7C/
7C.1 (`APPOINTMENT_*`, `WHATSAPP_TEMPLATE_*`, `REMINDER_RUNNER_SECRET`, `ADMIN_API_TOKEN`,
`LEAD_INTEGRITY_ENABLED` y su familia, `HUBSPOT_OUTBOX_*`, `HUBSPOT_SYNC_RUNNER_SECRET`).

**Endpoints nuevos** (no existen en `master`): `POST /internal/reminders/run`, `POST
/internal/hubspot-sync/run`, `POST /api/appointments/:id/mark-completed`, `POST
/api/appointments/:id/mark-no-show`.

**Flags nuevos**: los 13 booleanos listados en §4/§5, todos con default `false` en `config.ts` — el
comportamiento de un deploy con cero variables nuevas configuradas es, por diseño, idéntico al de
`master` en todo lo que esas flags controlan.

**Cambios de dependencias/runtime** (`package.json`, diff completo `master` → `5f96883`):
- **Nuevo**: `@fastify/rate-limit ^10.3.0` (dependency).
- **Nuevo**: `"engines": {"node": ">=22.0.0"}` — `master` no declara ningún `engines` en absoluto.
  **Verificar en Render qué versión de Node usa el servicio hoy** (Settings → Environment → `NODE_VERSION`,
  o el runtime detectado automáticamente) — si hoy corre en Node 18/20, el deploy de `5f96883`
  requiere subir esa versión ANTES o EN el mismo deploy, o el build/arranque puede fallar o
  comportarse de forma no probada.
- **Cambiado**: `"start"` de `node dist/server.js` → `node dist/src/server.js` (ver hallazgo crítico
  arriba).
- **Nuevo script npm**: `"reconcile:hubspot-outbox": "tsx scripts/reconcile-hubspot-outbox.ts"`.
- `npm audit --production`: 4 vulnerabilidades moderate, las mismas ya conocidas desde Fase 7B
  (`uuid` vía `googleapis`/`gaxios`/`googleapis-common`) — requieren un bump breaking de `googleapis`
  para resolverse; deliberadamente diferido, sin cambio en esta fase.

---

## 2. Inventario de migraciones

Todas nuevas desde `master` (que termina en `016_reset_test_lead_phase4_reporting.sql`). Orden
obligatorio: **estrictamente numérico ascendente, sin excepción** — cada una asume que la anterior ya
existe (017→018→019→020→021), y ninguna reordena ni modifica una migración previa.

| # | Archivo | Tablas | Columnas nuevas | RPCs | Índices | RLS | Grants | Depende de | Backward-compatible | ¿Antes del backend? | Rollback |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 017 | `017_leads_privacy_accepted_at.sql` | `leads` (alter) | `privacy_accepted_at timestamptz` | — | — | sin cambio | sin cambio | 016 | Sí — columna nullable, sin default distinto de NULL | Sí | `alter table leads drop column privacy_accepted_at;` |
| 018 | `018_fiscal_lead_scores.sql` | `fiscal_lead_scores` (nueva) | — | — | `fiscal_lead_scores_lead_id_idx` | enabled, sin políticas (acceso solo `service_role`) | — | 017 (FK a `leads`) | Sí — tabla nueva, nada la referencia todavía | Sí | `drop table if exists fiscal_lead_scores;` |
| 019 | `019_lead_integrity.sql` | `leads` (alter) | `email_quality, phone_quality, phone_verified_at, email_verified_at, identity_conflict, suspected_automation, lead_integrity_score, lead_integrity_version` (todas nullable) | — | ninguno nuevo (documentado explícitamente en el propio archivo: ninguna query las usa como filtro hoy) | sin cambio | sin cambio | 018 | Sí — 8 columnas nullable, ningún código las lee para decisiones aún | Sí | `alter table leads drop column if exists <cada una>;` |
| 020 | `020_hubspot_sync_outbox.sql` | `hubspot_sync_outbox` (nueva) | — | `claim_hubspot_sync_outbox_batch(p_limit int, p_now timestamptz)` `SECURITY DEFINER` | `hubspot_sync_outbox_claim_idx (status, next_attempt_at)` | enabled, sin políticas | `REVOKE ALL` de `public/anon/authenticated`; `GRANT EXECUTE` a `service_role` | 019 (FK a `leads`) | Sí — tabla nueva | Sí | `drop function ...; drop table if exists hubspot_sync_outbox;` |
| 021 | `021_hubspot_outbox_atomicity_and_lease.sql` | (ninguna nueva) | (ninguna) | (a) `create_fiscal_score_with_outbox(...)` nueva, `SECURITY DEFINER`; (b) `claim_hubspot_sync_outbox_batch` **reemplazada** (firma cambia de 2 a 3 argumentos: agrega `p_stale_before timestamptz`) | `hubspot_sync_outbox_stale_processing_idx (updated_at) where status='PROCESSING'` | sin cambio | mismo patrón REVOKE/GRANT que 020, aplicado a ambas funciones | 020 (usa `fiscal_lead_scores` y `hubspot_sync_outbox` ya creadas) | Sí — el `drop function` + `create function` de la firma vieja es una operación DDL segura mientras el código viejo (que llama con 2 argumentos) ya no esté corriendo (ver nota abajo) | Sí, pero ver nota de compatibilidad | `drop function create_fiscal_score_with_outbox(...); drop index hubspot_sync_outbox_stale_processing_idx; drop function claim_hubspot_sync_outbox_batch(int,timestamptz,timestamptz);` luego recrear la versión de 020 si se revierte del todo |

**Nota de compatibilidad crítica sobre 021**: la migración 021 hace `drop function if exists
claim_hubspot_sync_outbox_batch(integer, timestamptz);` — es decir, **la firma de 2 argumentos deja
de existir**. Si por cualquier motivo el backend viejo (pre-Fase-7C.1, que llama con 2 argumentos)
siguiera corriendo un instante después de aplicar 021 pero antes de que el nuevo backend tome el
tráfico, esa llamada fallaría (función inexistente). Esto es exactamente por lo que §8/§9 exige
aplicar migraciones **antes** del deploy del backend, nunca al revés, y por lo que un rollout con
downtime cero (blue-green) importa aquí: el código viejo (2 argumentos) nunca debe ejecutarse
contra un esquema que ya sufrió el DROP de la firma de 2 argumentos. Render's estándar
deploy-then-swap ya evita esto en el caso normal (un solo proceso a la vez), pero si el plan de
Render implica mantener el proceso viejo vivo unos segundos en paralelo al nuevo durante el deploy,
esto se vuelve una ventana real de fallo — **confirmar el modelo de deploy de Render (rolling vs.
recreate) antes de ejecutar** (no confirmado en esta sesión).

**Confirmación del orden obligatorio**: 017 → 018 → 019 → 020 → 021, aplicado como un solo lote
antes del deploy del backend (§8, STEP 1). Ninguna es reversible de forma "gratuita" una vez que
haya datos reales en las columnas/tablas nuevas (el rollback de 019 pierde los valores computados;
el de 018/020/021 pierde las tablas enteras) — pero mientras las flags que las alimentan
(`LEAD_INTEGRITY_ENABLED`, `HUBSPOT_OUTBOX_ENABLED`) sigan en `false`, ninguna tabla/columna nueva
recibe escrituras reales, así que un rollback en esa ventana es efectivamente gratuito.

---

## 3. Pre-deploy database safety

| Migración | ¿Aditiva? | ¿Destructiva? | ¿Compatible con backend actual (master) corriendo en paralelo? | ¿Requiere flags activas para no romper? | ¿Rompe queries existentes? | Veredicto |
|---|---|---|---|---|---|---|
| 017 | Sí | No | Sí — una columna nueva nullable no es leída ni escrita por el código de `master` | No | No | OK |
| 018 | Sí | No | Sí — tabla nueva, sin FK entrante desde código viejo | No | No | OK |
| 019 | Sí | No | Sí — 8 columnas nullable no leídas por `master` | No | No | OK |
| 020 | Sí | No | Sí — tabla nueva | No | No | OK |
| 021 | Sí (schema), pero con un `DROP FUNCTION` de una firma vieja | No hay pérdida de datos, pero **sí hay ruptura de compatibilidad de firma** para cualquier proceso que aún llame `claim_hubspot_sync_outbox_batch` con 2 argumentos | **NO estrictamente compatible en paralelo** — ver nota crítica de §2 | No requiere flags activas (el código de `master` ni siquiera conoce esta función) — el riesgo es solo si el código de FASE 7C (`ce9e38c`, ya con 2 argumentos) quedara corriendo un instante después del DROP | No — ninguna query de `master` toca esta tabla | **Sin blocker si se aplica junto con el deploy del backend en el orden correcto (migraciones antes, y sin dejar el proceso viejo de Fase 7C corriendo después del DROP)** |

**Ningún blocker de base de datos** en el sentido de "esto rompe algo ya en producción" — `master`
no conoce ninguna de estas tablas/columnas/funciones. El único punto de atención real es el de la
nota de §2 (ventana de incompatibilidad de `claim_hubspot_sync_outbox_batch` si el deploy no es
atómico) — se marca como **verificar, no blocker**, condicionado a confirmar el modelo de deploy de
Render.

---

## 4. Inventario de variables de Render

| Variable | Requerida para deploy | Requerida solo para activación | Default (config.ts) | Secreto | Fase |
|---|---|---|---|---|---|
| `NODE_ENV` | Sí (ya existe) | — | `development` | No | pre-existente |
| `PORT` | Sí (Render la inyecta) | — | `3000` | No | pre-existente |
| `SUPABASE_URL` | Sí (ya existe) | — | opcional | No (URL pública del proyecto) | pre-existente |
| `SUPABASE_SECRET_KEY` | Sí (ya existe) | — | opcional | **Sí — el más sensible** | pre-existente |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | Sí (ya existen, si Calendar real está activo) | — | opcional (los 3 juntos o ninguno) | Sí | pre-existente |
| `WHATSAPP_ACCESS_TOKEN` / `_PHONE_NUMBER_ID` / `_VERIFY_TOKEN` / `META_APP_SECRET` | Sí (ya existen, si WhatsApp real está activo) | — | opcional (los 4 juntos o ninguno) | Sí | pre-existente |
| `HUBSPOT_PRIVATE_APP_TOKEN` | Sí (ya existe, si HubSpot real está activo) | — | opcional | Sí | Fase 6F |
| `CORS_ALLOWED_ORIGINS` | No | No | auto por `NODE_ENV` | No | pre-existente |
| `LEADS_RATE_LIMIT_MAX` / `_WINDOW_MS` | No | No | `20` / `60000` | No | pre-existente |
| `APPOINTMENT_REMINDERS_ENABLED` | No — puede quedar ausente | Sí, para activar | `false` | No | Fase 7A |
| `POST_MEETING_FOLLOWUP_ENABLED` | No | Sí | `false` | No | Fase 7A |
| `NO_SHOW_DETECTION_ENABLED` | No | Sí (pero ver §21 — mantener `false` siempre por ahora) | `false` | No | Fase 7A |
| `APPOINTMENT_CONFIRMATION_ENABLED` | No | Sí | `false` | No | Fase 7A |
| `WHATSAPP_TEMPLATE_REMINDER_24H` | No | **Sí, antes de activar `APPOINTMENT_REMINDERS_ENABLED`** | `recordatorio_24h` | No | Fase 7A |
| `WHATSAPP_TEMPLATE_REMINDER_2H` | No | Sí, antes de activar reminders | `recordatorio_2h` | No | Fase 7A |
| `WHATSAPP_TEMPLATE_POST_MEETING` | No | Sí, antes de activar follow-up | `seguimiento_post_cita` | No | Fase 7A |
| `WHATSAPP_TEMPLATE_NO_SHOW` | No | Sí, antes de usar el nudge (manual) | `no_show_nudge` | No | Fase 7A |
| `WHATSAPP_TEMPLATE_LANGUAGE` | No | Sí, junto con las plantillas | `es_MX` | No | Fase 7A |
| `REMINDER_RUNNER_SECRET` | No (endpoint falla cerrado sin ella) | **Sí, antes de configurar el scheduler** | ausente = 401 siempre | **Sí** | Fase 7A |
| `ADMIN_API_TOKEN` | No | **Sí, antes de que Héctor use mark-completed/mark-no-show** | ausente = 401 siempre | **Sí** | Fase 7A |
| `LEAD_INTEGRITY_ENABLED` | No | Sí | `false` | No | Fase 7B |
| `EMAIL_DNS_VALIDATION_ENABLED` | No | Sí (solo importa si `LEAD_INTEGRITY_ENABLED=true`) | `false` | No | Fase 7B |
| `DISPOSABLE_EMAIL_CHECK_ENABLED` | No | Sí (ídem) | `false` | No | Fase 7B |
| `EMAIL_DISPOSABLE_DOMAINS_EXTRA` | No | No | ausente | No | Fase 7B |
| `HONEYPOT_ENABLED` | No | **Sí — este SÍ bloquea/descarta submissions (ver §16)** | `false` | No | Fase 7B |
| `STRICT_BOOKING_INTEGRITY_ENABLED` | No | N/A — **reservada, ningún código la lee todavía; activarla no tiene efecto alguno** | `false` | No | Fase 7B |
| `HUBSPOT_OUTBOX_ENABLED` | No | Sí — ver semántica exacta en §5/§9 | `false` | No | Fase 7C |
| `HUBSPOT_SYNC_RUNNER_SECRET` | No (endpoint falla cerrado sin ella) | **Sí, antes de configurar el scheduler de outbox** | ausente = 401 siempre | **Sí** | Fase 7C |
| `HUBSPOT_OUTBOX_BATCH_SIZE` | No | No | `20` | No | Fase 7C |
| `HUBSPOT_OUTBOX_MAX_ATTEMPTS` | No | No | `6` | No | Fase 7C |
| `HUBSPOT_OUTBOX_STALE_PROCESSING_THRESHOLD_MS` | No | No | `600000` (10 min) | No | Fase 7C.1 |

**Hallazgo adicional (fuera del alcance directo de Fase 7C.1, mencionado por transparencia)**: al
auditar `.env.example` contra `config.ts` para esta tabla se encontró que `.env.example` **no
documentaba** `HUBSPOT_OUTBOX_STALE_PROCESSING_THRESHOLD_MS` (introducida en Fase 7C.1) — ya
corregido en este mismo commit de auditoría (`.env.example` actualizado, cambio puramente de
documentación, sin efecto en runtime). También se observó que `.env.example` no incluye
`QUALIFICATION_ENGINE_ENABLED`, `WHATSAPP_CANCELLATION_ENABLED`, `WHATSAPP_RESCHEDULE_ENABLED`,
`HUBSPOT_PORTAL_ID` (todas preexistentes, de fases anteriores a 7A) — no se tocan aquí por estar
fuera del alcance de Fase 7D, pero quedan anotadas para una futura limpieza de documentación.

---

## 5. Flags de deploy seguro (primer deploy)

Valores exactos para el primer deploy de `5f96883`:

```
APPOINTMENT_REMINDERS_ENABLED=false
POST_MEETING_FOLLOWUP_ENABLED=false
NO_SHOW_DETECTION_ENABLED=false
APPOINTMENT_CONFIRMATION_ENABLED=false
LEAD_INTEGRITY_ENABLED=false
EMAIL_DNS_VALIDATION_ENABLED=false
DISPOSABLE_EMAIL_CHECK_ENABLED=false
HONEYPOT_ENABLED=false
STRICT_BOOKING_INTEGRITY_ENABLED=false
HUBSPOT_OUTBOX_ENABLED=false
```

Con estos 10 en `false`, el comportamiento de `5f96883` es **byte-for-byte idéntico** al de
`master` en todo lo que estas flags controlan — la única diferencia observable sería la de nuevos
endpoints existiendo (pero fallando 401 sin sus secretos) y las migraciones nuevas (tablas/columnas
vacías, nunca leídas).

### Semántica exacta de `HUBSPOT_OUTBOX_ENABLED` (ya auditada en Fase 7C.1, reconfirmada aquí)

- Controla **únicamente** si `WebLeadCaptureService` escribe en `hubspot_sync_outbox` (`true`) o
  llama a HubSpot de forma síncrona e inline (`false`, comportamiento actual de `master`/producción).
- **NO controla** si el worker (`HubSpotOutboxProcessorService`, disparado por `POST
  /internal/hubspot-sync/run`) procesa filas existentes — el worker **siempre** intenta drenar
  `PENDING`/`FAILED_RETRYABLE`/`PROCESSING` obsoletas, sin importar el valor de esta flag.
- **Decisión para el primer deploy: `false`.** Activarlo requiere que TODO lo de §9 (worker
  desplegado, secreto configurado, scheduler funcionando) ya esté probado — nunca se activa en el
  mismo paso que el primer deploy pasivo del backend.

---

## 6. Frontend patch (impuestos.html) — NO aplicado

Confirmado contra `docs/security/FASE7C-FRONTEND-CHANGES.md` (secciones 0 y 1 de ese documento).
Patch exacto para quien tenga acceso a Hostinger:

**A) Timeout**
```diff
     LEAD_ENGINE_URL: "https://baluarte-lead-engine.onrender.com",
-    LEAD_ENGINE_TIMEOUT_MS: 4000
+    LEAD_ENGINE_TIMEOUT_MS: 15000
```

**B) Constante de versión de cálculo** (junto a `UMA_ANUAL_2026`/`LIMITE_5_UMAS`, antes de
`buildLeadEnginePayload()`):
```diff
+  var FISCAL_CALCULATION_VERSION = "ppr_calc_2026_v1";
```

**C) Enviar la versión en el payload real**, dentro del objeto `fiscalCalculator: {...}` que ya
arma `buildLeadEnginePayload()`:
```diff
   fiscalCalculator: {
     age: edad,
     city: ciudad,
     taxRegime: regimen,
     ...
+    calculationVersion: FISCAL_CALCULATION_VERSION,
   }
```

**No se aplicó nada de esto.** El backend ya soporta ambos casos desde Fase 6F.2 (con o sin
`calculationVersion`) — este patch es puramente aditivo desde el lado del frontend, y **no depende
de ningún deploy del backend** para ser seguro de aplicar en cualquier momento (aunque §14
recomienda aplicarlo DESPUÉS de que el backend esté estable, por disciplina de cambio-a-la-vez, no
por una dependencia técnica real).

---

## 7. Legacy HubSpot Forms API (`enviarHubSpot()`)

**Se mantiene sin retirar en el primer deploy — y en varios deploys después.** Ver
`docs/security/FASE7C-FRONTEND-CHANGES.md` §"Criterio objetivo de retiro" (ya escrito en Fase
7C.1), reproducido aquí como referencia rápida — las 6 condiciones, TODAS requeridas antes de
retirarlo:

1. Migración 021 aplicada en producción.
2. `HUBSPOT_OUTBOX_ENABLED=true` en producción, sin rollback intermedio, por ≥14 días consecutivos.
3. ≥20 submissions reales consecutivas con `hubspot_sync_outbox.status='SUCCEEDED'`, cero
   `FAILED_PERMANENT` inexplicados.
4. Cero filas atascadas en `PROCESSING` más allá del umbral de staleness durante esa ventana.
5. Al menos un caso real (o una QA controlada explícitamente autorizada) de conflicto de identidad
   resuelto correctamente por el outbox.
6. Confirmación manual de que las 37 propiedades `bc_fiscal_*` llegan completas a HubSpot para esos
   registros reales.

---

## 8. Primer deploy — backend pasivo (STEP-BY-STEP, NO ejecutado)

**STEP 1 — Aplicar migraciones 017→018→019→020→021**, en ese orden exacto, contra la base de
producción, ANTES del deploy del backend. Verificar cada una con `select 1 from
information_schema.tables where table_name in ('fiscal_lead_scores','hubspot_sync_outbox');` y
`select proname from pg_proc where proname in ('claim_hubspot_sync_outbox_batch',
'create_fiscal_score_with_outbox');` (debe mostrar la función `claim_hubspot_sync_outbox_batch` con
3 argumentos, no 2).

**STEP 2 — Configurar en Render** únicamente las variables necesarias para que el proceso arranque:
las ya existentes (Supabase/Google/WhatsApp/HubSpot reales, sin cambio) más, opcionalmente, las 10
flags de §5 explícitamente en `false` (aunque son el default sin configurar, fijarlas explícitas
documenta la intención y evita depender de un default silencioso). NO configurar todavía
`REMINDER_RUNNER_SECRET`, `ADMIN_API_TOKEN`, ni `HUBSPOT_SYNC_RUNNER_SECRET` — dejarlas ausentes es
seguro (los 3 endpoints que las usan fallan 401 sin ellas, exactamente el comportamiento deseado en
este primer deploy).

**STEP 3 — Deploy del commit `5f96883`** en la branch/servicio de Render (confirmar previamente el
Start Command y la versión de Node — hallazgos de §1).

**STEP 4 — Verificar `/health`**: `GET /health` debe responder 200 con la MISMA forma que tenía
antes (`RENDER-CHECKLIST.md` §5 ya documenta que esta respuesta no cambió en ninguna fase nueva).

**STEP 5 — Verificar el webhook de Meta**: `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<n>`
debe seguir devolviendo el challenge sin cambios (esta ruta no fue tocada por 7A/7B/7C/7C.1).

**STEP 6 — Verificar disponibilidad de Google Calendar**: `GET /api/availability?from=...&to=...`
debe devolver slots reales, sin cambio de forma.

**STEP 7 — Verificar una conversación real con Lía** (mensaje de WhatsApp de prueba manual, si el
protocolo del negocio lo permite, o revisar logs de una conversación reciente) — confirmar que el
flujo conversacional (bienvenida, PPR, GMM, calificación) sigue respondiendo igual.

**STEP 8 — Verificar el sync actual de HubSpot**: con `HUBSPOT_OUTBOX_ENABLED=false`, un nuevo
submission del calculador debe seguir sincronizando a HubSpot de forma síncrona e inline, exactamente
como hoy — revisar logs por la línea `"hubspot fiscal sync succeeded"` tras un submission real o de
QA (ver §11 para el diseño del QA, no ejecutar aún).

**STEP 9 — Verificar que las flags de reminders en `false` no envían nada**: revisar logs de arranque
por la línea `"Phase 3B/3C/4B/4C/7A/7B/7C feature flags"` y confirmar
`appointmentRemindersEnabled:false, postMeetingFollowupEnabled:false, appointmentConfirmationEnabled:false,
noShowDetectionEnabled:false` — y confirmar que `POST /internal/reminders/run` (si se probara
manualmente con curl y sin secreto) responde 401, nunca 200.

**STEP 10 — Verificar que `LEAD_INTEGRITY_ENABLED=false` no bloquea nada**: un submission real del
calculador debe persistir el lead normalmente (sin honeypot activo tampoco, por defecto) — confirmar
que ningún lead legítimo recibe un 4xx nuevo que no existía antes de este deploy.

---

## 9. HubSpot outbox rollout — secuencia real (auditada contra el código, no asumida)

Separación exacta de las 3 fases, con la semántica REAL de `HUBSPOT_OUTBOX_ENABLED` (§5):

- **WRITE TO OUTBOX**: ocurre exclusivamente dentro de `WebLeadCaptureService.capture()` →
  `scoreFiscalCalculatorSubmission()`, y SOLO si `HUBSPOT_OUTBOX_ENABLED=true` (y el nuevo
  `AtomicFiscalCaptureRepository` está conectado, lo cual ya es automático en `app.ts` desde Fase
  7C.1 — no requiere configuración adicional).
- **PROCESS OUTBOX**: ocurre exclusivamente en `HubSpotOutboxProcessorService.run()`, invocado por
  `POST /internal/hubspot-sync/run` — **totalmente independiente de la flag anterior**. Si hay filas
  en la tabla (de cualquier origen) y el endpoint se llama, se procesan.
- **REMOVE SYNC INLINE**: no existe ningún flag para esto — es simplemente la consecuencia de que,
  con `HUBSPOT_OUTBOX_ENABLED=true`, el código YA NO llama a `HubSpotFiscalSyncService` en el
  camino síncrono. El código inline sigue existiendo (nunca se borra) para cuando la flag esté en
  `false`.

**El riesgo real que el usuario señala ("jobs acumulándose sin worker") ocurre si `WRITE TO
OUTBOX` se activa (`HUBSPOT_OUTBOX_ENABLED=true`) ANTES de que `PROCESS OUTBOX` esté realmente
operativo** (scheduler configurado y corriendo). Por eso el orden correcto NUNCA activa la escritura
antes de tener el procesamiento probado:

```
A. Migraciones (§2) -- YA en STEP 1 del primer deploy (§8)
B. Deploy del backend con HUBSPOT_OUTBOX_ENABLED=false (§8) -- el worker YA EXISTE en el código
   desplegado, simplemente no tiene nada que procesar todavía (tabla vacía)
C. Configurar HUBSPOT_SYNC_RUNNER_SECRET en Render
D. Probar manualmente POST /internal/hubspot-sync/run (curl) -- debe responder 200 con
   {ok:true, claimed:0, succeeded:0, retryScheduled:0, permanentlyFailed:0} (tabla aún vacía)
E. Configurar el scheduler (Render Cron / cron-job.org / GitHub Actions -- ver §10) y CONFIRMAR
   que corre al menos una vez exitosamente antes del siguiente paso
F. SOLO ENTONCES activar HUBSPOT_OUTBOX_ENABLED=true
G. QA de un lead controlado (§11) -- ahora sí genera una fila real en la tabla
H. Observar: la fila QA debe pasar de PENDING a SUCCEEDED dentro de, como máximo, un ciclo del
   scheduler (ver §10 para la frecuencia recomendada)
```

Esto invierte el orden "E/F" que un lector apurado podría asumir del ejemplo del prompt original
(`E. enable outbox` antes de confirmar el scheduler) — la secuencia real, auditada contra el
código, exige que el scheduler esté **probado y corriendo** antes de activar la escritura, nunca al
revés.

---

## 10. Scheduler HubSpot — `POST /internal/hubspot-sync/run`

**Frecuencia recomendada: cada 2 minutos.** Justificación: el backoff más corto del sistema de
reintentos (`domain/hubspot-sync-retry.ts`) es de 1 minuto (primer reintento) — un scheduler de 1-5
minutos es razonable; 2 minutos da margen sin dejar una fila `PENDING` esperando demasiado en el
caso común (éxito al primer intento).

**Opciones evaluadas**:
- **Render Cron Job** — preferida si el plan actual de Render lo incluye (confirmar en el
  dashboard; no confirmado en esta sesión). Un solo recurso, sin dependencia externa.
- **cron-job.org** — alternativa gratuita si el plan de Render no incluye Cron Jobs.
- **GitHub Actions scheduled workflow** — fallback si ninguna de las dos anteriores aplica; requiere
  guardar el secreto como GitHub Actions secret, nunca committeado.

**IMPORTANTE — nunca usar este cron como keep-alive de Render**: este servicio corre en plan de
pago sin cold start (confirmado explícitamente en la Fase 7C original) — el único propósito de este
scheduler es drenar la tabla de outbox, nunca mantener el proceso "despierto".

**Request exacto** (sin exponer el secreto real):

```
URL:      https://<tu-servicio>.onrender.com/internal/hubspot-sync/run
Method:   POST
Headers:  Authorization: Bearer <HUBSPOT_SYNC_RUNNER_SECRET>
          Content-Type: application/json
Body:     (vacío -- el endpoint nunca lee el body)
Schedule: */2 * * * *   (cada 2 minutos, cron estándar)
```

Respuesta esperada (200): `{"ok":true,"claimed":<n>,"succeeded":<n>,"retryScheduled":<n>,"permanentlyFailed":<n>}`.
Respuesta si el secreto está mal/ausente (401): `{"error":"UNAUTHORIZED"}` o `{"error":"NOT_CONFIGURED"}`.

---

## 11. QA de HubSpot — diseño (NO ejecutar)

Un único submission controlado, futuro:

1. Usar un **email nuevo**, claramente de prueba (p. ej. `qa-fase7d-<fecha>@example.com`) —
   nunca un dominio real de un lead existente.
2. Usar un **teléfono nuevo**, que no coincida con ningún lead ni conversación real (p. ej. un
   número mexicano no asignado, formato `+52<10 dígitos>` claramente ficticio pero válido en
   formato E.164 para pasar la normalización).
3. Nombre claramente marcado como QA (p. ej. `"QA Fase7D Test"`).
4. Completar el calculador fiscal completo (todos los campos, incluyendo edad, régimen fiscal,
   GMM/PPR, las 4 deducciones) — para poder verificar las 37 propiedades completas, no un subset.
5. **Verificar en Supabase**: `select * from leads where email = 'qa-fase7d-...';` → debe existir
   exactamente un lead. `select * from fiscal_lead_scores where lead_id = '<id>';` → debe existir
   exactamente una fila.
6. **Verificar el outbox**: `select * from hubspot_sync_outbox where lead_id = '<id>';` → debe
   existir exactamente una fila, `status` progresando de `PENDING` → `SUCCEEDED` dentro de un ciclo
   del scheduler.
7. **Verificar el fiscal score**: el `score`/`scoreClass` en `fiscal_lead_scores` debe corresponder
   a los inputs usados (verificable manualmente contra `domain/fiscal-lead-scoring.ts`'s reglas).
8. **Verificar el contacto exacto en HubSpot**: buscar por el email de QA en el portal real, abrir
   el contacto.
9. **Verificar las 37 propiedades** `bc_fiscal_*` — comparar contra
   `HUBSPOT_FISCAL_PROPERTY_NAMES` (`src/domain/hubspot-fiscal-properties.ts`); con todos los
   campos opcionales completados en el submission, las 37 deben estar presentes.
10. **Verificar `calculationVersion`**: si el patch de §6 ya se aplicó en Hostinger,
    `bc_fiscal_calculation_version` debe ser `"ppr_calc_2026_v1"`; si no, debe ser `"unknown"` — nunca
    otro valor.
11. **Verificar que no hay duplicados**: buscar en HubSpot por el mismo email/teléfono — debe
    existir exactamente UN contacto, no dos.

**No ejecutar nada de esto ahora** — requiere `HUBSPOT_OUTBOX_ENABLED=true` y el scheduler ya
probado (§9), y autorización explícita del usuario para crear el lead de prueba (recordando el
error de la fase de verificación ad-hoc anterior, donde se creó un contacto QA sin autorización
previa — ver §22).

---

## 12. QA de identity conflict — diseño (NO ejecutar)

**Caso A — control (debe funcionar normal)**: email nuevo + teléfono nuevo → un lead nuevo, sin
`identityConflict`.

**Caso B — el caso real a probar**: email nuevo + teléfono que YA pertenece a un lead existente
distinto (con un email diferente, o sin email). Comportamiento esperado, verificado contra
`WebLeadCaptureService.resolveExistingLead` (Fase 7B): el sistema NUNCA fusiona este submission con
el lead existente — crea un lead NUEVO, separado, marcado `identityConflict: true` (solo si
`LEAD_INTEGRITY_ENABLED=true`; si está en `false`, el lead nuevo se crea igual pero sin el flag
persistido — el comportamiento de "nunca fusionar" es independiente de esa flag, es el
comportamiento base del dedupe de Fase 7B).

**Verificación esperada**:
- El lead ORIGINAL (dueño legítimo del teléfono) permanece sin cambios — su email, nombre, y
  cualquier dato propio nunca se sobrescribe.
- El lead NUEVO (el submission del Caso B) existe como un registro separado.
- En HubSpot: el contacto original nunca recibe una propiedad `bc_fiscal_*` que no le corresponde;
  el submission del Caso B, si llega a sincronizar, crea un contacto HubSpot distinto (mismo
  comportamiento ya cubierto por `tests/hubspot-identity-conflict.test.ts`, que corre en cada full
  suite).

**No ejecutar ahora** — mismo motivo que §11 (requiere datos QA reales y autorización explícita).

---

## 13. Reconciliación histórica — cuándo y cómo correrla

**Cuándo**: después de que el outbox lleve al menos unos días corriendo en producción real
(`HUBSPOT_OUTBOX_ENABLED=true`, §9 completado) — el propósito de la reconciliación es encontrar
submissions de fiscal_v1 SIN fila de outbox correspondiente (huecos anteriores a la activación del
outbox, o fallos puntuales de escritura). Correrla antes de tener el outbox activo no tiene sentido
(todo sería `MISSING_OUTBOX_PARTIAL_DATA_ONLY` por definición, ya que la tabla del outbox nunca se
escribió).

**Primero, siempre `--dry-run` (que es el default — nunca pasar `--execute` en la primera corrida)**:

```
npm run reconcile:hubspot-outbox -- --since 2026-01-01
```

(ajustar `--since` a la fecha real desde la que interesa escanear; `--limit` default 500).

**Salida esperada**: un JSON con `scannedFiscalScores`, `candidateCount`, y `candidates[]` — cada
candidato con `leadIdLast8`, `submissionIdLast8` (nunca el UUID completo), `reason`
(`FAILED_PERMANENT_RETRIABLE` | `MISSING_OUTBOX_PARTIAL_DATA_ONLY`), `dataQuality`
(`FULLY_RECONSTRUCTABLE` | `PARTIALLY_RECONSTRUCTABLE` | `NOT_RECONSTRUCTABLE` |
`IDENTITY_CONFLICT`), y `actionPlanned`.

**Cómo revisar cada categoría**:
- **`FULLY_RECONSTRUCTABLE`**: hay una fila de outbox con el payload original completo, en
  `FAILED_PERMANENT`. Seguro de reintentar (`actionPlanned: "reset_to_pending"`) — solo entonces,
  con autorización explícita, correr con `--execute` (que SOLO toca estas, nunca las otras 3
  categorías).
- **`PARTIALLY_RECONSTRUCTABLE`**: no hay outbox, pero `leads.notes` tiene un bloque parseable del
  calculador para ese `submissionId` — revisar manualmente en Supabase (`select notes from leads
  where id = '<leadIdLast8 completo, buscado por otro medio>';`), nunca auto-ejecutar un resync con
  estos datos aproximados (redondeados, sin las 4 deducciones individuales).
- **`NOT_RECONSTRUCTABLE`**: solo sobrevive el score de `fiscal_lead_scores` — no hay forma de
  recuperar los inputs originales. Revisar caso por caso si vale la pena un contacto manual al lead
  para re-capturar los datos, nunca inventarlos.
- **`IDENTITY_CONFLICT`**: el lead en sí tiene `identityConflict=true` — resolver esa ambigüedad de
  identidad ANTES de considerar cualquier reconstrucción de datos fiscales para ese lead.

**Nunca ejecutar `--execute` directo** sin haber revisado el reporte dry-run completo primero, y
solo con autorización explícita del usuario.

---

## 14. Frontend deploy (después del backend estable)

Una vez completado §8 (backend pasivo estable, verificado):
1. Aplicar en Hostinger los 3 cambios de §6 (timeout, constante de versión, campo en el payload).
2. Verificar que el calculador sigue funcionando de principio a fin (todos los campos, el cálculo
   mismo, sin cambios de UX).
3. Verificar que `POST /api/leads` sigue recibiendo el submission correctamente (Network tab del
   navegador, código 200/201).
4. Verificar la UX completa: el resultado se muestra, el CTA de WhatsApp funciona, no hay errores
   en la consola del navegador (`F12` → Console, sin `Uncaught`/`Refused to load`).
5. **No retirar `enviarHubSpot()` en este paso** (ver §7).

---

## 15. Security headers Hostinger — checklist separado (NO activar automáticamente)

Referencia completa: `docs/security/HOSTINGER-HEADERS.md` (ya escrito, Fase 7B). Orden recomendado,
reconfirmado aquí:

1. **Headers no disruptivos primero**: `X-Content-Type-Options`, `Referrer-Policy`,
   `Permissions-Policy`, `X-Frame-Options`, `Strict-Transport-Security` (confirmando primero que
   HTTPS-forzado ya está activo en el panel de Hostinger, o agregando el redirect) — bajo riesgo de
   romper algo.
2. **CSP en modo `Content-Security-Policy-Report-Only`** — nunca en modo enforcement directo. Cargar
   cada página del sitio con DevTools abierto y revisar violaciones en consola.
3. **Observar** durante al menos unos días de tráfico real (o una revisión manual exhaustiva de cada
   página/flujo) antes de continuar.
4. **CSP enforcement** solo después de cero violaciones observadas en modo Report-Only.

**No aplicar nada de esto automáticamente ni ahora** — cada paso requiere revisión humana de la
consola del navegador contra el sitio real, que esta sesión no puede hacer sin acceso a Hostinger.

---

## 16. Lead integrity rollout — no activar todo junto

Semántica real, auditada contra el código (no asumida):

| Flag | ¿Bloquea/rechaza una submission? | Naturaleza |
|---|---|---|
| `LEAD_INTEGRITY_ENABLED` | **No** — solo computa y persiste `emailQuality`, `phoneQuality`, `suspectedAutomation`, `identityConflict`, `leadIntegrityScore`. Ningún caller en el código usa estos campos para bloquear, cambiar status, o afectar elegibilidad de mensajería (confirmado en `domain/lead-integrity-score.ts`'s propio doc comment) | Pasivo/scoring |
| `EMAIL_DNS_VALIDATION_ENABLED` | No (sub-flag de la anterior; solo agrega una verificación DNS al cómputo de `emailQuality`) | Pasivo |
| `DISPOSABLE_EMAIL_CHECK_ENABLED` | No (sub-flag; solo etiqueta `DISPOSABLE` en `emailQuality`) | Pasivo |
| `HONEYPOT_ENABLED` | **SÍ — bloquea de verdad.** Con esta flag en `true`, un submission con el campo honeypot lleno NUNCA se persiste, nunca sincroniza a HubSpot (`app.ts` línea ~771: `if (honeypotEnabled && isHoneypotTriggered(...))`). **Independiente de `LEAD_INTEGRITY_ENABLED`** — es su propia flag, su propio interruptor. | **Bloqueante** |
| `STRICT_BOOKING_INTEGRITY_ENABLED` | N/A — ningún código la lee todavía. Activarla no tiene efecto alguno, en ningún sentido. | Sin efecto (reservada) |

**Fase Passive (activar primero, sin riesgo de bloqueo real)**:
```
LEAD_INTEGRITY_ENABLED=true
```
Esto activa automáticamente, como efecto colateral documentado: (a) el cómputo de
`emailQuality`/`phoneQuality`/`suspectedAutomation`/`identityConflict`/`leadIntegrityScore` en cada
submission web, y (b) la verificación pasiva de teléfono por WhatsApp (§17, misma flag, sin
interruptor separado). Ningún lead legítimo es rechazado por esto.

**Uno por uno, después de confirmar que la Fase Passive no generó ningún efecto inesperado
(revisar logs/Supabase por unos días)**:
```
DISPOSABLE_EMAIL_CHECK_ENABLED=true       (solo etiqueta, no bloquea)
EMAIL_DNS_VALIDATION_ENABLED=true         (solo etiqueta, no bloquea; agrega latencia de un lookup DNS por submission con email nuevo)
HONEYPOT_ENABLED=true                     (ESTE SÍ BLOQUEA -- activar solo tras confirmar que el campo honeypot del formulario real en Hostinger existe, tiene el name/id correcto, y nunca es autocompletado por un gestor de contraseñas de un usuario real -- un falso positivo aquí rechaza un lead legítimo silenciosamente)
```
`STRICT_BOOKING_INTEGRITY_ENABLED` se deja fuera de esta secuencia por completo — no hay nada que
activar (no tiene código consumidor).

---

## 17. WhatsApp phone verification

Confirmado contra `whatsapp-inbound-service.ts`: la verificación pasiva **se activa con la MISMA
flag `LEAD_INTEGRITY_ENABLED`** (no existe una flag separada para esto). Semántica exacta
(`applyPassiveWhatsAppPhoneVerification`):

- Si el lead no tiene `phoneE164` guardado → se guarda el que llega por WhatsApp, marcado
  `phoneQuality: "VERIFIED"`, `phoneVerifiedAt: now()`.
- Si el `phoneE164` que llega coincide con el que ya tiene el lead → se marca `VERIFIED` (si aún no
  lo estaba).
- Si el `phoneE164` que llega es DIFERENTE al que el lead ya tiene → **nunca se sobrescribe** — se
  marca `identityConflict: true` (una sola vez; si ya estaba marcado, no se toca de nuevo) y se
  loguea una advertencia (sin PII).

**Cómo probarlo (diseño, no ejecutar ahora)**: con `LEAD_INTEGRITY_ENABLED=true`, un lead cuyo
`calculator phone` (el capturado en el submission web) sea idéntico al `WhatsApp inbound phone`
(el número real desde el que escribe) debe terminar `phoneQuality=VERIFIED`. Un lead que escriba
por WhatsApp desde un número DISTINTO al que puso en el calculador debe terminar
`identityConflict=true`, con el `phoneE164` original intacto.

**No se escribe nada en producción ahora** — esto se activa automáticamente en cuanto
`LEAD_INTEGRITY_ENABLED=true` esté activo (§16), no requiere ningún paso adicional.

---

## 18. Appointment reminders rollout

**No activar hasta**: (a) las 4 plantillas de Meta aprobadas con los nombres exactos configurados
en `WHATSAPP_TEMPLATE_*`, (b) `WHATSAPP_TEMPLATE_LANGUAGE=es_MX` confirmado, (c)
`REMINDER_RUNNER_SECRET` configurado, (d) el scheduler de `/internal/reminders/run` probado, (e) un
QA controlado (una cita real o de prueba con horario cercano) confirmando que el mensaje sale
correctamente.

**Orden verificado contra el código real** (§8 de este documento fase 7A, revisado línea por
línea en `app.ts`/`whatsapp-appointment-confirmation-handler.ts`):

`APPOINTMENT_CONFIRMATION_ENABLED` y `APPOINTMENT_REMINDERS_ENABLED` son **flags
independientes en el código** (ninguna lee el valor de la otra) — PERO el handler de confirmación
solo se dispara cuando el último mensaje saliente fue exactamente el recordatorio de 24h (con su
metadata de "pendiente de confirmación" adjunta), lo cual solo ocurre si `APPOINTMENT_REMINDERS_ENABLED`
alguna vez estuvo activo y de hecho corrió el sweep de 24h. Es decir:

- Activar `APPOINTMENT_CONFIRMATION_ENABLED=true` con `APPOINTMENT_REMINDERS_ENABLED=false` es
  **100% inerte y seguro** — nunca hay un mensaje de recordatorio 24h que abra la ventana de
  confirmación, así que el handler nunca se dispara.
- Activar `APPOINTMENT_REMINDERS_ENABLED=true` ANTES que `APPOINTMENT_CONFIRMATION_ENABLED` crea una
  ventana real de UX degradada (no de datos corruptos): el recordatorio pregunta "¿confirmas?",
  pero si el lead responde "sí", el sistema no tiene el handler activo para interpretarlo como
  confirmación — cae al flujo genérico existente (nunca rompe nada, solo no confirma la cita en el
  sistema).

**Por lo tanto, el orden propuesto originalmente por el usuario es el correcto, confirmado contra
el código**:

```
1. APPOINTMENT_CONFIRMATION_ENABLED=true   (inerte hasta que haya reminders — seguro activarlo primero)
2. APPOINTMENT_REMINDERS_ENABLED=true      (ahora sí genera recordatorios, y la confirmación ya está lista para atraparlos)
3. POST_MEETING_FOLLOWUP_ENABLED=true      (independiente de las dos anteriores — solo depende de que Héctor use mark-completed manualmente)
```

`NO_SHOW_DETECTION_ENABLED` permanece `false` durante TODO este rollout (§21) — no forma parte de
esta secuencia de activación.

---

## 19. Meta template checklist

| Plantilla (env var) | Nombre configurado por default | Variables (orden) | Idioma |
|---|---|---|---|
| `WHATSAPP_TEMPLATE_REMINDER_24H` | `recordatorio_24h` | 1. nombre — 2. cuándo (fecha+hora combinada, un solo string, vía `formatSlotForDisplay`) | `es_MX` |
| `WHATSAPP_TEMPLATE_REMINDER_2H` | `recordatorio_2h` | 1. nombre — 2. cuándo (mismo formato que el de 24h — copy deliberadamente igual, ver `message-templates.ts`) | `es_MX` |
| `WHATSAPP_TEMPLATE_POST_MEETING` | `seguimiento_post_cita` | 1. nombre (una sola variable) | `es_MX` |
| `WHATSAPP_TEMPLATE_NO_SHOW` | `no_show_nudge` | 1. nombre (una sola variable) | `es_MX` |

Confirmado línea por línea contra `src/domain/message-templates.ts` (`buildAppointmentReminder24hMessage`,
`buildAppointmentReminder2hMessage`, `buildPostMeetingFollowupMessage`, `buildNoShowNudgeMessage`) —
estos 4 textos son el copy EXACTO que Meta debe aprobar (ver ese archivo para el texto completo en
español, no reproducido aquí para evitar una segunda fuente de verdad que pueda desincronizarse).

---

## 20. Reminder scheduler — `POST /internal/reminders/run`

```
URL:      https://<tu-servicio>.onrender.com/internal/reminders/run
Method:   POST
Headers:  Authorization: Bearer <REMINDER_RUNNER_SECRET>
          Content-Type: application/json
Body:     (vacío -- el endpoint nunca lee el body)
Schedule: */15 * * * *   (cada 15 minutos)
```

**Consideraciones de timezone**: el sweep compara contra `ADVISOR_TIMEZONE` (`America/Mexico_City`
por default) internamente — el scheduler mismo puede correr en UTC o cualquier timezone (Render
Cron, cron-job.org y GitHub Actions todos usan UTC por default) sin que eso afecte el cálculo, ya
que la comparación de "faltan 24h/2h" se hace contra timestamps absolutos (`now()`), no contra la
hora local del scheduler.

**Respuesta esperada** (200): `{"ok":true,"reminder24h":{"candidates":n,"sent":n,"failed":n,"skipped":n},"reminder2h":{...},"postMeetingFollowup":{...}}`.

**Comportamiento de reintento**: el propio endpoint es idempotente y stateless — un fallo de red del
scheduler simplemente significa que ese ciclo no corrió; el siguiente ciclo (15 min después) vuelve
a evaluar todos los candidatos elegibles desde cero, sin duplicar envíos (la elegibilidad se
recalcula contra el estado real de cada cita, no contra un contador de intentos separado).

---

## 21. No-show — se mantiene manual

```
NO_SHOW_DETECTION_ENABLED=false
```

permanece así durante TODO este rollout — no forma parte de ninguna secuencia de activación
descrita en este documento. Confirmado en el código: ningún consumidor lee esta flag todavía
(`config.ts` la documenta explícitamente como "reserved for a future automatic nudge... no code
reads this yet").

**Cómo Héctor marca una cita manualmente hoy** (ya construido, Fase 7A, disponible desde el primer
deploy de §8):

```
POST /api/appointments/:id/mark-completed
Headers: x-admin-token: <ADMIN_API_TOKEN>

POST /api/appointments/:id/mark-no-show
Headers: x-admin-token: <ADMIN_API_TOKEN>
```

Ambos requieren `ADMIN_API_TOKEN` configurado (§4) y devuelven la cita actualizada (200), 404 si no
existe, o 409 si el estado actual es inconsistente con la transición pedida. **Una UI de admin para
que Héctor haga esto sin `curl`/Postman es explícitamente una fase futura, no construida aún** — se
documenta aquí como pendiente, no como parte de este rollout.

---

## 22. Contacto QA anterior — `Diagnostico Test` (`246658425738`)

**No se toca en este documento ni en este rollout.** Plan para una fase futura, solo tras
autorización explícita (ya documentado en Fase 7C.1, reproducido aquí):

1. Releer sus propiedades actuales vía la conexión de HubSpot ya autenticada.
2. Verificar asociaciones (deals, tickets, notas, tareas).
3. Buscar en Supabase (`leads`) por el email/teléfono usado al crearlo.
4. Mostrar el plan de borrado exacto (qué se borra en HubSpot, qué en Supabase, qué NO se toca).
5. Solicitar confirmación final explícita.
6. Borrar únicamente lo aprobado.

---

## 23. Secret rotation checklist

Usando el checklist ya existente de Fase 7B (`docs/security/RENDER-CHECKLIST.md` §3), clasificado
según el pedido de esta fase:

| Secreto | Clasificación | Razón |
|---|---|---|
| `SUPABASE_SECRET_KEY` | **ROTATE BEFORE DEPLOY** (si hay sospecha de exposición previa) / CAN WAIT si no la hay | Bypasea RLS por completo — el más sensible del sistema |
| `META_APP_SECRET` | ROTATE BEFORE DEPLOY si se pegó alguna vez en un chat/terminal durante troubleshooting de fases anteriores | Firma el webhook de WhatsApp |
| `WHATSAPP_ACCESS_TOKEN` | ROTATE BEFORE DEPLOY (mismo motivo) | Permite enviar mensajes como el negocio |
| `WHATSAPP_VERIFY_TOKEN` | CAN WAIT (elegido por Héctor, no emitido por Meta) — rotar solo si se decide cambiarlo, coordinado con la config del webhook en Meta al mismo tiempo | Bajo riesgo si no se compartió |
| `HUBSPOT_PRIVATE_APP_TOKEN` | ROTATE BEFORE ACTIVATION del outbox (Fase 7C), si hubo exposición | El worker lo usará activamente en cuanto `HUBSPOT_OUTBOX_ENABLED=true` |
| `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | CAN WAIT salvo exposición confirmada | Ya en uso hoy sin incidentes reportados |
| `REMINDER_RUNNER_SECRET` | **ROTATE BEFORE ACTIVATION** — generar nuevo, nunca reusar un valor de desarrollo/pruebas | Nuevo en Fase 7A, nunca usado en producción aún |
| `ADMIN_API_TOKEN` | **ROTATE BEFORE ACTIVATION** — mismo motivo | Nuevo en Fase 7A |
| `HUBSPOT_SYNC_RUNNER_SECRET` | **ROTATE BEFORE ACTIVATION** — mismo motivo | Nuevo en Fase 7C |

**No se rota nada en esta sesión** — esta tabla es solo la clasificación pedida.

---

## 24. Deploy regression checklist

Después del deploy del backend (§8), verificar, en orden:

1. `GET /health` → 200, forma sin cambios.
2. CORS → un origin no listado en `CORS_ALLOWED_ORIGINS` sigue rechazado; `baluartecapital.com.mx`
   sigue permitido.
3. `POST /api/leads` → 201/200 igual que antes.
4. El insert en Supabase (`leads`) ocurre correctamente.
5. `fiscal_v1` (fiscal_lead_scores) se sigue calculando y persistiendo.
6. El sync actual de HubSpot (inline, `HUBSPOT_OUTBOX_ENABLED=false`) sigue funcionando.
7. Verificación del webhook de Meta (`GET /webhooks/whatsapp` con el challenge) sigue funcionando.
8. Un mensaje de WhatsApp inbound real se procesa sin error.
9. Lía (el flujo conversacional) responde igual que antes.
10. El flujo de PPR (preguntas/respuestas del calculador conversacional) no cambia.
11. El flujo de GMM no cambia.
12. `GET /api/availability` sigue devolviendo slots reales de Google Calendar.
13. Un booking completo (`POST /api/appointments`, flujo de WhatsApp) sigue funcionando.
14. Un reschedule sigue funcionando.
15. Una cancelación sigue funcionando.
16. **Cero mensajes proactivos** salen sin que nadie los dispare (confirmar que ningún reminder, ni
    follow-up, ni no-show nudge se envía con las flags en `false`).
17. Los endpoints admin (`mark-completed`/`mark-no-show`) responden 401 sin token, 200 con el
    token correcto.
18. Los endpoints internos (`/internal/reminders/run`, `/internal/hubspot-sync/run`) responden 401
    sin su secreto respectivo.
19. Los rate limits siguen activos (probar exceder el límite de `POST /api/leads` y confirmar 429).
20. Los logs no contienen PII (revisar una muestra de logs reales tras el deploy — nombre,
    teléfono, email, ingresos nunca deben aparecer en texto plano en ningún log nuevo).

---

## 25. Rollback plan (por capa, nunca "revert migration" como default)

| Capa | Rollback |
|---|---|
| **DATABASE** | Las migraciones son aditivas — mientras las flags que las alimentan estén en `false`, NO hay necesidad de revertir el schema en absoluto para deshacer un problema de comportamiento (ver "BACKEND DEPLOY" abajo). Revertir el schema (DROP TABLE/COLUMN/FUNCTION) es el ÚLTIMO recurso, solo si el propio DDL causó un error de aplicación (poco probable, dado que todas son aditivas) — usar el bloque "Rollback:" de cada archivo de migración, en orden inverso (021 antes que 020, etc.) |
| **BACKEND DEPLOY** | Revertir al deploy anterior de Render (Render conserva el build previo — un rollback de un click en el dashboard, o un nuevo deploy del commit `f35a9f8`/lo que sea el HEAD real de producción confirmado en §1) |
| **OUTBOX** | `HUBSPOT_OUTBOX_ENABLED=false` — inmediato, sin reiniciar nada más. Las filas ya en la tabla (`PENDING`) siguen siendo drenadas por el worker si el scheduler sigue corriendo (ver semántica de §5/§9) — esto es SEGURO, no pierde datos, simplemente dejan de crearse filas nuevas |
| **SCHEDULER** | Pausar/eliminar el cron job (Render Cron: pausar desde el dashboard; cron-job.org: desactivar; GitHub Actions: deshabilitar el workflow). Las filas `PENDING` quedan esperando, sin pérdida, listas para cuando se reactive |
| **FRONTEND** | Revertir el commit del patch en el repo de `impuestos.html` (Hostinger) — el timeout vuelve a 4000ms, `calculationVersion` deja de enviarse (el backend cae de nuevo a `"unknown"`, sin romper nada) |
| **LEAD INTEGRITY** | `LEAD_INTEGRITY_ENABLED=false` (y sus sub-flags) — inmediato. Los campos ya escritos en `leads` (email_quality, etc.) permanecen en la base pero dejan de calcularse/actualizarse; ningún código los lee para decisiones, así que esto es 100% seguro |
| **REMINDERS** | `APPOINTMENT_REMINDERS_ENABLED=false` / `APPOINTMENT_CONFIRMATION_ENABLED=false` / `POST_MEETING_FOLLOWUP_ENABLED=false` — inmediato. Deja de enviarse cualquier mensaje proactivo nuevo; las citas ya recordatoreadas no se ven afectadas retroactivamente |

**Principio general**: preferir SIEMPRE "flags en false" + "scheduler apagado" + "deploy anterior de
Render" sobre revertir migraciones — las migraciones aditivas nunca necesitan revertirse para
deshacer un problema de comportamiento, solo en el caso extremo de que el propio DDL fallara al
aplicarse.

---

## 26. Blockers

| Tipo | Ítem |
|---|---|
| **BLOCKER** (ninguno crítico identificado) | — |
| **NON-BLOCKER, pero verificar antes de STEP 3 de §8** | Confirmar el Start Command real configurado en Render y la versión de Node del servicio (hallazgo de §1) — si el Start Command está hardcodeado a algo distinto de `node dist/src/server.js`, o si el runtime de Node es menor a 22, el deploy fallaría al arrancar. Esto NO es un blocker en el sentido de "hay que rediseñar algo" — es una verificación de 2 minutos en el dashboard de Render antes de desplegar. |
| **NON-BLOCKER, pero verificar** | Confirmar el modelo de deploy de Render (recreate vs. rolling) antes de aplicar la migración 021, por la ventana de incompatibilidad de firma de `claim_hubspot_sync_outbox_batch` descrita en §2/§3 — en el caso normal (un solo proceso, recreate) esto no es un problema. |
| **POST-DEPLOY FOLLOW-UP** | Actualizar `.env.example` para incluir `QUALIFICATION_ENGINE_ENABLED`, `WHATSAPP_CANCELLATION_ENABLED`, `WHATSAPP_RESCHEDULE_ENABLED`, `HUBSPOT_PORTAL_ID` (gaps preexistentes, no de esta fase, encontrados durante esta auditoría) |
| **POST-DEPLOY FOLLOW-UP** | Construir una UI de admin para mark-completed/mark-no-show (hoy requiere `curl`/Postman) — mencionado en §21, explícitamente fuera de alcance de este rollout |
| **POST-DEPLOY FOLLOW-UP** | Contacto QA `246658425738` — pendiente de autorización explícita para su eliminación (§22) |

**No existe ningún blocker crítico que impida autorizar el rollout pasivo** (§28).

---

## 27. Comandos/acciones exactos futuros (NO ejecutar)

**Git** (ya ejecutado en sesiones anteriores — reproducido aquí solo como referencia del estado
actual, no como una acción pendiente):
```
git checkout feature/reliable-lead-hubspot-delivery
git log -1 --oneline   # 5f96883 fix: finalize reliable hubspot delivery guarantees
```

**Supabase SQL** (aplicar en el SQL Editor de producción, en este orden, cada uno como su propia
transacción — nunca ejecutar aquí, solo referencia):
```sql
-- 017
\i supabase/migrations/017_leads_privacy_accepted_at.sql
-- 018
\i supabase/migrations/018_fiscal_lead_scores.sql
-- 019
\i supabase/migrations/019_lead_integrity.sql
-- 020
\i supabase/migrations/020_hubspot_sync_outbox.sql
-- 021
\i supabase/migrations/021_hubspot_outbox_atomicity_and_lease.sql
```
(o pegar el contenido de cada archivo directamente en el SQL Editor de Supabase, en ese orden.)

**Render** (acciones en el dashboard, no vía API en este documento):
1. Settings → Build & Deploy → confirmar branch, Start Command, Node version.
2. Environment → agregar las variables de §4 (sin activar ninguna flag de comportamiento nuevo).
3. Manual Deploy → seleccionar el commit `5f96883`.
4. Events → confirmar el deploy exitoso.

**Scheduler** (una vez elegida la herramienta, §10/§20):
```bash
curl -X POST https://<tu-servicio>.onrender.com/internal/hubspot-sync/run \
  -H "Authorization: Bearer <HUBSPOT_SYNC_RUNNER_SECRET>"

curl -X POST https://<tu-servicio>.onrender.com/internal/reminders/run \
  -H "Authorization: Bearer <REMINDER_RUNNER_SECRET>"
```

**QA** (§11/§12, solo tras autorización explícita):
```bash
npm run reconcile:hubspot-outbox -- --since 2026-01-01   # dry-run, nunca --execute sin revisión
```

---

## 28. Final GO / NO-GO

# **GO FOR PASSIVE DEPLOY**

Con las siguientes condiciones explícitas, ninguna de las cuales requiere rediseñar nada — son
verificaciones operativas de 5-10 minutos cada una, en el dashboard de Render, antes de ejecutar
STEP 3 de §8:

1. Confirmar el Start Command y la versión de Node configurados en Render (hallazgo de §1/§26).
2. Confirmar el branch/commit que Render tiene configurado como fuente de deploy.
3. Confirmar el modelo de deploy (recreate vs rolling) antes de aplicar la migración 021.

PASSIVE DEPLOY significa exactamente: backend nuevo (`5f96883`) + migraciones 017-021 aplicadas +
las 10 flags de comportamiento nuevo en `false` (§5) + sin reminders + sin no-show automático + sin
bloqueo agresivo de leads (lead integrity y honeypot ambos en `false`) + sin retirar el Forms API
legacy de HubSpot. Ningún comportamiento visible para un lead o para Héctor cambia el día del
deploy — el único riesgo real y explícito es el operativo de arranque del proceso (Start
Command/Node version), verificable y corregible en minutos si hiciera falta.

---

## 29. Reporte final — índice

1. **Producción actual detectada**: `origin/master` @ `f35a9f8`, con la reserva explícita de que no
   se pudo confirmar contra el dashboard de Render (§1) — y un hallazgo concreto (`start` script
   inconsistente con `tsconfig.json` en `master`) que sugiere verificar esto activamente antes de
   asumir que `f35a9f8` es exactamente lo desplegado hoy.
2. **Commits pendientes**: 27, listados cronológicamente en §1.
3. **Migraciones**: 017-021, inventario completo en §2.
4. **Orden de migraciones**: 017 → 018 → 019 → 020 → 021, estrictamente, antes del deploy del
   backend.
5. **Variables Render**: tabla completa de 27 variables en §4.
6. **Flags seguras**: los 10 valores exactos en §5.
7. **Patch frontend**: 3 cambios exactos en §6, ninguno aplicado.
8. **Outbox semantics**: WRITE/PROCESS/REMOVE separados y secuenciados correctamente en §9.
9. **HubSpot scheduler plan**: cada 2 minutos, request exacto en §10.
10. **Reminder scheduler plan**: cada 15 minutos, request exacto en §20.
11. **First deploy plan**: 10 steps exactos en §8.
12. **HubSpot activation plan**: 8 pasos (A-H) en §9.
13. **QA plan**: diseño completo en §11 (HubSpot) y §12 (identity conflict), ninguno ejecutado.
14. **Historical reconciliation plan**: comando y las 4 categorías explicadas en §13.
15. **Hostinger plan**: §14 (frontend) + §15 (headers), ninguno aplicado.
16. **Security headers plan**: orden de 4 pasos en §15.
17. **Lead integrity rollout**: semántica real por flag + secuencia en §16.
18. **WhatsApp verification rollout**: confirmado como parte de `LEAD_INTEGRITY_ENABLED`, sin flag
    propia, en §17.
19. **Appointment reminders rollout**: orden confirmado contra el código en §18.
20. **Meta template checklist**: 4 plantillas, variables exactas, en §19.
21. **Secret rotation checklist**: clasificación completa en §23.
22. **Regression checklist**: 20 puntos en §24.
23. **Rollback plan**: por capa, en §25.
24. **Blockers**: ninguno crítico; 2 verificaciones operativas + 3 follow-ups post-deploy, en §26.
25. **Exact future commands**: git/SQL/Render/scheduler/QA en §27, ninguno ejecutado.
26. **GO/NO-GO**: **GO FOR PASSIVE DEPLOY**, condicionado a 3 verificaciones operativas (§28).
27. **Confirmación: no hubo escritura en producción** durante esta auditoría (ningún dato de
    negocio en Supabase/HubSpot/WhatsApp/Calendar fue creado, modificado o borrado).
28. **Confirmación: no hubo deploy** (ningún cambio en Render, ningún redeploy disparado).
29. **Confirmación: no hubo merge** (`feature/reliable-lead-hubspot-delivery` permanece separada de
    `master`; el único cambio de repo en esta fase es este documento más una corrección de
    documentación en `.env.example`, ambos ya reflejados en el working tree, sin commitear
    todavía a menos que se pida explícitamente).

---

## §30 — Regla final, reconfirmada

No merge. No deploy. No production writes. No Render mutations. No Hostinger mutations. No
scheduler creation. No secret rotation. No flags activation. **Todo lo anterior se cumplió durante
esta auditoría** — este documento y la corrección de `.env.example` son los únicos cambios hechos,
ambos puramente de documentación/repo, sin ningún efecto en ningún sistema externo.
