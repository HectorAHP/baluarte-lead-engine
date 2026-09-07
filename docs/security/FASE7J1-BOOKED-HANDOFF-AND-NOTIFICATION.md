# FASE 7J.1 — BOOKED Unknown Intent + Auditoría de Notificación Operativa

## PARTE A — BOOKED UNKNOWN INTENT

### 1. Auditoría del branch BOOKED-genérico (antes de esta fase)

`whatsapp-inbound-service.ts`, gated por `deps.rescheduleHandler && deps.cancellationHandler &&
lead.status === "BOOKED" && !isCancellationRequest(input.text)`, alcanzado DESPUÉS de (en este
orden): recuperación de cita pasada, confirmación de cita pendiente, reagenda explícita
(`isRescheduleRequest`), reagenda contextual (`isContextualRescheduleRequest` + `DatePreference`).

**Antes de esta fase capturaba literalmente CUALQUIER texto** que no fuera: reagenda explícita,
reagenda contextual, o intención de cancelación (`isCancellationRequest`, chequeado justo antes del
`if`). Esto incluía indistintamente: acuses ("gracias"), saludos ("hola"), preguntas genuinas sin
relación con la cita ("¿también me pueden ayudar con el seguro de mi empresa?"), y gibberish. Todo
recibía la MISMA respuesta genérica ("Ya tienes una cita agendada... Si tienes alguna otra duda,
escríbela aquí y te ayudamos").

### 2. Intents conocidos -- prioridad confirmada, sin cambios

Reschedule explícito, reagenda contextual, cancelación, confirmación de cita, recuperación de cita
pasada -- TODOS se evalúan ANTES del branch genérico y ninguno fue tocado. Verificado con la suite
completa (129/130 archivos ya cubrían estos flujos) más los ítems 5, 6, 7 de la nueva suite
dedicada (`tests/whatsapp-booked-unknown-intent-handoff-e2e.test.ts`).

### 3-5. Clasificador nuevo (unknown vs. genérico), implementado en el mismo branch

`whatsapp-inbound-service.ts`'s BOOKED-generic branch ahora escala a `HUMAN_HANDOFF`
(`UNKNOWN_INTENT_HANDOFF`, mensaje `UNKNOWN_INTENT_HANDOFF_MESSAGE`) salvo que el texto sea:

- un acuse social exacto ("gracias", "nos vemos", ...) -- `isSocialAcknowledgement`.
- un saludo simple exacto ("hola", "buenas", ...) -- `isBareGreeting`.
- una solicitud de información vaga, sin tema propio ("Hola, quiero información", "Hola tengo una
  duda") -- nueva función `isVagueInformationRequest`. Una pregunta que SÍ nombra algo específico
  ("tengo una duda sobre una póliza anterior") NO cae aquí y puede escalar.
- texto que `isNewBookingRequest` ya reconoce ("Quiero agendar", "Agendar") -- reutilizado
  verbatim de Fase 6E.2; necesario para no romper
  `whatsapp-past-booked-recovery-e2e.test.ts`'s test 9 ("no double future booking").
- una `DatePreference` parseable (p. ej. "El 12 de septiembre", "¿Mi cita es el sábado?") -- una
  mención de fecha sin frase de cambio explícita, que Fase 7I.2 ya decidió deliberadamente que NO
  es reagenda; tampoco es "unknown intent" aquí -- sigue con la respuesta genérica.
- un número suelto (posible intento de selección de slot residual).

Todo lo demás (una pregunta real sin relación con la cita, o contenido genuinamente no
interpretable) escala. `BOOKED → HUMAN_HANDOFF` ya era una transición válida en
`state-machine.ts` (sin cambios ahí).

**Auditoría del corpus de tests existentes ANTES de escribir código** (evitando el ciclo de prueba
y error de Fase 7J): se enumeraron TODAS las aserciones `.toBe(BOOKED_GENERIC_INBOUND_MESSAGE)`
preexistentes en la suite completa (8 archivos) y se verificó que el clasificador nuevo las
satisface a todas sin modificar ni un solo test existente -- incluyendo "Hola" (recuperación de
cita futura), "Agendar"/"Quiero agendar" (no-doble-booking), "El 12 de septiembre"/"¿Mi cita es el
sábado?" (Fase 7I.2), y "Hola, quiero información"/"Hola tengo una duda" (post-mortem item A,
transactional-priority test G).

### 6. Tests nuevos -- `tests/whatsapp-booked-unknown-intent-handoff-e2e.test.ts` (11 tests)

Los 10 pedidos por el spec, en orden, más un test de flag-off explícito:

1. Pregunta real no soportada → `HUMAN_HANDOFF`.
2. Gibberish → `HUMAN_HANDOFF`.
3. "gracias" → sin handoff, genérico.
4. "perfecto" → sin handoff, genérico.
5. "cancelar" → cancelación sin cambios.
6. "reagendar" → reagenda sin cambios.
7. "Mejor el domingo" → reagenda contextual sin cambios.
8. "¿Mi cita es el sábado?" → genérico, sin handoff accidental.
9. Webhook duplicado (mismo `provider_message_id`) → un solo handoff, nunca dos.
10. Mensaje posterior tras handoff → suprimido (supresión terminal ya existente).
11. (flag-off) `WHATSAPP_RESCHEDULE_ENABLED` off → el branch genérico completo se desactiva
    (`rescheduleHandler` ausente); el turno cae en el dispatch de `cancellationHandler`, que
    internamente no-opea para texto no-cancelación (gap residual preexistente, documentado, no
    tocado por esta fase) -- silencio, cero cambios de comportamiento.

## PARTE B — CÓMO SE ENTERA HÉCTOR

### 7-8. Auditoría del handoff operativo actual

Repetida y ampliada la búsqueda de Fase 7J (`slack`, `sendgrid`, `nodemailer`, `smtp`, `notify(`,
`notification`) más una búsqueda dirigida en `src/infrastructure/` por sincronización de
status/lifecycle a HubSpot, por un número de WhatsApp interno/de alerta, y por cualquier
"dashboard": **cero resultados nuevos.**

Hoy, cuando `lead.status → HUMAN_HANDOFF`:

| Señal | ¿Existe? | Evidencia |
|---|---|---|
| Mensaje interno de WhatsApp a Héctor | NO | `MessagingProvider.sendText`/`sendTemplate` solo se invocan hacia `lead.whatsappUserId` (el lead), nunca hacia un segundo número. Sin `ADVISOR_WHATSAPP_NUMBER` ni variable equivalente en `config.ts`. |
| Email | NO | Cero integración SMTP/SendGrid en todo el repo. `EMAIL_DNS_VALIDATION_ENABLED`/`DISPOSABLE_EMAIL_CHECK_ENABLED` son para validar el email QUE EL LEAD ingresó, no para enviar correos. |
| HubSpot task | NO | `hubspot-crm-provider.ts` solo implementa `upsertContact` (email/phone/nombre/ciudad/estado + propiedades fiscales). Cero método de creación de tareas, cero sincronización de `lead.status`/pipeline. |
| HubSpot property/status | NO | Mismo hallazgo -- el status de Baluarte (`HUMAN_HANDOFF`, etc.) nunca se escribe a HubSpot. |
| Dashboard | NO | Repo puramente backend (Fastify API) -- no existe carpeta de frontend/admin UI. Solo hay endpoints administrativos por API (`POST /api/leads/:id/recover-handoff`, gated por `ADMIN_API_TOKEN`) que Héctor tendría que saber llamar, no algo que lo notifique proactivamente. |
| Supabase solamente | SÍ | `leads.status='HUMAN_HANDOFF'`, `conversations.status`, y una fila nueva en `lead_status_history` (`eventType: 'UNKNOWN_INTENT_HANDOFF'` para esta causa específica). Consultable, no empujado. |
| Log solamente | SÍ (parcial) | `logBranch(...)` emite un log nivel `warn` con `branch: "booked-unknown-intent-handoff"` (o el equivalente de Fase 7J para BOOKING_PENDING). Visible en el stream de logs de Render, pero al mismo nivel que docenas de otras líneas de "branch matched" rutinarias -- no hay ninguna alerta/paging configurado sobre estos logs. |

**Se encontró, adicionalmente, `HumanHandoffRecoveryService`
(`src/application/human-handoff-recovery-service.ts`, Fase 7E) -- pero es un mecanismo de
RECUPERACIÓN manual (sacar a un lead DE `HUMAN_HANDOFF`), no de notificación. Su propio doc
comment dice explícitamente "NEVER touches ... WhatsApp (no message sent here)".**

### 9. Respuesta explícita

**¿Cómo se entera Héctor hoy, inmediatamente, de que existe un HUMAN_HANDOFF?**

**No se entera automáticamente.** La única forma de saberlo es consultar la base de datos
directamente, o estar leyendo el stream de logs de Render en tiempo real y reconocer la línea
correcta entre el resto del tráfico. No existe ningún push/alerta.

## 10. Auditoría de canales ya disponibles (sin implementar nada nuevo)

| Canal | Infraestructura ya existente | Qué le faltaría |
|---|---|---|
| **A. WhatsApp interno a un número de asesor** | La MISMA cuenta de Meta Business API y el mismo `MessagingProvider`/`sendTemplate` ya usados para recordatorios y nudges de no-show (`appointment-reminder-service.ts`, `appointment-completion-service.ts`) -- cero credencial nueva. | (1) Un número de WhatsApp de Héctor como env var nueva (p. ej. `ADVISOR_ALERT_WHATSAPP_NUMBER`) -- un dato de configuración, no una credencial. (2) Meta exige plantilla pre-aprobada para mensajes iniciados por el negocio fuera de la ventana de 24h -- se necesitaría UNA plantilla nueva, aprobada por Meta (proceso externo, no solo código). |
| **B. HubSpot task/owner notification** | Las MISMAS credenciales de HubSpot ya usadas para `upsertContact`. | `hubspot-crm-provider.ts` no tiene ningún método de creación de tareas hoy -- habría que escribirlo (código nuevo, no solo config). Además se necesitaría el ID de owner/usuario de HubSpot de Héctor (un dato de config, no una credencial nueva si ya tiene cuenta HubSpot). |
| **C. Email** | Ninguna. | Una integración completamente nueva (SMTP o un proveedor tipo SendGrid), con sus propias credenciales, remitente verificado, y plantilla. El único canal de los tres que requiere infraestructura genuinamente nueva de punta a punta. |
| **D. Mecanismo de alertas ya existente** | No se encontró ninguno (ver tabla de la §9). | N/A. |

**No se implementó ninguna integración nueva en esta fase** -- ninguna opción cumple "cero
credenciales/templates/decisiones nuevas", así que, siguiendo la instrucción explícita del spec,
se deja para una fase separada, solo diseñada y reportada aquí.

## 11. Contenido mínimo de la alerta (diseño, no implementado)

Si se construye (canal A, B, o el que se decida), el contenido debe limitarse a:

- Nombre del lead, si existe (`lead.firstName`/`lead.name`, lo que ya esté).
- Identificador suficiente para localizar la conversación: `leadId` (o sus últimos 8 caracteres,
  mismo patrón `leadIdLast8` ya usado en todos los logs de este archivo) + el teléfono
  (`whatsappUserId`) para que Héctor pueda ABRIR la conversación de WhatsApp directamente.
- Motivo, en una frase fija y genérica: **"Mensaje no reconocido — requiere atención."** (nunca el
  contenido real del mensaje del lead -- ver la restricción siguiente).
- Timestamp de la escalada.
- Sin enlace a un dashboard (no existe ninguno) -- la instrucción operativa sería simplemente
  "abre WhatsApp y busca este número" o, si se construye el canal B, el enlace directo al
  contacto/task en HubSpot (eso sí lo genera HubSpot automáticamente).

**Explícitamente NUNCA**: el texto real del mensaje del lead, ni ningún dato de salud/financiero/
fiscal que pudiera venir en él -- coincide con el patrón de redacción de PII que ya sigue TODO el
logging de este archivo (`leadIdLast8`, nunca el mensaje completo).

## 12. Idempotencia de la alerta (diseño)

La MISMA garantía de idempotencia que ya protege la escalada en sí (Fase 7J/7J.1), reutilizada sin
un mecanismo nuevo:

- El dedupe de `provider_message_id` (ya existente en `message-ingestion.ts`) impide que un retry
  del webhook de Meta vuelva a ejecutar el handler -- si el handler nunca se re-ejecuta, la alerta
  (llamada desde dentro de `escalateUnknownIntent`) tampoco.
- La supresión terminal de `HUMAN_HANDOFF` (`wasAlreadySuppressed`, sin cambios) impide que un
  mensaje posterior de un lead YA en `HUMAN_HANDOFF` vuelva a ejecutar la rama de escalada -- la
  alerta, de implementarse en el mismo punto que `escalateUnknownIntent`, hereda automáticamente
  esta garantía sin lógica adicional.
- Regla de diseño para cuando se implemente: la llamada a la alerta debe vivir DENTRO de
  `escalateUnknownIntent` (o el punto equivalente), nunca en un cron/sweep separado que vuelva a
  escanear leads en `HUMAN_HANDOFF` -- eso sí podría re-alertar en cada corrida.

## 13. Feature flags -- confirmación explícita

`whatsapp-inbound-service.ts`'s fallback final (el que atiende `CONTACTED`/`CANCELLED`/etc. con un
flag apagado) **no fue tocado** en esta fase -- sigue exactamente como quedó tras la Sec 3 del
documento de Fase 7J: silencioso, sin escalar. Un handler deshabilitado por flag sigue sin implicar
`HUMAN_HANDOFF`. Verificado con el mismo test de flag-off (`whatsapp-reactivation-e2e.test.ts`'s
"CANCELLED + any text stays silent") en la corrida completa de esta fase, sin modificación.

## 14. Recomendación

**No existe hoy notificación real (§9).** De las tres opciones auditadas (§10), la recomendada
como mecanismo mínimo es la **A (WhatsApp interno a Héctor)**, por reutilizar el 100% de la
infraestructura de mensajería ya en producción (misma cuenta Meta, mismo `MessagingProvider`,
mismo patrón de `sendTemplate` que los recordatorios). Requiere, como único trabajo nuevo: (1) el
número de WhatsApp de Héctor como variable de entorno, y (2) UNA plantilla de Meta aprobada con el
contenido mínimo del §11. La opción B (HubSpot task) es una buena alternativa/complemento (mismas
credenciales, sin depender de aprobación de Meta) pero requiere escribir un método nuevo en
`hubspot-crm-provider.ts`. La opción C (email) es la que más trabajo/infraestructura nueva
requeriría y no se recomienda como primera opción.

**No implementado.** Queda como propuesta para una fase separada, con autorización explícita antes
de tocar credenciales, plantillas de Meta, o el código de `hubspot-crm-provider.ts`.

## 15. Validación

- `npm run typecheck` — limpio.
- `npm run build` — limpio.
- `npx vitest run` — **130 archivos / 1652 tests, 0 fallos** (129/1641 tras Fase 7J + 11 tests
  nuevos de `tests/whatsapp-booked-unknown-intent-handoff-e2e.test.ts`, cero regresiones,
  verificado dos veces: una vez antes de añadir el archivo de tests nuevo -- 129/1641 -- y una vez
  después -- 130/1652).
- `npm audit --production` — mismas 4 vulnerabilidades moderadas preexistentes, no relacionadas,
  no aplicadas (`uuid` vía `googleapis`).

## 16-20. Confirmaciones finales

- Feature flags: intactas (§13).
- No production writes: confirmado -- todo el trabajo es local, tests con repositorios en memoria,
  commit + push a la rama de feature, sin merge ni deploy.
- **GO/NO-GO para deploy de lógica: GO** (la lógica de BOOKED en sí está probada, no rompe ningún
  contrato existente, y preserva todas las protecciones listadas).
- **GO/NO-GO operativo del handoff: NO-GO.** La lógica de detección y escalada funciona
  correctamente, pero, exactamente como advierte el spec de esta fase, **un HUMAN_HANDOFF sin
  mecanismo visible para Héctor no completa el objetivo operativo** -- un lead puede quedar
  esperando indefinidamente sin que nadie lo sepa hasta que alguien consulte la base de datos o
  los logs manualmente. Desplegar la lógica sin resolver esto primero (o sin que Héctor acepte
  explícitamente operar por consulta manual mientras tanto) deja el problema original -- leads sin
  atender -- parcialmente resuelto, no cerrado.

**NO tocar producción.**
