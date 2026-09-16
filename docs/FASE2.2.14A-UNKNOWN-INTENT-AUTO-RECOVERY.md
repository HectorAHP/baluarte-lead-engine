# Fase 2.2.14A — UNKNOWN_INTENT_HANDOFF Auto-Recovery (implementación)

Implementa la política aprobada en `docs/FASE2.2.14-UNKNOWN-INTENT-HANDOFF-POLICY.md`, origen: el
FAIL bloqueante de Fase 2.2.13 (lead `47dd9804-...` reproducido en producción real, `BOOKING_PENDING`
→ `HUMAN_HANDOFF` vía `UNKNOWN_INTENT_HANDOFF`, sin comando crítico ni cita `BOOKED` que lo
recuperara).

## A. Comportamiento actual (antes de este cambio)

`UNKNOWN_INTENT_HANDOFF` era indistinguible, para efectos de recuperación, de cualquier otra causa
de `HUMAN_HANDOFF`: el lead quedaba suspendido para siempre, salvo (1) `recover-handoff` manual vía
admin, o (2) un comando crítico (Cancelar/Reagendar) — y sólo si además existía una cita `BOOKED`
viva (precondición de solo-lectura ya existente, Fase 2.2.3). Un lead en `BOOKING_PENDING` sin cita
confirmada, como el caso real, no tenía ninguna salida automática.

## B. Problema raíz

`UNKNOWN_INTENT_HANDOFF` es, por diseño, una escalada legítima (la decisión de escalar en sí misma
no se toca — ver la Sección B del documento de política) pero su CONSECUENCIA (permanencia
indefinida) trataba una "no entendí este mensaje" exactamente igual que una queja explícita, una
solicitud humana, o una inconsistencia real de datos — casos que sí ameritan detención dura.

## C. Política implementada

> `UNKNOWN_INTENT_HANDOFF` deja de ser permanente por defecto. En el SIGUIENTE mensaje entrante de
> ese lead, si la transición MÁS RECIENTE hacia `HUMAN_HANDOFF` fue por `UNKNOWN_INTENT_HANDOFF`,
> el lead se recupera automáticamente (mismo `HumanHandoffRecoveryService`, misma política de
> destino que ya usan el endpoint admin y el bypass de comandos críticos de Fase 2.2.3) y ESE MISMO
> mensaje se procesa a continuación por el router normal, según el status recuperado. Si ese mensaje
> tampoco encaja en ningún flujo reconocido, el mecanismo de escalada de ese status (sin cambios)
> puede volver a escalar — un episodio nuevo, genuino, auditado, nunca una congelación silenciosa ni
> un loop.

Cualquier otra causa de `HUMAN_HANDOFF` (queja, solicitud explícita de humano, contenido sensible,
inconsistencia real de datos) sigue siendo un stop duro, sin cambio.

## D. Regla de detección

Basada EXCLUSIVAMENTE en la transición MÁS RECIENTE hacia `HUMAN_HANDOFF` en `lead_status_history`
— nunca en "¿alguna vez hubo un `UNKNOWN_INTENT_HANDOFF` en el pasado?". Implementada en
[`HumanHandoffRecoveryService.isUnknownIntentEscalation`](../src/application/human-handoff-recovery-service.ts:204):

```ts
async isUnknownIntentEscalation(leadId: string): Promise<boolean> {
  const history = await this.deps.leadStatusHistory.listByLeadId(leadId);
  const lastHandoffEntry = [...history].reverse().find((entry) => entry.toStatus === "HUMAN_HANDOFF");
  return lastHandoffEntry?.eventType === "UNKNOWN_INTENT_HANDOFF";
}
```

Sin historial (fixture de test que fija el status directamente) → `false`, el default seguro. El
"caso obligatorio" del brief — `UNKNOWN_INTENT_HANDOFF` histórico, pero la transición ACTUAL hacia
`HUMAN_HANDOFF` es explícita — está cubierto porque sólo se mira la última entrada con
`toStatus === "HUMAN_HANDOFF"` (TEST 6, ver Sección J).

## E. Continuación del mismo mensaje

En [`whatsapp-inbound-service.ts`](../src/application/whatsapp-inbound-service.ts:521), dentro del
mismo bloque `wasAlreadySuppressed` de Fase 2.2.3, se agregó una rama `else if` ENTRE el bypass de
comando crítico y el `else` de supresión final:

```ts
} else if (deps.handoffRecovery && await deps.handoffRecovery.isUnknownIntentEscalation(leadId)) {
  const recovery = await deps.handoffRecovery.recover(
    leadId, new Date(), HANDOFF_AUTO_RECOVERED_UNKNOWN_INTENT_EVENT_TYPE, HANDOFF_AUTO_RECOVERED_UNKNOWN_INTENT_REASON_CODE,
  );
  if (recovery.outcome === "RECOVERED") {
    lead = recovery.lead;
    // Deliberadamente SIN return -- cae al mismo processing boundary/router de siempre.
  } else {
    return { outcome: "PROCESSED", leadId, conversationId }; // NOT_ELIGIBLE/AMBIGUOUS/NOT_FOUND -- sigue suspendido
  }
}
```

Sin `return` tras una recuperación exitosa: el turno sigue, con `lead.status` ya actualizado, hacia
el MISMO processing boundary que usa cualquier lead no suspendido — nunca una segunda ingesta del
mensaje (ver TEST 8), nunca una re-entrada de esta función.

## F. Protección del handoff explícito

`isUnknownIntentEscalation` devuelve `false` para CUALQUIER otra causa (default seguro), así que la
rama nueva simplemente no se activa — el `else` final de supresión (sin cambio de comportamiento,
sólo se reescribió el string del log) sigue capturando esos casos exactamente como antes. TEST 3 y
TEST 6 lo verifican explícitamente, incluyendo el caso donde hubo un `UNKNOWN_INTENT_HANDOFF`
histórico pero el episodio actual es explícito.

## G. Precedencia de comandos críticos

La rama nueva es un `else if` que sólo se evalúa cuando NINGUNA de las condiciones anteriores
(opt-out, comando crítico + cita viva) fue verdadera — el bypass de Fase 2.2.3 no fue tocado ni
reordenado. TEST 4 y TEST 5 prueban explícitamente que "Cancelar"/"Reagendar" durante un
`UNKNOWN_INTENT_HANDOFF` siguen resolviéndose por el mecanismo VIEJO
(`HANDOFF_AUTO_RECOVERED_CRITICAL_COMMAND`), nunca por el nuevo.

## H. Audit trail

Nueva pareja evento/motivo, en su propio namespace, nunca reutilizando las otras dos:

| Caller | eventType | reasonCode |
|---|---|---|
| Admin `recover-handoff` (Fase 7E) | `HANDOFF_MANUALLY_RECOVERED` | `ADMIN_VERIFIED_HANDOFF_RESOLVED` |
| Comando crítico + cita viva (Fase 2.2.3) | `HANDOFF_AUTO_RECOVERED_CRITICAL_COMMAND` | `AUTOMATIC_CRITICAL_COMMAND_DURING_HANDOFF` |
| **Unknown-intent (Fase 2.2.14A, nuevo)** | **`UNKNOWN_INTENT_AUTO_RECOVERY`** | **`AUTOMATIC_UNKNOWN_INTENT_NOT_PERMANENT`** |

Registrado vía el mismo `recordLeadStatusTransition` choke point que usan los otros dos — una sola
fila en `lead_status_history` por recuperación, `metadata: {recoveryReasonCode, previousStatus,
resolvedAppointmentState}`, nunca PII. Permite medir directamente: leads que entraron por
`UNKNOWN_INTENT_HANDOFF`, cuántos se auto-recuperaron (`UNKNOWN_INTENT_AUTO_RECOVERY`), y cuántos
volvieron a escalar (una segunda fila `UNKNOWN_INTENT_HANDOFF` para el mismo lead). TEST 7 lo
verifica explícitamente.

## I. Archivos modificados

Únicamente 2 archivos de código, ninguno más:

- [`src/application/human-handoff-recovery-service.ts`](../src/application/human-handoff-recovery-service.ts) —
  2 constantes nuevas, 1 método nuevo (`isUnknownIntentEscalation`), y la extensión del check de
  idempotencia `ALREADY_RECOVERED` para reconocer el nuevo eventType. Cero cambios a dependencias
  del constructor (reutiliza `leadStatusHistory`, ya presente).
- [`src/application/whatsapp-inbound-service.ts`](../src/application/whatsapp-inbound-service.ts) —
  import extendido, tipo de `deps.handoffRecovery` extendido (un método más en su interfaz
  angosta), y una rama `else if` nueva insertada entre el bypass crítico y la supresión final.

**`src/app.ts` no fue tocado** — `handoffRecovery` ya inyectaba la MISMA instancia de
`HumanHandoffRecoveryService` desde Fase 2.2.3; el método nuevo no requiere wiring adicional.

3 archivos de test existentes, actualizados (ver Sección J y K):
[`tests/whatsapp-handoff-resilience-e2e.test.ts`](../tests/whatsapp-handoff-resilience-e2e.test.ts) (10 tests nuevos),
[`tests/whatsapp-booking-pending-conversational-trap.test.ts`](../tests/whatsapp-booking-pending-conversational-trap.test.ts) (1 test actualizado),
[`tests/whatsapp-past-booked-unknown-intent-handoff-e2e.test.ts`](../tests/whatsapp-past-booked-unknown-intent-handoff-e2e.test.ts) (1 test actualizado).

Trabajo fiscal concurrente (`src/app.ts` -- confirmado sin tocar --, `src/domain/fiscal-calculator-lead-note.ts`,
`tests/fiscal-calculator-note-parser.test.ts`, `tests/web-leads-route.test.ts`) **sin tocar**,
verificado con `git status` antes y después.

## J. Tests (los 10 obligatorios)

Todos en `tests/whatsapp-handoff-resilience-e2e.test.ts`, describe block nuevo
`"Fase 2.2.14A -- Unknown Intent Auto-Recovery"`:

| # | Caso | Resultado |
|---|---|---|
| 1 | Mensaje siguiente reconocido → auto-recupera y responde ESE mismo mensaje | ✅ |
| 2 | Mensaje siguiente también desconocido → recupera, enruta, re-escala — sin loop | ✅ |
| 3 | `EXPLICIT_HUMAN_HANDOFF` + mensaje normal → sin auto-recuperación | ✅ |
| 4 | `UNKNOWN_INTENT_HANDOFF` + "Cancelar" → conserva el bypass crítico VIEJO | ✅ |
| 5 | `UNKNOWN_INTENT_HANDOFF` + "Reagendar" → conserva el bypass crítico VIEJO | ✅ |
| 6 | "Caso obligatorio": histórico `UNKNOWN_INTENT_HANDOFF`, episodio actual explícito → sin auto-recuperación | ✅ |
| 7 | Audit trail registra `UNKNOWN_INTENT_AUTO_RECOVERY` inequívoco, distinguible de los otros 2 | ✅ |
| 8 | El mensaje que dispara la recuperación se procesa exactamente una vez | ✅ |
| 9 | Dedupe por `wamid` sigue funcionando bajo la rama nueva | ✅ |
| 10 | `recover-handoff` admin sigue funcionando para un lead cuyo origen fue `UNKNOWN_INTENT_HANDOFF` | ✅ |

**10/10 passed**, más los 14 tests preexistentes de Fase 2.2.3 en el mismo archivo, sin
modificación — **24/24 en el archivo**.

Nota de implementación (no de comportamiento): `escalateToHuman` marca la conversación como
`HUMAN_HANDOFF`, así que el siguiente mensaje del lead crea una conversación nueva (comportamiento
preexistente del router, ajeno a esta fase) — los tests que necesitan ver la respuesta del turno
recuperado agregan un helper de test (`allOutboundMessagesForLead`) que agrupa mensajes de TODAS las
conversaciones de un lead, en vez de asumir una sola `conversation.id` fija.

## K. Regresión

- Archivo dirigido (`whatsapp-handoff-resilience-e2e.test.ts`): **24/24** ✅
- Typecheck (`tsc --noEmit`): exit 0 ✅ (2 veces: tras el código, y de nuevo tras los tests)
- Build (`tsc -p tsconfig.json`): exit 0 ✅
- Suite dirigida WhatsApp/booking/handoff/cancelación/reagendado (63 archivos): **850/850** ✅,
  después de corregir 2 regresiones reales encontradas (ver abajo)
- Suite completa: **146 archivos, 1888/1888** ✅, sin flakes en esta corrida

**2 regresiones reales encontradas y corregidas** (no un "unrelated flake" — consecuencia directa e
intencional del cambio de política, en archivos fuera del alcance original de esta fase):
- `tests/whatsapp-booking-pending-conversational-trap.test.ts`, test 11 — afirmaba textualmente
  "a further message stays silent -- terminal suppression, never a repeated escalation or a second
  message" para un lead escalado por `UNKNOWN_INTENT_HANDOFF`. Esa es exactamente la conducta que
  esta fase cambia a propósito. Actualizado para afirmar la conducta nueva (auto-recupera, deja de
  estar en `HUMAN_HANDOFF`, el audit trail registra `UNKNOWN_INTENT_AUTO_RECOVERY`) — no se borró
  cobertura, se actualizó la expectativa.
- `tests/whatsapp-past-booked-unknown-intent-handoff-e2e.test.ts`, test 10 — mismo patrón, para un
  lead con cita pasada (recupera a `BOOKING_PENDING`, Caso B). Se conservó la aserción "sin segunda
  alerta" (`messaging.sentTemplates` sigue en 1) porque el mensaje de seguimiento SÍ es entendido
  por el flujo `BOOKING_PENDING` recuperado y no vuelve a escalar en este caso concreto.

Ninguna otra prueba de la suite completa cambió de resultado.

## L. Riesgos

- Mismo riesgo residual ya documentado en la Sección G de la política (Fase 2.2.14): un lead con
  escaladas `UNKNOWN_INTENT_HANDOFF` repetidas genera más filas de auditoría y, si las alertas al
  asesor están activas, una alerta nueva por cada episodio genuinamente distinto (nunca duplicada
  dentro del mismo episodio, gracias a `isGenuineNewEscalation`, sin cambios). Es el trade-off
  consciente y ya aceptado de "nunca permanente" vs. "silencio total".
- Dos tests preexistentes, en archivos fuera del alcance nominal de esta fase, codificaban la
  conducta VIEJA como si fuera la correcta — actualizados aquí (Sección K). No se descarta que
  exista alguna otra prueba, fuera de la suite dirigida, con la misma suposición implícita; la
  corrida de suite completa (146/146 archivos) no encontró ninguna otra.

## M. Rollback

Revertir el commit aislado de esta fase (los 2 archivos de código + los 3 archivos de test) deja el
codebase exactamente en el estado de Fase 2.2.3: comando crítico + cita viva sigue recuperando,
`UNKNOWN_INTENT_HANDOFF` vuelve a ser permanente. Cero migraciones que revertir — ninguna se hizo.

## N. Exact Next Action

1. Revisar y aprobar este reporte.
2. Commit aislado local (2 archivos de código + 3 archivos de test), staging explícito, sin
   `git add .`, sin tocar el trabajo fiscal concurrente — **sin push, sin deploy**, tal como se
   pidió.
3. Pendiente, independiente de esta fase: tu confirmación de que ya ejecutaste el `recover-handoff`
   manual del lead `47dd9804-...` para cerrar el FAIL bloqueante de Fase 2.2.13 — esa fase permanece
   en pausa hasta entonces.
4. Una vez aprobado este cambio Y confirmado el recover-handoff manual: autorización aparte para
   desplegarlo a producción (mismo patrón de rama de release aislada ya usado en fases anteriores),
   y sólo entonces ejecutar el "Golden Test Post-Deploy" (reenviar "Hola, quiero revisar mi
   resultado." desde tu WhatsApp real y confirmar que el lead ya no queda congelado).

## Veredicto: **READY_FOR_RELEASE**

Los 10 tests obligatorios pasan, la regresión dirigida (850/850) y la suite completa (1888/1888)
pasan sin flakes, typecheck y build limpios, cambio mínimo y aislado (2 archivos de código, cero
migraciones, cero dependencias nuevas, `app.ts` sin tocar), y las 2 regresiones reales encontradas
fueron corregidas de forma transparente (documentadas arriba, no ocultadas). Pendiente
exclusivamente de tu aprobación para el commit y de tu confirmación del `recover-handoff` manual del
lead `47dd9804-...` antes de retomar Fase 2.2.13.
