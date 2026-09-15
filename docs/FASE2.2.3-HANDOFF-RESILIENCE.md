# Fase 2.2.3 — Handoff Resilience

Cambio mínimo, aislado, sobre el defecto de diseño confirmado en Fase 2.2.2/2.2.2A: `HUMAN_HANDOFF`
producía silencio total, indefinido, sin timeout, incluso para comandos operativos inequívocos
("Cancelar", "Reagendar") sobre una cita real y activa. Esta fase corrige exactamente eso —
**no** rediseña el Lead Engine, no toca frontend/Meta Pixel/attribution/HubSpot/lógica fiscal.

## A. Current Behavior (antes de esta fase)

- `HUMAN_HANDOFF` se dispara desde dos familias de causas: (1) **explícitas**
  (`COMPLAINT_OR_CLAIM`, `REQUESTS_HUMAN`, `FISCAL_ADVICE_REQUEST`, `AGGRESSIVE`,
  `OUT_OF_SCOPE_EXCEPTION` vía `qualification-handoff-triggers.ts`, y contenido sensible de salud
  vía `HEALTH_HANDOFF_MESSAGE`), y (2) **`UNKNOWN_INTENT_HANDOFF`** — un mensaje libre que ningún
  flujo reconoce para un lead `BOOKED`/`BOOKING_PENDING` (`escalateUnknownIntent()`,
  `whatsapp-inbound-service.ts`).
- Ambas causas producen el **mismo** efecto, sin distinción: `lead.status = HUMAN_HANDOFF`.
- El gate `wasAlreadySuppressed` (`whatsapp-inbound-service.ts`, evaluado ANTES de cualquier
  routing) es incondicional: si `lead.status === "HUMAN_HANDOFF"` (o `DO_NOT_CONTACT`), el mensaje
  se persiste pero **cero** procesamiento adicional ocurre — nunca llega a
  `isCancellationRequest`/`isRescheduleRequest`/`isOptOutMessage`, sin importar el contenido.
- Sin timeout, sin cron, sin sweep — confirmado explícitamente en el propio doc comment de
  `HumanHandoffRecoveryService`: *"Never automatic, never a cron/sweep — a human must decide, per
  lead"*. La única salida documentada era `POST /api/leads/:id/recover-handoff` (admin-token-gated,
  100% manual).
- `WhatsAppCancellationHandler.handleTurn`/`WhatsAppRescheduleHandler.handleTurn` tienen guards
  duros (`if (lead.status !== "BOOKED" && ...) return;`) — aunque un mensaje `HUMAN_HANDOFF`
  llegara hasta ellos, no harían nada, porque el status no es `BOOKED`.
- Tests existentes ya cubrían y **exigían** esta congelación: `whatsapp-booked-unknown-intent-handoff-e2e.test.ts`
  TEST 10 ("after UNKNOWN_INTENT_HANDOFF, a further message stays silent — terminal suppression").

## B. Root Design Defect

`wasAlreadySuppressed` está indexado exclusivamente por `lead.status`, sin distinguir **qué tipo**
de mensaje llegó. Trata un "hola" comercial exactamente igual que un "Cancelar" sobre una cita real
— ambos se descartan en silencio. El incidente real de Fase 2.2.2 (lead `47dd9804-...`) es la
consecuencia directa: un "Tal vez tenga una junta" disparó `UNKNOWN_INTENT_HANDOFF`, y el "Cancelar"
posterior del mismo lead se perdió igual, dejando una cita `BOOKED` obsoleta durante meses sin que
nadie —ni el lead, ni Héctor— tuviera forma de saberlo hasta la auditoría manual.

## C. Policy Chosen

**HUMAN_HANDOFF debe pausar la conversación comercial automática, nunca bloquear operaciones
críticas.** Concretamente:

1. **Comandos operativos críticos** (cancelar, reagendar, opt-out) se procesan **siempre**,
   incluso durante `HUMAN_HANDOFF` — reutilizando 100% los flujos reales existentes
   (`WhatsAppCancellationHandler`, `WhatsAppRescheduleHandler`, la rama de opt-out ya existente),
   nunca una implementación paralela.
2. Para cancelar/reagendar, el mecanismo es: **recuperar el lead fuera de `HUMAN_HANDOFF` primero**
   —reutilizando literalmente `HumanHandoffRecoveryService`, el mismo servicio que ya usa el
   endpoint admin, con la MISMA política de decisión— y dejar que el turno **continúe cayendo**
   dentro del router existente, que ya sabe manejar un lead `BOOKED` con intención de
   cancelar/reagendar. Cero lógica de cancelación/reagenda nueva.
3. El mensaje comercial libre (sin comando crítico reconocido) **sigue exactamente igual que
   antes**: silencio total, sin cambios de status — para ambas causas de handoff
   (`UNKNOWN_INTENT_HANDOFF` y explícita). Ver sección G/H para el porqué de no diferenciarlas.
4. **Preferencia elegida de la lista A-D del brief: A ("recuperable automáticamente tras una
   condición clara")**, con la condición clara siendo *"llegó un comando operativo inequívoco que
   el lead tiene derecho a ejecutar en cualquier momento"* — no un timeout arbitrario. No existe
   infraestructura de cron/sweep en este codebase (confirmado en el propio doc comment de
   `HumanHandoffRecoveryService`), y el brief pide explícitamente no inventar una sin
   justificación — por lo que **no se implementó** un timeout genérico ni un auto-recovery en
   "cualquier próximo mensaje" (eso rompería el Test 4: el bot comercial debe seguir pausado). Ver
   sección M (Risks) para el trade-off explícito que esto deja abierto.
5. Sección 6 del brief (diferenciar `UNKNOWN_INTENT_HANDOFF` vs `EXPLICIT_HUMAN_HANDOFF`): **no se
   introdujo ninguna clasificación nueva ni migración**. El mecanismo implementado no necesita
   saber POR QUÉ el lead está en `HUMAN_HANDOFF` — sólo mira el contenido del mensaje actual y los
   datos reales de la cita. Introducir una columna/campo nuevo sólo para esto no habría aportado
   claridad real (el comportamiento ya es idéntico para ambas causas), así que se omitió, en línea
   con "sólo introducir clasificación si aporta claridad real".

## D. Files Modified

**Previstos antes de editar:** `whatsapp-inbound-service.ts` (lógica central), `app.ts` (wiring de
una dependencia), `human-handoff-recovery-service.ts` (parametrizar el event type), un test file
nuevo. Ningún otro archivo.

**Realmente modificados** (git diff, `+151 -13` en 3 archivos):

| Archivo | Cambio |
|---|---|
| [src/application/whatsapp-inbound-service.ts](../src/application/whatsapp-inbound-service.ts) | Núcleo del fix: la rama `wasAlreadySuppressed` ahora distingue `DO_NOT_CONTACT` (sin cambios, silencio total) de `HUMAN_HANDOFF` (nuevo: detecta opt-out/cancelar/reagendar y los deja pasar). Nueva dependencia opcional `handoffRecovery`. |
| [src/application/human-handoff-recovery-service.ts](../src/application/human-handoff-recovery-service.ts) | `recover()` acepta `eventType`/`recoveryReasonCode` opcionales (default = comportamiento admin sin cambios). Nueva constante `HANDOFF_AUTO_RECOVERED_EVENT_TYPE` para no falsear el audit trail de una recuperación automática como si fuera manual. Chequeo de idempotencia reconoce ambos event types. |
| [src/app.ts](../src/app.ts) | **Una sola línea** (ver nota de aislamiento abajo): `handoffRecovery: humanHandoffRecoveryService` agregado al objeto de deps del webhook — la instancia ya existía, construida sin flag desde Fase 7E. |
| [tests/whatsapp-handoff-resilience-e2e.test.ts](../tests/whatsapp-handoff-resilience-e2e.test.ts) | Nuevo — 14 tests (los 10 obligatorios + 4 de robustez adicionales). |

**Archivos concurrentes NO tocados** (confirmado, `git status` al final): `src/app.ts` fuera de esa
única línea aislada, `src/domain/fiscal-calculator-lead-note.ts`, `tests/fiscal-calculator-note-parser.test.ts`,
`tests/web-leads-route.test.ts` — el trabajo fiscal V1.1 sigue exactamente como estaba.

**Nota de aislamiento en `src/app.ts`** (requerido explícitamente STOP-y-explicar antes de tocar
este archivo — ver el intercambio en el chat): se verificaron las 4 condiciones pedidas antes de
proceder — (1) el hunk es exclusivamente la inyección de `handoffRecovery`; (2) no se solapa ni
modifica ninguna línea del trabajo fiscal concurrente (ese hunk está ~150 líneas antes, en el
schema Zod del calculador); (3) se extrajo y validó como parche aislado
(`git apply --cached --check`), aplica limpio sin necesitar los hunks fiscales; (4) no requiere
stagear ninguna otra modificación preexistente. Confirmado por el usuario antes de continuar.

## E. Cancel During Handoff

Caso obligatorio (`lead.status = HUMAN_HANDOFF`, `appointment.status = BOOKED`, mensaje =
"Cancelar"):

1. `handleInboundWhatsAppText` detecta `isCancellationRequest(text)` y que `deps.cancellationHandler`
   está presente (flag `WHATSAPP_CANCELLATION_ENABLED` activo).
2. **Chequeo de sólo-lectura** (`appointments.listActiveByLeadId` + `isUpcomingBooked` — las MISMAS
   primitivas que ya usa `HumanHandoffRecoveryService`, nunca una regla divergente): confirma que
   existe exactamente 1 cita `BOOKED` real y futura. Si no la hay, el mensaje se trata como
   comercial libre (silencio, sin mutar nada) — ver sección M.
3. Sólo entonces se llama a `HumanHandoffRecoveryService.recover(leadId, now, HANDOFF_AUTO_RECOVERED_EVENT_TYPE, ...)`
   — el MISMO servicio del endpoint admin, calculando el MISMO destino seguro (`BOOKED`, porque la
   cita es futura). El lead sale de `HUMAN_HANDOFF` con una fila de auditoría real.
4. El turno **continúa cayendo** dentro del mismo `handleInboundWhatsAppText` (nunca retorna
   temprano) — ahora con `lead.status === "BOOKED"`, así que la rama de cancelación YA EXISTENTE
   (`deps.cancellationHandler`) lo reclama exactamente como lo haría para cualquier lead `BOOKED`
   normal: `WhatsAppCancellationHandler.handleIntentTurn` → transición a `CANCEL_PENDING` →
   pregunta de confirmación real.
5. El siguiente mensaje del lead ("1"/"sí") confirma, y `AppointmentCancellationService.cancel()`
   —sin ningún cambio— hace CAS `BOOKED→CANCELLED`, sincroniza Calendar, escribe el historial.

**Cero líneas nuevas en `WhatsAppCancellationHandler` ni en `AppointmentCancellationService`.**

## F. Reschedule During Handoff

El flujo real (`WhatsAppRescheduleHandler`) **ya existe completo** — no había ninguna pieza
faltante que implementar. El mismo mecanismo de recuperación-y-reingreso de la sección E aplica
igual: se detecta `isRescheduleRequest`, se verifica la cita viva, se recupera el lead a `BOOKED`,
y el turno cae en la rama `reschedule-intent` ya existente, que ofrece slots reales vía
`SlotOfferingService`/`GoogleCalendarProvider` sin cambios.

## G. Unknown Intent Behavior

Después de esta fase, un lead en `UNKNOWN_INTENT_HANDOFF`:
- **Ya no queda atrapado sin salida operativa**: un "Cancelar"/"Reagendar" posterior se procesa de
  inmediato, sin requerir que Héctor llame al endpoint admin (demostrado en TEST 5).
- Un mensaje comercial libre posterior **sigue silenciado** — esto es deliberado (ver sección C.3 y
  M): no existe infraestructura de timeout confiable en este codebase, y auto-recuperar en
  cualquier mensaje rompería la garantía de "bot pausado" que el propio brief pide en el Test 4.

## H. Explicit Handoff Behavior

Un lead escalado por una causa explícita (queja, solicitud de humano, contenido sensible, etc.)
tiene **exactamente el mismo comportamiento** que uno escalado por `UNKNOWN_INTENT_HANDOFF`: los
tres comandos críticos (cancelar/reagendar/opt-out) se procesan igual, el resto sigue silenciado
igual. Esto es intencional — el mecanismo no lee ni necesita saber la causa original del handoff
(sección C.5); un "Cancelar" real de un cliente no debería quedar bloqueado sólo porque la
escalación original fue por otro motivo. TEST 6 lo verifica explícitamente.

## I. Recovery Compatibility

`POST /api/leads/:id/recover-handoff` **no cambió su comportamiento observable**: mismos códigos
HTTP, mismo `eventType` (`HANDOFF_MANUALLY_RECOVERED`) en el audit trail para ese caller (los
nuevos parámetros de `recover()` tienen defaults que reproducen exactamente el comportamiento
anterior). Verificado en TEST 7 y en la suite completa de `human-handoff-recovery-endpoint.test.ts`
(14 tests, todos pasan sin modificación). Idempotencia verificada: el chequeo de "ya recuperado"
ahora reconoce ambos event types (`HANDOFF_MANUALLY_RECOVERED` y el nuevo
`HANDOFF_AUTO_RECOVERED_CRITICAL_COMMAND`) para que una retry desde cualquiera de los dos caminos
siga siendo un no-op seguro.

## J. Audit Trail

Cadena completa verificada end-to-end (TEST 10):

```
lead_status_history:  HUMAN_HANDOFF → BOOKED   (HANDOFF_AUTO_RECOVERED_CRITICAL_COMMAND)
                       BOOKED → CANCEL_PENDING  (CANCELLATION_REQUESTED)
                       CANCEL_PENDING → CANCELLED (APPOINTMENT_CANCELLED)
appointment_status_history: BOOKED → CANCELLED  (APPOINTMENT_CANCELLED)
```

`HANDOFF_AUTO_RECOVERED_CRITICAL_COMMAND` es deliberadamente un event type **distinto** de
`HANDOFF_MANUALLY_RECOVERED` — para no falsear el historial haciendo parecer que un admin intervino
cuando en realidad fue automático, disparado por el propio mensaje del lead. Cero pérdida de
trazabilidad; cero vocabulario de eventos reutilizado incorrectamente.

## K. Tests

Archivo nuevo: `tests/whatsapp-handoff-resilience-e2e.test.ts`, 14 tests, todos vía el pipeline
real del webhook (`app.inject`), no mocks internos:

| # | Caso | Resultado |
|---|---|---|
| 1 | BOOKED normal + "Cancelar" | ✅ flujo real de cancelación (baseline) |
| 2 | HUMAN_HANDOFF + "Cancelar" | ✅ auto-recupera y cancela, sin recover-handoff previo |
| 3 | HUMAN_HANDOFF + "Reagendar" | ✅ entra al flujo real de reprogramación |
| 4 | HUMAN_HANDOFF + mensaje comercial libre | ✅ bot permanece pausado, cero respuesta |
| 5 | UNKNOWN_INTENT_HANDOFF real (vía escalateUnknownIntent) + "cancelar" después | ✅ no bloqueo permanente |
| 6 | Handoff "explícito" (simulado) + mensaje comercial | ✅ mismo comportamiento que TEST 4 |
| 7 | `POST /recover-handoff` | ✅ sigue funcionando, event type sin cambios |
| 8 | wamid duplicado sobre un comando crítico | ✅ dedupe correcto, una sola recuperación |
| 9 | Cancelación durante handoff | ✅ Calendar sigue sincronizando (slot liberado) |
| 10 | Cadena completa de status history | ✅ 3 transiciones, event types correctos |
| — | Flag-off (cancelación/reagenda desactivadas) | ✅ comportamiento anterior, byte-a-byte |
| — | Sin cita viva que cancelar | ✅ status nunca mutado, sigue suprimido |
| — | DO_NOT_CONTACT + "cancelar" | ✅ opt-out sigue siendo final, nunca bypaseado |
| — | HUMAN_HANDOFF + "STOP" | ✅ opt-out honrado, transición a DO_NOT_CONTACT |

## L. Regression Results

- **Test suite completa**: `145 test files passed (145)`, `1863 tests passed (1863)` — 0 fallos, 0
  skips. (Antes de esta fase: 144 archivos / 1849 tests — la diferencia es exactamente el archivo
  nuevo de esta fase.)
- **Typecheck** (`tsc --noEmit`): exit 0, sin errores.
- **Build** (`tsc -p tsconfig.json`): exit 0, sin errores.

## M. Risks

- **UNKNOWN_INTENT_HANDOFF sin comando crítico sigue sin timeout.** Un lead que después de
  `UNKNOWN_INTENT_HANDOFF` sólo manda mensajes comerciales (nunca cancelar/reagendar/stop) queda
  igual de congelado que antes — su única salida sigue siendo el endpoint admin. Esto es una
  decisión deliberada (sección C.4), no un descuido: implementar auto-recovery genérico requeriría
  o bien inventar infraestructura de timeout que este codebase no tiene, o bien debilitar la
  garantía de "bot comercial pausado" que el propio Test 4 exige. Recomendación: si Héctor quiere
  cerrar también este caso, es una decisión de producto explícita para una fase futura (ver
  sección N y el "Principio final" del brief).
- **Ventana de carrera, ya documentada y ya cubierta.** Dos mensajes idénticos casi simultáneos
  (mismo `wamid`, real redelivery de Meta) están cubiertos por dedupe (TEST 8). Un caso *distinto*
  wamid pero llegando en la misma fracción de segundo entre el chequeo de sólo-lectura y la llamada
  a `recover()` es teóricamente posible pero de probabilidad extremadamente baja en este volumen
  (un solo asesor); si ocurriera, `recover()` computa el destino real desde los datos en ese
  instante — nunca corrompe el estado, en el peor caso el mensaje se trata como comercial
  suprimido.
- **No se corrigió el defecto de diseño de fondo** (handoff sin timeout como concepto). Por
  instrucción explícita del brief, eso queda para una fase separada de "Handoff Resilience" de
  segundo nivel, si Héctor la solicita.

## N. Rollback

Revertir es trivial y de bajo riesgo — 3 archivos de producción, cambios aditivos y acotados:

```bash
git checkout -- src/application/whatsapp-inbound-service.ts src/application/human-handoff-recovery-service.ts
# revertir sólo la línea de app.ts (no todo el archivo, que tiene trabajo fiscal concurrente):
# restaurar manualmente `handoffAlertService },` sin `, handoffRecovery: humanHandoffRecoveryService`
```

Ningún dato ya escrito (recuperaciones/cancelaciones ya ejecutadas) necesita revertirse — son
transiciones de estado reales y correctas, no artefactos de un bug.

## O. Exact Next Action

Ninguna acción pendiente de Héctor para que esto funcione — ya está activo en cuanto se despliegue
(no requiere flag nuevo; reutiliza `WHATSAPP_CANCELLATION_ENABLED`/`WHATSAPP_RESCHEDULE_ENABLED`,
que según la Fase 2.2.2A ya deben estar activos en producción para que la cancelación por WhatsApp
funcione en general). **Pendiente exclusivamente de Héctor**: confirmar si autoriza el commit
aislado (ver nota de la sección D) y, después, el push/despliegue — siguiendo el mismo patrón de
confirmación explícita usado en Fase 2.2.1.
