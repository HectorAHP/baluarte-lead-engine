# FASE 7J.2 — Alerta operativa de HUMAN_HANDOFF a Héctor

## 1. El flujo completo

```
UNKNOWN_INTENT (mensaje que Lía no puede resolver)
  -> lead.status = HUMAN_HANDOFF, conversation.status = HUMAN_HANDOFF (Fase 7J/7J.1, sin cambios)
  -> Lía responde UNKNOWN_INTENT_HANDOFF_MESSAGE al lead (sin cambios)
  -> intento de alerta a Héctor (NUEVO, esta fase): WhatsApp template "handoff_asesor" a
     HUMAN_HANDOFF_ADVISOR_PHONE, con nombre/contacto/motivo fijo/hora -- NUNCA el texto original
  -> si el envío tiene éxito: Héctor recibe el WhatsApp de inmediato
  -> si el envío falla: se registra human_handoff_alert_failed (observable en logs), el
     handoff NO se revierte, Lía sigue suprimida igual
  -> automatización suprimida para ese lead (wasAlreadySuppressed, sin cambios de Fase 7J/7J.1) --
     ningún mensaje posterior del lead recibe respuesta automática ni genera una segunda alerta
  -> Héctor responde manualmente por WhatsApp (fuera de este sistema) cuando ve el aviso -- o, si
     no lo vio (falló el envío, o HUMAN_HANDOFF_ALERTS_ENABLED sigue en false), cuando revise
     Supabase/logs (ver docs/security/FASE7J1-BOOKED-HANDOFF-AND-NOTIFICATION.md §9)
```

**Alcance de esta fase**: la alerta solo se dispara para `UNKNOWN_INTENT_HANDOFF` (ambos call
sites: `BOOKED` vía `escalateUnknownIntent`, `BOOKING_PENDING` vía `escalateToHuman`). Ningún otro
motivo de handoff existente (`BOOKING_INCONSISTENCY_HANDOFF`, `MAX_ROUNDS_REACHED`,
`RESCHEDULE_APPOINTMENT_INCONSISTENCY`, etc.) dispara una alerta todavía -- ver §11 más abajo.

## 2. Punto de integración exacto

- [whatsapp-inbound-service.ts](../../src/application/whatsapp-inbound-service.ts)'s
  `escalateUnknownIntent` (rama `BOOKED`-genérico, Fase 7J.1): la alerta se dispara AL FINAL de
  esta función, después de que `leadService.requestHumanHandoff` y `sendAndPersistReply` ya
  completaron -- nunca antes.
- [booking-outcome-dispatch.ts](../../src/application/booking-outcome-dispatch.ts)'s
  `escalateToHuman` (rama `BOOKING_PENDING`-genérico, Fase 7J): la alerta se dispara al final,
  condicionada a `eventType === "UNKNOWN_INTENT_HANDOFF"` Y a que la transición haya sido
  GENUINAMENTE nueva (`isGenuineNewEscalation`) -- una llamada redundante sobre un lead que YA
  estaba en `HUMAN_HANDOFF` nunca re-alerta.

Ninguna alerta se dispara desde un fallback genérico arbitrario -- ambos puntos son,
específicamente, el momento en que la transición a `HUMAN_HANDOFF` por esta causa ya quedó
confirmada.

## 3. Envs nuevas

| Variable | Default | Requerida cuando |
|---|---|---|
| `HUMAN_HANDOFF_ALERTS_ENABLED` | `false` | Nunca -- flag maestro. `false` = comportamiento byte-a-byte igual a Fase 7J/7J.1, sin ningún intento de alerta. |
| `HUMAN_HANDOFF_ADVISOR_PHONE` | (sin default) | Solo si `HUMAN_HANDOFF_ALERTS_ENABLED=true` -- si no, `config.ts` falla al arrancar (ver §9). |
| `HUMAN_HANDOFF_ALERT_TEMPLATE_NAME` | `handoff_asesor` | Nunca -- tiene default, pero el nombre no se asume aprobado por Meta (ver §10). |

Reutiliza `WHATSAPP_TEMPLATE_LANGUAGE` (default `es_MX`) -- no se creó una segunda config de
idioma.

## 4. Template

**Nombre propuesto**: `handoff_asesor`.

**Copy propuesto para enviar a Meta** (4 variables, en este orden exacto):

```
Atención requerida en Baluarte Capital.

Nombre: {{1}}
Contacto: {{2}}
Motivo: {{3}}
Hora: {{4}}

El chat quedó asignado a atención humana.
```

Ver [buildHumanHandoffAlertMessage](../../src/domain/message-templates.ts) -- es la única fuente
de este texto en el código (usado también para el body legible en tests/documentación; Meta
almacena el body real una vez aprobado, el código solo envía `params` posicionalmente).

## 5. Variables del template (orden exacto)

1. **Nombre** -- `conversationalFirstName(lead)` o el literal `"Lead sin nombre"` si no hay nombre
   o el lead no se encuentra.
2. **Contacto** -- `whatsappUserId` (el teléfono del lead, ya en el formato que llegó del webhook)
   -- suficiente para que Héctor localice el chat abriendo WhatsApp directamente.
3. **Motivo** -- string fijo: `"Mensaje no reconocido"` (`HUMAN_HANDOFF_ALERT_REASON_UNKNOWN_INTENT`
   en `message-templates.ts`) -- NUNCA el texto real del inbound.
4. **Hora** -- `DD/MM/YYYY HH:mm`, zona `ADVISOR_TIMEZONE` (America/Mexico_City), 24h.

## 6. PII incluida/excluida

**Incluida** (necesaria, mínima): nombre del lead (si existe) y su número de WhatsApp -- ambos
solo para que Héctor pueda ubicar y continuar la conversación real.

**Excluida explícitamente, siempre**: el texto original del mensaje del lead, cualquier dato de
salud, información fiscal, score/scoreClass, ingresos, número de póliza, o cualquier otro campo
sensible. La interfaz misma de `HandoffAlertTurnService.alertAdvisorOfHandoff` no tiene ningún
parámetro para el texto del inbound -- estructuralmente no puede filtrarse por accidente, no es
solo una convención de uso.

Los logs (`human_handoff_alert_sent`/`human_handoff_alert_failed`) tampoco incluyen el teléfono
completo del asesor ni del prospecto -- solo `leadIdLast8`/`conversationIdLast8` (mismo patrón que
todo el logging de este archivo desde Fase 7J).

## 7. Idempotencia

Ver el audit completo en el doc comment de
[human-handoff-alert-service.ts](../../src/application/human-handoff-alert-service.ts). Resumen:

- El dedupe existente de `provider_message_id` (webhook duplicado) y la supresión terminal de
  `HUMAN_HANDOFF` (mensaje posterior) YA garantizan, sin código nuevo, que
  `escalateUnknownIntent`/`escalateToHuman` nunca se ejecutan dos veces para el mismo episodio en
  esos dos casos concretos -- verificado con tests dedicados (items 6, 7).
- El único hueco real es una carrera verdaderamente concurrente (dos mensajes DISTINTOS para el
  mismo lead, casi simultáneos, antes de que cualquiera de las dos escrituras de estado se
  confirme). Se cierra reutilizando `ProcessedEventRepository.tryCreate({provider:
  "human_handoff_alert", eventId: leadId})` -- la MISMA infraestructura de Fase 6A (dedupe de
  envíos del calculador fiscal), sin tabla ni migración nueva. `tryCreate` gana (INSERT exitoso) o
  devuelve `null` en conflicto de unicidad `(provider, event_id)` -- mismo patrón que
  `SlotOfferClaimRepository.tryCreate`.
- **Límite conocido y documentado, aceptado para esta fase** (spec: "no construir un sistema
  complejo de colas/dedup esta fase, documentar la limitación"): la clave es `leadId` solo,
  **permanente**, no por episodio. Si un lead se recupera manualmente
  (`HumanHandoffRecoveryService.recover()`) y MÁS TARDE vuelve a escalar por
  `UNKNOWN_INTENT_HANDOFF`, no se envía una segunda alerta (la clave de la primera sigue
  reclamada). Una fase futura podría resolverlo haciendo que `recover()` borre esta marca al
  recuperar un lead (requiere un método `delete` nuevo en `ProcessedEventRepository`, no
  implementado aquí).

## 8. Comportamiento ante fallo

`HumanHandoffAlertService.alertAdvisorOfHandoff` **nunca lanza** -- cualquier error (el claim de
idempotencia, la búsqueda del nombre del lead, o el envío real) se captura y se registra como
`human_handoff_alert_failed`. La transición a `HUMAN_HANDOFF` y la respuesta al lead
(`UNKNOWN_INTENT_HANDOFF_MESSAGE`) YA se completaron antes de que esta función se llame en ambos
call sites -- nada aquí puede revertir ese handoff ni hacer que Lía vuelva a responder
automáticamente, ni reprocesa el inbound original. Verificado con tests dedicados (items 8, 9).

## 9. Retries

`MetaWhatsAppProvider` (auditado, ver
[meta-whatsapp-provider.ts](../../src/infrastructure/meta-whatsapp-provider.ts)) no tiene ningún
retry propio -- un solo intento de `fetch`, lanza `MessagingProviderError` en cualquier fallo. No
se construyó un sistema de reintentos nuevo esta fase (instrucción explícita del spec). Mínimo
cumplido: el fallo queda observable vía el log `human_handoff_alert_failed`. **Limitación
documentada**: no hay reintento automático ni sweep periódico -- si el envío falla (p. ej. el
template todavía no está aprobado, o un error transitorio de red), Héctor no recibe la alerta para
ESE episodio y debe enterarse por Supabase/logs como antes de esta fase, a menos que una fase
futura agregue un sweep de reintento (fuera de alcance aquí).

## 10. Comportamiento con el template NO aprobado

`HUMAN_HANDOFF_ALERTS_ENABLED=false` (el default) se puede desplegar sin ningún problema aunque el
template `handoff_asesor` no exista todavía en Meta Business Manager -- `config.ts` no exige nada
relacionado con el template cuando el flag está apagado, y ningún código intenta enviarlo. Con el
flag en `true` pero el template aún no aprobado por Meta, el envío real fallará en tiempo de
ejecución (`MessagingProviderError`, capturado y registrado como
`human_handoff_alert_failed`) -- el despliegue en sí NUNCA se bloquea por esto, solo el envío
puntual falla de forma observable hasta que Meta apruebe el template.

## 11. Alcance: solo UNKNOWN_INTENT_HANDOFF

Verificado con tests dedicados
([booking-outcome-dispatch-handoff-alert.test.ts](../../tests/booking-outcome-dispatch-handoff-alert.test.ts)):
`escalateToHuman` con `eventType` `BOOKING_INCONSISTENCY_HANDOFF`, `MAX_ROUNDS_REACHED`, o
`RESCHEDULE_APPOINTMENT_INCONSISTENCY` completa el handoff normalmente pero NUNCA dispara una
alerta. El helper (`HandoffAlertTurnService`) es deliberadamente genérico -- reutilizable para un
motivo futuro sin rediseño -- pero ningún otro call site lo invoca todavía.

## 12. Feature flags -- confirmación

`HUMAN_HANDOFF_ALERTS_ENABLED=false` dejado exactamente como default: cero cambio de
comportamiento en Fase 7J/7J.1. El fallback final del router para leads con un flag de FEATURE
apagado (`CONTACTED`/`CANCELLED`/etc., §3 del doc de Fase 7J) sigue completamente sin tocar --
esta fase no interactúa con esa lógica en absoluto.

## 13. Confirmación: no production writes

Todo el trabajo de esta fase es local: código + tests con repositorios en memoria
(`InMemoryProcessedEventRepository`, `InMemoryLeadRepository`, etc.) y un `FakeMessagingProvider`
-- ningún test envía un WhatsApp real ni toca Meta, HubSpot, o Calendar reales. `git push` a la
rama de feature únicamente -- sin merge, sin deploy, sin cambiar variables de entorno en Render.

**NO tocar producción.**
