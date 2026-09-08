# FASE 7J.3-DIAG — UNKNOWN INTENT interceptado por el flujo de cita pasada

**Solo diagnóstico. Cero cambios de código en este documento.** Auditoría realizada sobre
`feature/unknown-intent-human-handoff` @ `ed3d69c`. Todas las consultas a Supabase fueron
`.select()` de solo lectura (script `scripts/diagnose-past-appointment-unknown-intent.ts`, incluido
en este commit para reproducibilidad -- no escribe nada).

## 1. Estado real del lead (+524776490956)

| Campo | Valor |
|---|---|
| leadIdLast8 | `eb95060d` |
| status ANTES del primer "seguro de auto" (22:15:51 UTC) | `BOOKED` |
| status DESPUÉS (verificado hasta el final de la conversación) | `BOOKED` (sin cambio -- nunca `HUMAN_HANDOFF`) |
| appointment activo | `eefa96da`, status `BOOKED` |
| appointment.starts_at | `2026-09-07T16:00:00Z` = **10:00 a.m. America/Mexico_City** (coincide exactamente con "Lunes 7, 10:00 a.m." reportado) |
| appointment.ends_at | `2026-09-07T16:30:00Z` = 10:30 a.m. local |
| ¿era past appointment? | **Sí** -- `ends_at` (16:30Z) < `now` (22:15Z, el momento del primer "seguro de auto") |
| conversationIdLast8 (la relevante) | `ae9bdaee` (status `ACTIVE` en todo momento -- nunca `HUMAN_HANDOFF`) |
| transiciones producidas por "seguro de auto" | **Ninguna** -- cero filas nuevas en `lead_status_history` entre 22:15 y 22:16 |
| event_types relevantes en la conversación completa | `BOOKING_INCONSISTENCY_HANDOFF` (x2, otro problema, ya recuperado manualmente), `HANDOFF_MANUALLY_RECOVERED` (x2), `RESCHEDULE_REQUESTED`/`RESCHEDULE_CONFIRMED` (la reagenda de las 06:05-06:06, la que dejó la cita en 10am) -- **ningún `UNKNOWN_INTENT_HANDOFF` en todo el historial de este lead** |

Los mensajes reales, reconstruidos por longitud/dirección/timestamp (nunca se leyó el `body`
completo salvo para esta correlación puntual, ya autorizada por el propio QA):

| Hora (UTC) | Dirección | Correlación |
|---|---|---|
| 22:15:51 | IN (47 chars) | "También me pueden ayudar con un seguro de auto?" (1er envío) |
| 22:15:53 | OUT (113 chars) | `PAST_BOOKED_GENERIC_INBOUND_MESSAGE` ("Veo que tu cita anterior ya pasó...") |
| 22:16:04 | IN (47 chars) | mismo mensaje, 2do envío |
| 22:16:04 | OUT (91 chars) | `QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE` ("¿Qué te gustaría revisar? 1/2/3") |
| 22:16:12 | IN (1 char) | "1" (o "2" -- el contenido exacto no cambia el diagnóstico, ver §6) |
| 22:16:13 | OUT (91 chars) | el MISMO menú, repetido |
| 22:16:18 | IN (1 char) | otro dígito |
| 22:16:19 | OUT (91 chars) | el MISMO menú, repetido otra vez |

## 2. Primer branch: "Veo que tu cita anterior ya pasó..."

- **Archivo**: [whatsapp-past-booked-recovery-handler.ts](../../src/application/whatsapp-past-booked-recovery-handler.ts)
- **Función**: `WhatsAppPastBookedRecoveryHandler.handleTurn`, rama final (línea ~218-222)
- **Condición**: `!hasPastBookedReactivationBeenShown(priorMessages)` -- primera vez que este mensaje se muestra en el episodio
- **Posición en `WhatsAppInboundService`**: [whatsapp-inbound-service.ts:678](../../src/application/whatsapp-inbound-service.ts) -- `if (deps.pastBookedRecoveryHandler && deps.appointments && lead.status === "BOOKED")`, evaluado **ANTES** de reschedule-intent, reagenda contextual, y el branch BOOKED-genérico (donde vive el `UNKNOWN_INTENT_HANDOFF` de Fase 7J.1). **Confirmado: corre antes, y si `!hasUpcomingAppointment` (cierto aquí), consume el turno por completo (`return`) -- el fallback de Fase 7J.1 nunca se evalúa.**

Hipótesis del spec (`pastBookedRecoveryHandler`) **confirmada**, no asumida -- verificada leyendo el código y correlacionando con los datos reales de Supabase.

## 3. Por qué "seguro de auto" fue consumido por este handler

`WhatsAppPastBookedRecoveryHandler.handleTurn` evalúa, en orden: `isCancellationRequest` → NO,
`isRescheduleRequest` → NO, `isNewBookingRequest` → NO, followup pendiente de tema → NO (no había
ninguno activo), `detectQualifiedLeadIntent(inboundText, null)` → **`UNKNOWN`** (ver §5 -- "seguro
de auto" no coincide con ningún keyword de PPR/GMM/SAVINGS/EXPLORE_OPTIONS/BOOKING/IDENTITY),
`classifyShortResponse` → no es un cierre ni una afirmación corta → cae al fallback final:
`hasPastBookedReactivationBeenShown` es `false` (primera vez) → **`PAST_BOOKED_GENERIC_INBOUND_MESSAGE`**.

Respondiendo explícitamente:
- **¿El handler captura cualquier texto?** Sí -- es un catch-all: cualquier texto que no matchee
  ninguno de los intents explícitos arriba termina en esta rama final, sin importar su contenido.
- **¿Solo mira estado/cita pasada?** No solo eso, pero el EFECTO NETO para contenido genuinamente
  no soportado es equivalente a ignorar el contenido: no hay ninguna rama de "esto no lo puedo
  resolver, escalo" -- solo dos salidas posibles para lo no reconocido (genérico de cita pasada, o
  menú genérico), nunca `HUMAN_HANDOFF`.
- **¿Ignora el contenido?** Efectivamente sí, para cualquier texto que no sea un keyword conocido.
- **¿Cambia status?** No en esta rama -- `lead.status` permanece `BOOKED` (confirmado con los
  datos reales). Solo cambia el `metadata` del mensaje saliente.
- **¿Crea `expectedIntent`/estado conversacional?** **Sí** -- `pastBookedReactivationMetadata()`
  marca el mensaje saliente. Este marcador es consultado por `hasPastBookedReactivationBeenShown`
  (para decidir si repetir el mismo texto o pasar al menú), pero **nunca** es consultado por
  `detectQualifiedLeadIntent` para resolver una respuesta posterior -- ver §6, la causa raíz real.

## 4. Segundo turno: por qué apareció el menú "¿Qué te gustaría revisar?"

Mismo mensaje, mismo código (`WhatsAppPastBookedRecoveryHandler.handleTurn`), misma cadena de
evaluación con el mismo resultado (`UNKNOWN`) -- la ÚNICA diferencia es el fallback final:
`hasPastBookedReactivationBeenShown(priorMessages)` ahora es **`true`** (el mensaje anterior ya
quedó en el historial con `pastBookedReactivationMetadata()`), así que la rama toma el `else`:
**`QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE`** + `qualifiedMainMenuMetadata()`.

- **Branch/handler**: el mismo de §2/§3 -- `WhatsAppPastBookedRecoveryHandler.handleTurn`, líneas 218-222.
- **Estado del lead**: `BOOKED`, sin cambios.
- **Metadata**: pasa de `pastBookedReactivationMetadata()` (1er mensaje) a `qualifiedMainMenuMetadata()` (2do mensaje) -- SÍ se persiste un `expectedIntent` (`QUALIFIED_MAIN_MENU`).
- **Por qué no llegó al fallback de UNKNOWN_INTENT**: exactamente la misma razón que el primer
  turno -- este handler corre y consume el turno (`return`) mucho antes de que
  `whatsapp-inbound-service.ts` llegue a su rama BOOKED-genérica (Fase 7J.1). El fallback de
  Fase 7J.1 es estructuralmente inalcanzable para cualquier lead cuyo `appointment` sea pasado,
  sin importar cuántas veces se repita el ciclo.

## 5. Auditoría del menú "¿Qué te gustaría revisar?"

- **Dónde se genera**: `QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE`, constante en
  [message-templates.ts:404-405](../../src/domain/message-templates.ts) -- `"¿Qué te gustaría
  revisar?\n\n1. Resolver una duda\n2. Conocer opciones\n3. Agendar una asesoría"`.
- **Qué handler DEBE consumir "1"/"2"/"3"**: el mismo `WhatsAppPastBookedRecoveryHandler` que lo
  mostró (es su propio menú, mostrado en su propio fallback).
- **Qué parser interpreta la selección**: `detectQualifiedLeadIntent(text, pendingMenu)` en
  [qualified-lead-intent-detection.ts](../../src/domain/qualified-lead-intent-detection.ts) --
  cuando `pendingMenu === "MAIN"`, un dígito 1/2/3 se resuelve a `MENU_QUESTION`/
  `EXPLORE_OPTIONS`/`BOOKING` respectivamente (líneas 86-91 de ese archivo).
- **Qué `expectedIntent`/contexto DEBERÍA existir**: `resolvePendingQualifiedMenu(priorMessages)`
  -- lee el `metadata` del último mensaje OUTBOUND y devuelve `"MAIN"` si encuentra el marcador
  `QUALIFIED_MAIN_MENU` (exactamente el que `qualifiedMainMenuMetadata()` ya escribió). **Esta
  función YA EXISTE, ya está probada, y ya es usada correctamente en otro lugar** (ver §6).

### Por qué "2" y luego "1" repiten el mismo menú en vez de avanzar

`WhatsAppPastBookedRecoveryHandler.handleTurn`, línea 166:

```ts
const intent = detectQualifiedLeadIntent(inboundText, null);
```

**El segundo argumento está hardcodeado a `null`.** Nunca se llama a
`resolvePendingQualifiedMenu(priorMessages)` en este archivo -- ni siquiera está importado. El
propio comentario del código (líneas 162-165) dice explícitamente: *"this flow never shows a
numbered 1/2/3 menu, so a bare digit has no menu to resolve against and correctly falls through to
UNKNOWN"* -- **una premisa que el propio código, 50 líneas más abajo, contradice**:
`QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE` + `qualifiedMainMenuMetadata()` es exactamente un menú
numerado 1/2/3, mostrado por este mismo handler.

Con `pendingMenu` siempre `null`, las condiciones `if (pendingMenu === "MAIN")` (línea 86 de
`qualified-lead-intent-detection.ts`) nunca se cumplen para ninguna llamada hecha desde este
archivo -- así que un "1", "2", o "3" enviado en respuesta a ESTE menú SIEMPRE cae en
`{kind: "UNKNOWN"}`, sin importar cuál sea. `classifyShortResponse("1")`/`"2"` tampoco lo
reconoce (no es un cierre/afirmación). Cae de nuevo al fallback final, y como
`hasPastBookedReactivationBeenShown` sigue siendo `true`, **repite exactamente el mismo menú** --
indefinidamente, para cualquier dígito, cualquier número de veces.

## 6. Causa del bug de selección numérica

**B/C híbrido, evidencia exacta:**

- El `expectedIntent` **SÍ se persiste** (`qualifiedMainMenuMetadata()` escribe
  `{expectedIntent: "QUALIFIED_MAIN_MENU"}` en el mensaje saliente) -- descarta (A) "no existe
  parser" tal cual, y descarta (B) "no se persiste" literalmente.
- Pero **nunca se lee de vuelta** en este archivo -- la llamada a `detectQualifiedLeadIntent`
  ignora por completo el historial de mensajes para ese propósito, pasando `null` a mano. El
  efecto práctico es indistinguible de (C) "se pierde": para todo propósito observable, el estado
  persistido es inútil porque nadie lo consulta.
- (D) "el router procesa el número antes" -- descartado: el número nunca sale de
  `WhatsAppPastBookedRecoveryHandler`, este handler consume el turno completo.
- (E) "el handler repite el menú por diseño incorrecto" -- **parcialmente cierto como síntoma**,
  pero la causa raíz no es un diseño deliberado de repetir: es que, al no resolver el dígito, cae
  al mismo fallback "genuinely unrecognized" que ya sabíamos mostrar `QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE`
  una vez `hasPastBookedReactivationBeenShown` es `true` -- el loop es un efecto colateral, no una
  intención explícita de "repetir el menú".

**Evidencia definitiva**: la MISMA función `resolvePendingQualifiedMenu` ya es usada
correctamente en `whatsapp-inbound-service.ts:625` (`const pendingMenu =
resolvePendingQualifiedMenu(priorMessages);`) para el router principal QUALIFIED_A/B/NURTURE_C, que
NO tiene este bug. `WhatsAppPastBookedRecoveryHandler` reimplementa el mismo menú (mismo texto,
mismo marcador) pero omite ese único paso.

Adicionalmente, incluso si se corrigiera el `pendingMenu`, **"1" (MENU_QUESTION) seguiría sin
avanzar**: el `switch` de este handler (líneas 167-196) no tiene ningún `case "MENU_QUESTION"` --
cae al mismo `break` que `UNKNOWN` (línea 194-195). El router principal SÍ lo maneja (línea 676-681
de `whatsapp-inbound-service.ts`: responde con `buildQualifiedLeadAskQuestionMessage(...)`, ya
existente). "2" y "3" sí tienen `case` correcto aquí (`EXPLORE_OPTIONS`, `BOOKING`) -- solo
`MENU_QUESTION` (la opción "1") falta.

## 7. Routing order completo para `appointment BOOKED, ends_at < now`

Orden real, evaluado en `whatsapp-inbound-service.ts` para `lead.status === "BOOKED"`:

1. `wasAlreadySuppressed` (DO_NOT_CONTACT/HUMAN_HANDOFF) -- terminal, ya pasado antes de esto.
2. contenido sensible de salud -- handoff dedicado, ya pasado antes de esto.
3. **`pastBookedRecoveryHandler`** (si está presente Y `!hasUpcomingAppointment`) -- **AQUÍ ES DONDE QUEDA BLOQUEADO EL FALLBACK DE FASE 7J.1.** Si el appointment es pasado, este branch consume el turno INCONDICIONALMENTE (delega TODO a `WhatsAppPastBookedRecoveryHandler`, que a su vez tiene su PROPIO fallback interno -- nunca escala, nunca retorna al router).
4. confirmación de cita pendiente -- nunca alcanzado (ya consumido en el paso 3).
5. reschedule-intent explícito -- nunca alcanzado.
6. reagenda contextual -- nunca alcanzado.
7. BOOKED-genérico (con el clasificador `UNKNOWN_INTENT_HANDOFF` de Fase 7J.1) -- **nunca alcanzado**.
8. `cancellationHandler` dispatch -- nunca alcanzado.
9. reactivación (`CANCELLED`) -- no aplica, `lead.status` nunca es `CANCELLED` aquí.

**Conclusión**: para cualquier lead `BOOKED` con cita pasada (mientras `pastBookedRecoveryHandler`
esté presente, es decir `WHATSAPP_BOOKING_ENABLED=true`), el 100% del tráfico de ese turno es
absorbido por `WhatsAppPastBookedRecoveryHandler` -- el fallback `UNKNOWN_INTENT_HANDOFF` de Fase
7J.1 (escrito específicamente para "BOOKED-genérico") es letra muerta en este escenario exacto.
Esto NO fue cubierto por las pruebas de Fase 7J.1: ese conjunto de tests usa siempre citas
FUTURAS (`isUpcomingBooked` verdadero) precisamente para no activar `pastBookedRecoveryHandler` --
un past-appointment BOOKED nunca se ejercitó contra el nuevo clasificador.

## 8-9-10-11. Decisión de producto, alcance, y menú -- ya reflejados en la evidencia

Ejemplos verificados contra el código real (sin implementar nada):

| Texto | Clasificación actual | Resultado actual | Resultado deseado (§8) |
|---|---|---|---|
| "También me pueden ayudar con un seguro de auto?" | `detectQualifiedLeadIntent` → UNKNOWN | genérico de cita pasada / menú repetido | `UNKNOWN_INTENT_HANDOFF` |
| "Quiero reagendar" | `isRescheduleRequest` → true | inicia nueva ronda de booking (correcto) | sin cambio |
| "Quiero otra cita" | `isNewBookingRequest` (`/otra\s+cita\b/`) → true | inicia nueva ronda (correcto) | sin cambio |
| "Agendar" | `isNewBookingRequest` (`\bagendar\b`) → true | inicia nueva ronda (correcto) | sin cambio |
| "Gracias" | `classifyShortResponse` → CLOSING | `FOLLOWUP_CLOSING_MESSAGE` (correcto, no handoff) | sin cambio |

El §9 (extender semántica de UNKNOWN_INTENT a cualquier estado activo) es coherente con lo
observado: la extensión necesaria es específicamente a `WhatsAppPastBookedRecoveryHandler`'s
propio fallback -- **no** al fallback final del router (§3 de Fase 7J), que sigue sin tocarse.

Sobre el menú (§11): tiene valor real (opción 2 y 3 ya funcionan bien conceptualmente una vez
resuelto el bug de §6), pero la opción 1 ("Resolver una duda") necesita el mismo tratamiento que
ya existe en el router principal (`buildQualifiedLeadAskQuestionMessage`) -- no
`HUMAN_HANDOFF` automático solo por elegir "1" (el usuario aún no dijo cuál es su duda; escalar
ahí sería prematuro, igual que en el router principal donde tampoco escala).

## 12. Confirmación: la alerta de Fase 7J.2 no falló

Verificado contra los datos reales: cero filas de `lead_status_history` con
`eventType: "UNKNOWN_INTENT_HANDOFF"` para este lead, en todo su historial. La precondición para
disparar la alerta (`escalateUnknownIntent`/`escalateToHuman` con ese `eventType`) nunca se
cumplió -- no hay ningún log de `human_handoff_alert_sent`/`human_handoff_alert_failed` que
buscar porque el código que los emitiría nunca se ejecutó. **La alerta funciona correctamente; el
problema es exclusivamente de enrutamiento (routing), no de la alerta en sí.**

## 13. Expected flow real -- confirmado por diseño, no aún por comportamiento

El flujo esperado (1-8 del spec) es exactamente el que Fase 7J.1 ya implementa para `BOOKED` con
cita VIGENTE -- el gap es únicamente la ruta paralela de `WhatsAppPastBookedRecoveryHandler`, que
nunca fue actualizada para reusar ese mismo clasificador.

## 14. Tests propuestos (NO implementados -- diagnóstico únicamente)

Los 17 tests del spec son correctos y necesarios para la fase de implementación. Notas de diseño
para cuando se implementen:
- Tests 1-2 (pregunta de producto / gibberish con cita pasada) requieren el fix A (§16).
- Tests 3-5 (reagendar/otra cita/date preference) ya deberían pasar SIN cambios -- son regresión.
- Tests 9-12 (menú 1/2/3) requieren el fix B (§16) -- pasar `resolvePendingQualifiedMenu` y añadir
  el `case "MENU_QUESTION"`.
- Test 7 (alerta) reutiliza `HumanHandoffAlertService` tal cual, sin cambios (Fase 7J.2).
- Tests 16-17 (BOOKED/BOOKING_PENDING sin cambios) son regresión pura contra Fase 7J/7J.1.

## 15. Diagnóstico final

**`CAUSE_PAST_BOOKED_HANDLER_OVERBROAD`** -- `WhatsAppPastBookedRecoveryHandler` captura
incondicionalmente cualquier texto no reconocido como cancelación/reagenda/booking/tema conocido,
sin ninguna vía de escape hacia `HUMAN_HANDOFF`. Evidencia: §3, §7.

**`CAUSE_UNKNOWN_INTENT_ROUTING_UNREACHABLE`** -- el fallback `UNKNOWN_INTENT_HANDOFF` de Fase
7J.1 (BOOKED-genérico) es estructuralmente inalcanzable para cualquier lead `BOOKED` con cita
pasada, porque `pastBookedRecoveryHandler` consume el turno antes de que el router llegue a esa
rama. Evidencia: §2, §7.

**`CAUSE_MENU_SELECTION_STATE_MISSING`** (matiz: el estado SÍ se persiste, pero nunca se lee) --
`detectQualifiedLeadIntent(inboundText, null)` en `whatsapp-past-booked-recovery-handler.ts:166`
ignora `resolvePendingQualifiedMenu(priorMessages)`, la función ya existente y ya usada
correctamente por el router principal para este mismo propósito. Evidencia: §5, §6.

**`CAUSE_NUMERIC_SELECTION_UNHANDLED`** (secundaria, solo para la opción "1") -- incluso
resolviendo el `pendingMenu`, falta un `case "MENU_QUESTION"` en el switch de este handler.
Evidencia: §6.

## 16. Fix mínimo propuesto (NO implementado)

**A. Permitir `UNKNOWN_INTENT_HANDOFF` tras una cita pasada.** En el fallback final de
`WhatsAppPastBookedRecoveryHandler.handleTurn` (líneas 213-222), antes de decidir entre
`PAST_BOOKED_GENERIC_INBOUND_MESSAGE`/`QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE`, aplicar el MISMO
clasificador ya construido en Fase 7J.1 para el branch BOOKED-genérico
(`isSocialAcknowledgement`, `isBareGreeting`, `isVagueInformationRequest`, ya reutiliza
`isNewBookingRequest`/`parseDatePreference` que este archivo ya importa) -- si el texto no
califica como "seguro/relacionado", escalar con `escalateToHuman(this.deps, lead, conversationId,
whatsappUserId, "UNKNOWN_INTENT_HANDOFF", UNKNOWN_INTENT_HANDOFF_MESSAGE)` (ya importado en este
archivo como `escalateToHuman`, y `WhatsAppPastBookedRecoveryHandlerDeps extends
BookingOutcomeDeps` -- el campo `handoffAlertService` ya existe en esa interfaz, así que la
alerta de Fase 7J.2 se dispara automáticamente sin trabajo adicional). Nunca tocar el fallback
final del router (§3 de Fase 7J) -- el cambio vive enteramente dentro de este handler.

**B. Evitar que preguntas random sean consumidas por reactivación.** Es el mismo cambio que A --
la razón por la que hoy son consumidas es la ausencia de esa vía de escape; no hace falta
"estrechar" las detecciones de reagendar/agendar/otra-cita existentes (ya son razonablemente
específicas, confirmado por los ejemplos de la tabla del §8-11), solo añadir el fallback que falta.

**C. Arreglar el menú 1/2/3.** Dos cambios puntuales, ambos en
`whatsapp-past-booked-recovery-handler.ts`:
1. Importar `resolvePendingQualifiedMenu` de `qualified-lead-menu-state.js` y usarlo en la línea
   166: `detectQualifiedLeadIntent(inboundText, resolvePendingQualifiedMenu(priorMessages))` en
   vez de `detectQualifiedLeadIntent(inboundText, null)`.
2. Añadir `case "MENU_QUESTION":` al switch (línea ~193), respondiendo con
   `buildQualifiedLeadAskQuestionMessage(hasFiscalContext)` -- mismo mensaje que ya usa el router
   principal para el mismo caso, sin copy nueva.

Ninguno de los tres cambios toca `whatsapp-inbound-service.ts`, el enrutamiento general, ni
ningún otro handler. Alcance total: un archivo (`whatsapp-past-booked-recovery-handler.ts`), sin
rediseño del router.

## 17. Confirmación

**NO se realizó ningún cambio de código en esta fase.** Único artefacto nuevo:
`scripts/diagnose-past-appointment-unknown-intent.ts` (script de diagnóstico, solo lectura, sin
efecto en producción) y este documento. Ninguna tabla, fila, o configuración de Supabase fue
modificada -- todas las consultas ejecutadas fueron `.select()`.

**NO tocar producción.**
