# FASE 7J — Unknown Intent → Human Handoff (auditoría + intento de implementación, revertido)

## 1. Resumen ejecutivo

Se intentó implementar el fallback final del router (`whatsapp-inbound-service.ts`) para que
**ningún** mensaje termine en silencio (`willReply:false`) cuando no coincide con ningún
intent/flujo soportado. La implementación inicial (commit no pusheado, revertido en esta misma
rama) rompió **20 tests en 10 archivos** de la suite completa (de 128 archivos/1548 tests en verde
a 115/1523, con 13 archivos/25 tests fallando tras incluir el nuevo archivo de tests). Se
diagnosticó la causa raíz, se revirtió la parte que causaba la regresión, y se documenta aquí el
conflicto estructural encontrado para que Héctor decida cómo proceder — **no se forzó ningún
cambio que rompiera un contrato de test ya existente.**

## 2. Auditoría del orden de routing (`whatsapp-inbound-service.ts`, ítem 1 del spec)

Orden real, de arriba a abajo, dentro de `handleInboundWhatsAppText`:

1. duplicate-check (idempotencia por `provider_message_id`)
2. resolución de lead/conversación
3. verificación pasiva de teléfono
4. `wasAlreadySuppressed` → return temprano si `DO_NOT_CONTACT` o `HUMAN_HANDOFF` (terminal)
5. opt-out
6. contenido sensible de salud → handoff (mecanismo ya existente, copy propio)
7. `wasNew` → mensaje de bienvenida
8. bridging de contexto fiscal (varias sub-ramas: menú de bienvenida fiscal, dígito, texto libre)
9. `QUALIFYING` → `qualificationHandler.handleTurn` (switch exhaustivo propio, siempre responde)
10. `CONTACTED` + sin `productInterest` → recuperación de qualification
11. `QUALIFIED_A` / `QUALIFIED_B` / `NURTURE_C` → router de intents propio (switch exhaustivo,
    **siempre responde**, nunca llega al fallback final)
12. `BOOKING_PENDING` → `bookingHandler.handleTurn` (dispatch incondicional)
13. `RESCHEDULE_REQUESTED` → `rescheduleHandler.handleTurn` (dispatch incondicional)
14. `BOOKED` con cita pasada/stale → recuperación
15. `BOOKED` con confirmación de cita pendiente
16. `BOOKED` + intención explícita de reagendar
17. `BOOKED` + reagenda contextual (Fase 7I.2)
18. `BOOKED` + fallback genérico ("ya tienes una cita...")
19. `cancellationHandler` dispatch (`BOOKED` / `CANCEL_PENDING`)
20. `CANCELLED` + reactivación
21. **fallback final** — antes de esta fase, silencioso incondicional (`logBranch("no-match",
    false)`, cero mensajes salientes)

## 3. Hallazgo estructural (por qué el fallback final no puede escalar de forma segura hoy)

Cada rama 9–20 que **sí** tiene su handler inyectado (flag activo) hace *dispatch incondicional*:
llama a `handleTurn`/`beginQualification` y hace `return` inmediatamente, sin mirar si el handler
"realmente" respondió algo útil. Por construcción, esto significa que **la única forma de llegar
al fallback final es que el handler relevante para ese `lead.status` esté ausente** (flag
apagado), o — caso `CONTACTED` — que deliberadamente no haya flujo activo todavía (p. ej. ya tiene
`productInterest`, así que la rama de recuperación ni se evalúa).

En otras palabras: **"llegó al fallback final" es, en el router actual, indistinguible de "la
funcionalidad para este estado está apagada".** No existe hoy una señal para diferenciar "un flujo
activo no supo qué hacer con esto" de "no hay ningún flujo activo para este lead ahora mismo".

Esto se confirmó empíricamente al implementar la versión inicial de la escalada incondicional
(`if (!canTransition(status,"HUMAN_HANDOFF")) return; else escalate`) y correr la suite completa:
**toda** regresión encontrada fue exactamente este caso — un lead cuyo status permite la
transición a `HUMAN_HANDOFF` en el state machine, pero cuyo silencio (o respuesta genérica) era
intencional y ya estaba protegido por un test de "flag off → comportamiento histórico byte a
byte":

| Test | Escenario | Contrato roto |
|---|---|---|
| `whatsapp-qualification-e2e.test.ts` | `CONTACTED`, flag de qualification off, o `productInterest` ya presente | debe quedar en silencio |
| `whatsapp-reactivation-e2e.test.ts` | `CANCELLED`, `WHATSAPP_BOOKING_ENABLED` off | debe quedar en silencio |
| `whatsapp-fiscal-welcome-menu.test.ts` | `CONTACTED` recuperado tras respuesta del asesor | debe responder con la respuesta fiscal normal, no escalar |
| `whatsapp-booking-e2e.test.ts` | `qualification=false, booking=true`, nuevo lead que nunca califica | debe quedar `CONTACTED`, sin escalar |

## 4. Hallazgo adicional: los casos B/BOOKED y BOOKING_PENDING (ítems 11/12 del spec) también
   entran en conflicto directo con hardening previo

A diferencia del fallback final, las ramas `BOOKED`-genérico y `BOOKING_PENDING`-`INVALID` **nunca
fueron silenciosas** — siempre mandaban una respuesta (el mensaje genérico "ya tienes una cita" o
el recordatorio de slots). El spec pide clasificar esos casos en A) relacionado-sin-acción (deja
la respuesta genérica) vs B) contenido no soportado (escala a `HUMAN_HANDOFF`). Se implementó una
heurística estructural (sin keywords: ¿hay `DatePreference` o selección numérica?) para distinguir
A de B — y **se probó contra la suite completa, no solo contra los ejemplos del spec.**

Resultado: rompe igualmente tests de hardening previos, ya nombrados como tales en el propio
código (`"Pre-launch hardening"`):

| Test | Texto de entrada | Contrato roto |
|---|---|---|
| `whatsapp-booked-generic-fallback-e2e.test.ts` (A) | "Hola, quiero información" | debe recibir el genérico, no escalar |
| `whatsapp-booked-transactional-intent-priority.test.ts` (G) | "Hola tengo una duda" | debe recibir el genérico, no escalar |
| `whatsapp-past-booked-rebook-fix.test.ts` (3) | flag off, cualquier texto | debe recibir el genérico, no escalar |
| `whatsapp-past-booked-recovery-e2e.test.ts` (flag-off) | ídem | ídem |
| `whatsapp-cancellation-e2e.test.ts` | intención de cancelar con `WHATSAPP_CANCELLATION_ENABLED` off | debe quedar `BOOKED`, sin escalar |
| `whatsapp-booking-pending-conversational-trap.test.ts` (4) | "¿Cuáles son los servicios?" | debe quedar `BOOKING_PENDING` con el recordatorio de slots, no escalar |
| `whatsapp-booking-pending-conversational-trap.test.ts` (6) | **"asdkjfh qlwkejr" (gibberish literal)** | debe quedar `BOOKING_PENDING` con el recordatorio, no escalar |

El último caso es el más importante: el propio spec (ítem 2) da **"asdf quiero saber algo raro"**
como ejemplo canónico de mensaje que SÍ debería escalar. El test 6, ya existente y nombrado
explícitamente `"recoverable fallback, no dangerous mutation"`, exige literalmente lo contrario
para un input de la misma naturaleza (`"asdkjfh qlwkejr"`). **Esto no es un bug de mi heurística —
es una contradicción directa entre lo que pide el spec de esta fase y un contrato de test ya
aprobado y nombrado como hardening de una fase anterior.**

## 5. Qué se revirtió (y por qué)

Se revirtió, exactamente, a comportamiento previo byte-a-byte:
- `whatsapp-inbound-service.ts`: fallback final vuelve a `logBranch("no-match", false)` sin
  ninguna escalada (comentario actualizado para documentar el hallazgo del §3, sin cambio de
  comportamiento).
- `whatsapp-inbound-service.ts`: la rama `BOOKED`-genérico vuelve a responder incondicionalmente
  `BOOKED_GENERIC_INBOUND_MESSAGE` (sin la clasificación A/B).
- `whatsapp-booking-handler.ts`: la rama `BOOKING_PENDING` + `selection.type === "INVALID"` vuelve
  a responder incondicionalmente con `buildBookingPendingFallbackMessage(...)` (sin clasificación
  ni escalada).

Verificado: suite completa en verde, **129 archivos / 1576 tests** (128/1548 original + el nuevo
archivo de 28 tests de `isSocialAcknowledgement`, cero regresiones), `npm run typecheck` y
`npm run build` limpios.

## 6. Qué SÍ queda entregado de esta fase (seguro, inerte, reutilizable)

- `src/domain/social-acknowledgement-detection.ts` + `tests/social-acknowledgement-detection.test.ts`
  (28 tests) — detector determinista de acuses sociales triviales ("gracias", "ok", "👍", ...),
  exact-match, nunca substring. No usado todavía en ninguna rama del router (ver §5), disponible
  para cuando se resuelva el conflicto del §4.
- `UNKNOWN_INTENT_HANDOFF_MESSAGE` en `message-templates.ts` — copy exacto pedido en el spec
  (ítem 8), sin "no te entendí"/"error"/lenguaje técnico/promesas de SLA. Sin uso todavía.
- `LeadService.requestHumanHandoff(id, eventType = "HUMAN_HANDOFF_REQUESTED")` — segundo parámetro
  opcional, **retrocompatible** (todo call site existente sigue igual). Permite registrar
  `"UNKNOWN_INTENT_HANDOFF"` como causa distinta en `lead_status_history` el día que se implemente
  la escalada real, sin crear un mecanismo paralelo a `escalateToHuman`/`requestHumanHandoff`.

## 7. Auditoría del ítem 16 del spec — mecanismo de notificación interna (CRÍTICO)

Búsqueda exhaustiva en `src/` de: `slack`, `sendgrid`, `nodemailer`, `smtp`, `notify(`,
`notification`. **Cero resultados** relevantes (el único hit es un comentario sobre verificación
de dominio de email por MX/A/AAAA, no relacionado).

**Confirmado: hoy no existe ningún mecanismo — dashboard, HubSpot, Slack, email, WhatsApp interno —
para que Héctor se entere de que ocurrió un `HUMAN_HANDOFF`.** La única señal es el estado en base
de datos (`leads.status = 'HUMAN_HANDOFF'`, `conversations.status`, la fila nueva en
`lead_status_history`). Esto ya era cierto ANTES de esta fase (afecta a todo handoff existente:
salud sensible, `MAX_ROUNDS_REACHED`, inconsistencias de booking) — Fase 7J no lo crea, pero lo
hace más relevante: automatizar más escaladas sin un mecanismo de aviso real solo mueve el
problema de "silencio total" a "silencio con una fila en la base de datos que nadie mira". Per el
alcance de esta fase, **no se implementó ninguna integración nueva** — solo se reporta el hallazgo.

## 8. Recomendación (decisión de producto, no técnica)

Para completar el objetivo real de esta fase de forma segura hace falta una de estas dos rutas —
ninguna se tomó unilateralmente aquí:

**Opción A — relajar los contratos de test listados en §3/§4.** Cambiar explícitamente el
comportamiento esperado en esos escenarios (p. ej.: gibberish en `BOOKING_PENDING` SÍ debe
escalar tras N intentos; "Hola tengo una duda" en `BOOKED` SÍ debe escalar en vez de dar el
genérico). Esto es un cambio de producto real — esos tests llevan nombres de hardening de
incidentes previos y decidir relajarlos no es una decisión que deba tomar unilateralmente.

**Opción B — rediseño más profundo:** que cada handler (`WhatsAppBookingHandler`,
`WhatsAppCancellationHandler`, `WhatsAppReactivationHandler`, etc.) devuelva una señal explícita
("clasifiqué esto y no encaja en nada" vs "no estoy activo para este lead ahora") en vez de
`void`, para que el router pueda distinguir con certeza los dos casos que hoy son indistinguibles
(§3). Esto es un cambio de alcance mayor al de "solo tocar el fallback final", y toca varios
archivos que el spec de esta fase pidió explícitamente NO tocar (ítem 19).

Sin una de estas dos decisiones explícitas, cualquier implementación de la escalada real
necesariamente rompe tests de hardening ya aprobados — por eso se revirtió en vez de forzarla.

## 9. Validación final

- `npm run typecheck` — limpio.
- `npm run build` — limpio.
- `npx vitest run` — **129 archivos / 1576 tests, 0 fallos** (verificado dos veces, la segunda
  tras el ajuste final de un comentario).
- `npm audit --production` — 4 vulnerabilidades moderadas preexistentes, no relacionadas con esta
  fase (`uuid` vía `googleapis`/`gaxios`/`googleapis-common`; el fix requiere un upgrade breaking
  de `googleapis` — fuera de alcance, no aplicado).

**NO tocar producción.**
