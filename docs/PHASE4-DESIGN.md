# Phase 4 — Diseño técnico (Baluarte Lead Engine)

Estado: **DISEÑO, no implementado.** Checkpoint base: `f836cea` (507/507 tests). Ningún código,
migración ni commit fue producido para este documento — solo lectura del repo real.

---

## 1. Current architecture findings

Inspección directa de `src/domain`, `src/application`, `src/infrastructure`, `supabase/migrations/*`.

**Hallazgo mayor: gran parte del modelo de datos de Phase 4 ya existe, sin usar, desde la migración 001.**

- `appointments` (migración `001_initial.sql`) ya tiene columnas que Phase 1 anticipó y que Phase
  2/3 nunca llegaron a usar: `confirmation_status`, `confirmed_at`, **`rescheduled_from uuid
  references appointments(id)`**, `no_show boolean`, `meeting_completed boolean`. Ninguna aparece
  hoy en `src/domain/appointment.ts` (`Appointment` solo expone `id, leadId, status, startsAt,
  endsAt, timezone, calendarEventId, meetingProvider, meetingUrl`).
- `AppointmentStatus` (TypeScript) **ya incluye** `"RESCHEDULED" | "CANCELLED" | "NO_SHOW" |
  "COMPLETED"` — ningún código los escribe todavía.
- `LeadStatus` (TypeScript) **ya incluye** `CONFIRMED, RESCHEDULE_REQUESTED, NO_SHOW,
  MEETING_COMPLETED, QUOTE_PENDING, QUOTE_SENT, CLOSED_WON, CLOSED_LOST` — y `state-machine.ts` ya
  define transiciones completas para casi todos ellos (`BOOKED → RESCHEDULE_REQUESTED → BOOKED`,
  `NO_SHOW → BOOKING_PENDING`, `MEETING_COMPLETED → QUOTE_PENDING/...`). Nada los dispara hoy.
- `leads.status` y `appointments.status` son `text` **sin CHECK constraint** en la base real. Esto
  significa que agregar nuevos valores de estado (`CANCEL_PENDING`, `CANCELLED`, y usar
  `RESCHEDULED/NO_SHOW/COMPLETED` que ya existían) **no requiere ninguna migración SQL** — solo
  cambios en los tipos TypeScript y en `state-machine.ts`. Ver hallazgo importante en §13/§Migraciones.
- La única laguna real en el enum de `LeadStatus`: no existe ningún valor para "el lead canceló
  voluntariamente su cita" (`CLOSED_LOST` es un resultado comercial distinto; `DO_NOT_CONTACT` es
  opt-out, con efectos secundarios incorrectos). **Se requieren 2 valores nuevos:**
  `CANCEL_PENDING`, `CANCELLED`.
- `appointments_no_overlap` (migración 002) es un `EXCLUDE ... WHERE (status <> 'CANCELLED')` —
  ya excluye filas `CANCELLED` del chequeo de traslape. Esto es exactamente lo que necesita
  reagendado/cancelación: cambiar `status` de una fila existente la saca del conjunto vigilado sin
  ninguna migración adicional.
- `CalendarProvider` (ports.ts) hoy expone `getAvailableSlots, isSlotAvailable, createEvent,
  deleteEvent`. **No existe `updateEvent` ni `getEvent`.** `deleteEvent` existe pero solo se usa
  hoy como compensación interna de `completeBooking` (nunca como cancelación real de cara al
  usuario), y **envuelve cualquier error en `CalendarProviderError`, incluyendo un 404/410 (evento
  ya borrado)** — eso rompe la idempotencia de un reintento de cancelación/limpieza.
- No existe ningún sistema de jobs/cron/queue en el repo (ni node-cron, ni BullMQ, ni Supabase
  Edge Functions, ni pg_cron referenciado). El despliegue es un único proceso Fastify
  (`src/server.ts`: `app.listen(...)`), sin más infraestructura visible.
- No existe autenticación de administrador en ninguna ruta `/api/*` — todo está abierto salvo los
  webhooks de WhatsApp (protegidos por firma HMAC de Meta). Esto es un blocker menor para "endpoint
  administrativo" (§4/§6) — se resuelve con un secreto estático mínimo, ver §Riesgos.
- Patrón de intención determinística ya establecido y reutilizable tres veces:
  `opt-out-detection.ts`, `qualification-handoff-triggers.ts` (con `HandoffReason` +
  `detectHandoffTrigger`), `slot-selection-parser.ts`. Phase 4 debe seguir exactamente este
  patrón, no inventar uno nuevo.
- Verificado: ningún patrón de `OPT_OUT_PATTERNS` colisiona con frases de cancelación de cita
  ("cancelar mi cita", "cancela mi cita", "ya no puedo asistir", "quiero reagendar"). El único
  patrón con "cancelar" es `/cancelar mensajes/i` (substring exacto). El chequeo de opt-out corre
  primero, siempre, para cualquier estado — eso debe preservarse: un opt-out real nunca debe
  quedar atrapado en un flujo de cancelación/reagendado.
- `booking_attempts` + su patrón de ownership CAS (`claimTransition`, `PENDING_STALE_THRESHOLD_MS`,
  compensación Calendar-primero-luego-DB) es el mecanismo de idempotencia más maduro del proyecto.
  Phase 4 lo **reutiliza**, no lo reinventa, para reagendado y recordatorios.
- `markLeadBooked` (booking-outcome-dispatch.ts) tiene semántica "solo rellena si falta, nunca
  sobrescribe" — **incorrecta para reagendado**, donde `meetingAt` sí debe sobrescribirse
  intencionalmente. Reagendado necesita su propia función, no puede reusar `markLeadBooked` tal cual.

---

## 2. Phase 4 scope

Dentro de alcance: A–H tal como se pidió (reagendado, cancelación, recordatorios, no-show,
follow-up post-cita, human handoff consistente, idempotencia/concurrencia, auditoría).

Fuera de alcance explícito (no diseñado aquí, dejado para después): `CONFIRMED` (flujo de
"confirma tu asistencia"), `QUOTE_PENDING/QUOTE_SENT/CLOSED_WON/CLOSED_LOST` (pipeline de cotización
y cierre comercial), dashboard administrativo real, autenticación de usuarios real, canal de
notificación por email.

---

## 3. State-machine changes

### 3.1 Nuevos valores de `LeadStatus`

Solo **2 valores nuevos**: `CANCEL_PENDING`, `CANCELLED`. Todo lo demás (`RESCHEDULE_REQUESTED`,
`NO_SHOW`, `MEETING_COMPLETED`) ya existe y se reutiliza sin cambios de nombre.

### 3.2 Cambios a `transitions` en `state-machine.ts`

```
BOOKED:                ["CONFIRMED","RESCHEDULE_REQUESTED","CANCEL_PENDING","NO_SHOW","MEETING_COMPLETED","DO_NOT_CONTACT"]
CONFIRMED:              ["RESCHEDULE_REQUESTED","CANCEL_PENDING","NO_SHOW","MEETING_COMPLETED","DO_NOT_CONTACT"]
RESCHEDULE_REQUESTED:  ["BOOKED","HUMAN_HANDOFF","DO_NOT_CONTACT"]        // + HUMAN_HANDOFF (faltaba)
CANCEL_PENDING:        ["CANCELLED","BOOKED","HUMAN_HANDOFF","DO_NOT_CONTACT"]   // nuevo
CANCELLED:              ["BOOKING_PENDING","HUMAN_HANDOFF","DO_NOT_CONTACT"]      // nuevo, simétrico a NO_SHOW
NO_SHOW:                (sin cambios: ya incluye BOOKING_PENDING/BOOKED/CLOSED_LOST/DO_NOT_CONTACT)
```

Justificación de cada arista nueva:
- `BOOKED/CONFIRMED → CANCEL_PENDING`: entrada al flujo de cancelación.
- `RESCHEDULE_REQUESTED → HUMAN_HANDOFF`: faltaba — sin esto, un
  `ActiveOfferInconsistentError`/`BookingAttemptInconsistentError` durante un reagendado no tiene
  a dónde escalar (hoy causaría `InvalidLeadTransitionError` al intentar `assertTransition`).
- `CANCEL_PENDING → BOOKED`: cubre "2. No, conservar" y cualquier respuesta ambigua/timeout — nunca
  deja al lead atrapado en `CANCEL_PENDING`.
- `CANCELLED → BOOKING_PENDING`: un lead que canceló puede volver a agendar más adelante, mismo
  principio que `NO_SHOW → BOOKING_PENDING` ya establecido.
- `CANCEL_PENDING/CANCELLED → HUMAN_HANDOFF`: mismo patrón de escape que el resto de la máquina.

### 3.3 Matriz completa (estados de `leads`, incluye los ya existentes)

| CURRENT_STATE | EVENT | NEXT_STATE | ALLOWED? | SIDE EFFECTS |
|---|---|---|---|---|
| NEW | primer contacto | CONTACTED | ya existe | `firstContactAt`/`firstResponseAt` |
| CONTACTED | inicia qualifier | QUALIFYING | ya existe | — |
| QUALIFYING | score A/B | QUALIFIED_A/B | ya existe | `qualifiedAt` |
| QUALIFIED_A/B | oferta creada | BOOKING_PENDING | ya existe | `bookingStartedAt` |
| BOOKING_PENDING | selección válida | BOOKED | ya existe | `bookedAt`, `meetingAt`, appointment BOOKED, Calendar event creado |
| **BOOKED** | **"reagendar"** | **RESCHEDULE_REQUESTED** | **NUEVO uso** | mensaje inicio reagendado; `lead_status_history` |
| **RESCHEDULE_REQUESTED** | **nueva selección OK** | **BOOKED** | ya existía | appointment nuevo BOOKED (`rescheduled_from`), appointment viejo → RESCHEDULED, Calendar: nuevo evento creado + viejo borrado, `meetingAt` **sobrescrito** |
| **RESCHEDULE_REQUESTED** | **inconsistencia de datos** | **HUMAN_HANDOFF** | **NUEVO** | conversation → HUMAN_HANDOFF, `lead_status_history` reason=RESCHEDULE_INCONSISTENCY |
| **BOOKED** | **"cancelar"** | **CANCEL_PENDING** | **NUEVO** | mensaje de confirmación con fecha/hora |
| **CANCEL_PENDING** | **"1 / sí"** | **CANCELLED** | **NUEVO** | appointment → CANCELLED, Calendar event borrado, `closedAt`? no (ver nota), `lead_status_history` |
| **CANCEL_PENDING** | **"2 / no" / ambiguo / timeout** | **BOOKED** | **NUEVO** | mensaje "tu cita se mantiene", sin cambios de datos |
| **CANCELLED** | **lead quiere reagendar más tarde** | **BOOKING_PENDING** | **NUEVO** | mismo flujo de oferta que booking normal |
| BOOKED/CONFIRMED | appointment.starts_at pasó, sin confirmar | (sin cambio automático) | — | nudge interno a Héctor (§6), NUNCA auto-transición |
| **BOOKED/CONFIRMED** | **Héctor confirma asistencia** | **MEETING_COMPLETED** | ya existía | appointment → COMPLETED, dispara follow-up (§5) |
| **BOOKED/CONFIRMED** | **Héctor confirma no-show** | **NO_SHOW** | ya existía | appointment → NO_SHOW, mensaje opcional al lead |
| NO_SHOW | lead responde con intención de retomar | BOOKING_PENDING | ya existía | reusa flujo de oferta existente sin re-calificar |
| cualquiera | opt-out | DO_NOT_CONTACT | ya existe | conversation CLOSED |
| cualquiera | trigger de handoff | HUMAN_HANDOFF | ya existe | conversation HUMAN_HANDOFF, notificación a Héctor (§6, nuevo) |

Nota sobre `closed_at`: se deja **sin usar** para `CANCELLED` en Phase 4 (esa columna se reserva
para el cierre comercial real — `CLOSED_WON`/`CLOSED_LOST`, fuera de alcance). Una cancelación de
cita no es un cierre de lead.

### 3.4 `AppointmentStatus` — sin cambios de tipo, solo empieza a usarse

`RESCHEDULED`, `CANCELLED`, `NO_SHOW`, `COMPLETED` ya existen en el tipo TypeScript. Se recomienda
**no** usar las columnas legadas `no_show`/`meeting_completed`/`confirmation_status`/`confirmed_at`
de la tabla `appointments` — dejarlas sin tocar. Escribir dos representaciones del mismo hecho
(`status='NO_SHOW'` y `no_show=true`) es una fuente de inconsistencia clásica; `status` es la única
fuente de verdad, igual que ya lo es para `BOOKED`/`CANCELLED` hoy.

---

## 4. Data model

Filosofía: **3 tablas nuevas, cero columnas nuevas** (todo lo demás ya existe sin usar, ver §1).

### 4.1 `lead_status_history` (nueva)

Propósito: auditoría genérica de toda transición de `leads.status` — no solo Phase 4. Se engancha
en el **único punto de choke ya existente**, `LeadService.transitionTo` (`services.ts`), así que
una sola línea de código audita retroactivamente booking, calificación, handoff, reagendado,
cancelación y no-show, sin lógica especial por feature.

```sql
create table if not exists lead_status_history (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  from_status text not null,
  to_status text not null,
  reason_code text,              -- p.ej. 'LEAD_REQUESTED_CANCEL', 'NO_SHOW_CONFIRMED', null si no aplica
  actor text not null,           -- 'LEAD' | 'HECTOR' | 'SYSTEM'
  created_at timestamptz not null default now()
);
create index if not exists lead_status_history_lead_id_idx on lead_status_history(lead_id, created_at);
alter table lead_status_history enable row level security;
```

Sin `updated_at` (append-only, nunca se actualiza). Sin `metadata jsonb` — deliberado: cualquier
columna jsonb libre es una tentación de meter texto de mensaje (riesgo de dato clínico), y
`reason_code` cerrado ya cubre todo lo que Phase 4 necesita auditar. RLS activado sin policies
(mismo patrón que toda tabla existente — `service_role` bypasa, nunca se abre a `anon`/`authenticated`).
Retención: sin política de borrado en MVP — volumen bajo (un solo asesor), revisar si el proyecto
escala.

### 4.2 `appointment_status_history` (nueva)

Mismo patrón, para transiciones de `appointments.status` (`BOOKED→RESCHEDULED`,
`BOOKED→CANCELLED`, `BOOKED→NO_SHOW`, `BOOKED→COMPLETED`). Se engancha en el único método de
escritura de estado de una cita (nuevo helper compartido `closeOutAppointment`, ver §12 slice 4B).

```sql
create table if not exists appointment_status_history (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  from_status text not null,
  to_status text not null,
  reason_code text,
  actor text not null,
  created_at timestamptz not null default now()
);
create index if not exists appointment_status_history_appointment_id_idx on appointment_status_history(appointment_id, created_at);
alter table appointment_status_history enable row level security;
```

### 4.3 `appointment_message_deliveries` (nueva — cubre recordatorios Y follow-up, una sola tabla)

Se evaluó `appointment_events` + `reminder_deliveries` por separado (como sugirió el prompt) y se
descarta `appointment_events` por redundante con `appointment_status_history`. Recordatorios y
follow-up post-cita son estructuralmente el mismo problema ("un mensaje saliente programado, una
vez, por tipo, por cita") — una tabla generalizada por `delivery_type` evita duplicar esquema.

```sql
create table if not exists appointment_message_deliveries (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  delivery_type text not null check (delivery_type in ('REMINDER_24H','REMINDER_2H','POST_MEETING_FOLLOWUP')),
  status text not null default 'PENDING' check (status in ('PENDING','SENT','FAILED')),
  scheduled_for timestamptz not null,
  sent_at timestamptz,
  provider_message_id text,
  attempt_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id, delivery_type)
);
create index if not exists appointment_message_deliveries_sweep_idx
  on appointment_message_deliveries(delivery_type, status, scheduled_for);
alter table appointment_message_deliveries enable row level security;
```

`unique (appointment_id, delivery_type)` es el ancla de idempotencia: un segundo intento de crear
la fila para el mismo (cita, tipo) siempre pierde la carrera — exactamente el patrón de
`booking_attempts.idempotency_key` ya probado. `status` transiciona `PENDING → SENT` o
`PENDING → FAILED → PENDING` (reintento) vía el mismo `claimTransition`-style CAS que
`AppointmentService` ya usa, reutilizado sin reinventar.

### 4.4 Resumen de columnas ya existentes que Phase 4 empieza a usar (sin migración)

| Tabla | Columna | Uso en Phase 4 |
|---|---|---|
| appointments | `rescheduled_from` | fila nueva de un reagendado apunta a la fila vieja |
| appointments | `status` (valores RESCHEDULED/CANCELLED/NO_SHOW/COMPLETED) | ya en el tipo TS, faltaba escribirlos |
| leads | `status` (valores CANCEL_PENDING/CANCELLED) | `text` sin CHECK — no requiere migración |

---

## 5. Calendar changes

`CalendarProvider` (ports.ts) — **decisión: NO agregar `updateEvent` en Phase 4.**

Estrategia elegida para reagendado (ver análisis completo en §6 más abajo): cancelar evento viejo +
crear evento nuevo, reutilizando `createEvent`/`deleteEvent` ya existentes y ya endurecidos. Un
`updateEvent` (Google `events.patch`) preservaría el mismo Meet URL, pero introduciría una ruta de
Calendar completamente nueva, sin el hardening de `createEvent`/`completeBooking` (chequeo de
disponibilidad, compensación, idempotencia). Se documenta como optimización futura válida, no
necesaria para Phase 4.

`getEvent` — **no se agrega.** Phase 4 no necesita leer el estado de Calendar como fuente de
verdad (la DB ya es la fuente de verdad); agregarlo sin un consumidor real sería infraestructura
sin uso, igual que pasó con las columnas de la migración 001.

**Cambio real necesario — no un método nuevo, un comportamiento corregido de uno existente:**

`GoogleCalendarProvider.deleteEvent` hoy convierte *cualquier* error (incluyendo "evento ya no
existe", HTTP 404/410 de Google) en `CalendarProviderError`. Para que la limpieza de Calendar en
cancelación/reagendado sea reintentable de forma segura (§9, escenario "Google timeout después de
delete"), `deleteEvent` debe tratar un 404/410 de Google como éxito (evento ya no existe = el
resultado deseado ya se cumplió), y seguir lanzando `CalendarProviderError` para cualquier otro
fallo real (red, auth, rate limit). Esto es un ajuste interno a `GoogleCalendarProvider`, la
interfaz `CalendarProvider.deleteEvent(eventId): Promise<void>` no cambia.

`FakeCalendarProvider` necesitará el mismo comportamiento espejado (borrar un id ya borrado =
no-op, no throw) para que los tests de reagendado/cancelación sean fieles a producción.

---

## 6. Reagendado — análisis A vs B (requerido explícitamente)

**Opción A — actualizar la misma fila `appointments` (in-place, `UPDATE starts_at/ends_at`) y usar
`events.patch` en Calendar.**
**Opción B — cancelar la cita anterior + crear una nueva fila/evento, enlazadas por
`rescheduled_from`.**

| Criterio | A (in-place) | B (cancelar + crear) |
|---|---|---|
| Auditabilidad | Se pierde el horario original salvo que se duplique en `appointment_status_history` a mano | Cada fila es inmutable; el historial completo (horario original, Google event id original, cuándo) queda en filas reales, consultable con un simple `SELECT ... WHERE rescheduled_from = X` |
| Google event ID | Se conserva (bueno para continuidad de notificaciones de Google) | Cambia (evento nuevo) |
| Meet URL | Se conserva (bueno) | Cambia — el mensaje de confirmación ya maneja "nuevo enlace" sin inventar nada (`buildBookingConfirmedMessage` ya soporta `meetingUrl` opcional) |
| Concurrencia | Requiere lógica NUEVA de CAS sobre `starts_at/ends_at` de una fila compartida — no reutiliza nada existente | Reutiliza `AppointmentService.book()` completo (idempotencia, ownership, compensación) sin tocarlo; la fila nueva nunca colisiona con la vieja porque es una fila distinta |
| Compensación en fallo | Un `events.patch` fallido a medio camino dejaría el evento de Google y la fila DB divergidos, con CERO precedente de compensación en el código existente para ese caso | Reutiliza exactamente el patrón de compensación ya probado de `completeBooking` (crear evento nuevo → si falla el insert, borrar el evento nuevo) |
| Historial | Requiere tabla nueva para no perderlo | `rescheduled_from` (ya existe, sin usar) resuelve el encadenamiento sin tabla nueva |
| Idempotencia | Un reintento de "actualizar cita X a horario Y" no tiene manera natural de detectar "ya se aplicó" sin inventar una idempotency-key nueva sobre UPDATE | Reutiliza el `idempotencyKey` de `book()` sin cambios: `whatsapp-reschedule:{leadId}:{oldAppointmentId}:{slotId}` |
| DB constraints | El `EXCLUDE` de traslape (migración 002) vigila la MISMA fila cambiando de rango — funciona, pero compite con la fila en su propio estado transitorio | El `EXCLUDE` ya excluye filas `CANCELLED`, así que cancelar la vieja ANTES de que exista traslape nunca es un problema — el mecanismo existente ya está diseñado para este caso |

**Recomendación: Opción B**, exactamente porque `rescheduled_from` ya existe sin usar (Phase 1 lo
anticipó), porque reutiliza `AppointmentService.book()`/`completeBooking()` sin tocar código ya
probado, y porque da auditabilidad real (§H) sin tabla adicional. El costo aceptado es un Meet URL
nuevo en cada reagendado — comunicado explícitamente en el mensaje de confirmación.

### 6.1 Orden de operaciones (crítico para nunca dejar el estado prohibido)

```
1. Validar: lead en RESCHEDULE_REQUESTED, appointment activo existe, slot elegido es real y vigente.
2. Crear evento NUEVO en Google Calendar (createEvent) — reusa completeBooking() vía book().
   Falla aquí → nada cambió. Cita vieja+evento viejo siguen intactos. Reintentable.
3. Persistir fila NUEVA de appointment (status=BOOKED, rescheduled_from=<vieja>) — reusa
   completeBooking().
   Falla aquí → completeBooking() ya compensa borrando el evento nuevo recién creado (patrón
   existente, sin cambios). Cita vieja+evento viejo siguen intactos. Reintentable.
4. CAS: UPDATE appointments SET status='RESCHEDULED' WHERE id=<vieja> AND status='BOOKED'.
   Falla / 0 filas → HUMAN_HANDOFF (nunca seguir al paso 5 con la vieja todavía BOOKED: eso
   dejaría dos citas activas). Reintentable de forma segura (CAS = idempotente).
5. SOLO después de que 4 confirme éxito: deleteEvent(eventoViejo) — 404/410 tratado como éxito
   (ver §5). Si falla por otra razón: log + reconciliación diferida, NUNCA bloquea ni revierte
   el reagendado (la DB ya es correcta desde el paso 4 — el único residual es un evento huérfano
   en el Google Calendar de Héctor, riesgo operativo bajo, documentado, no oculto).
6. Lead: RESCHEDULE_REQUESTED → BOOKED, meetingAt = nueva appointment.startsAt (SOBRESCRITO,
   no "solo si falta" — requiere una función nueva, distinta de markLeadBooked).
```

Esto satisface exactamente las 4 prohibiciones del prompt: nunca dos citas activas (el paso 4 es
CAS antes de cualquier borrado), nunca dos eventos de Calendar activos (paso 5 solo corre después
de 4), nunca un appointment BOOKED apuntando a un evento borrado (el borrado es siempre lo último),
nunca un evento nuevo sin estrategia de compensación (pasos 2-3 reusan la compensación ya probada).

`SlotOfferingService` necesita una extensión mínima: su chequeo de "lead ofertable" (`assertOfferable`,
detrás de `LeadNotOfferableError`) debe aceptar `RESCHEDULE_REQUESTED` además de
`QUALIFIED_A/QUALIFIED_B/BOOKING_PENDING` — el resto de la máquina de ofertas (rounds, claims, TTL)
se reutiliza sin cambios.

---

## 7. Cancelación — diseño completo

- `BOOKED/CONFIRMED` + intención de cancelar detectada → `CANCEL_PENDING`, mensaje de confirmación
  con fecha/hora real de la cita (`formatSlotForDisplay`, reutilizado).
- Respuesta se interpreta con un parser cerrado nuevo (mismo patrón que `slot-selection-parser.ts`,
  no reutiliza ese parser porque el vocabulario es distinto): `"1"`, `"sí"`, `"si"`, `"confirmar"`,
  `"cancelar"` → confirma. `"2"`, `"no"`, `"conservar"` → revierte. **Cualquier otra cosa → se trata
  como "no confirma todavía", nunca como cancelación** (satisface "no cancelar con frase ambigua"),
  reenviando el mismo mensaje de confirmación (mismo patrón que `buildInvalidSelectionMessage`).
- Confirmado ("1"):
  1. `idempotencyKey = whatsapp-cancel:{leadId}:{appointmentId}`.
  2. CAS `UPDATE appointments SET status='CANCELLED' WHERE id=$id AND status='BOOKED'` — **primero**,
     antes de tocar Calendar (ver razón abajo).
  3. `deleteEvent(calendarEventId)` — 404/410 tratado como éxito, igual que en reagendado.
  4. Lead `CANCEL_PENDING → CANCELLED`.
  5. `conversation.status` sin cambio (sigue `ACTIVE` — a diferencia de opt-out/handoff, cancelar
     una cita no cierra la conversación).
  6. Mensaje de confirmación.

**Por qué DB-antes-que-Calendar responde directamente la pregunta del prompt** ("retry si DB update
falla después del delete"): con este orden, ese escenario no puede ocurrir por construcción — el
delete de Calendar nunca corre antes de que el UPDATE de DB haya tenido éxito. Si el UPDATE falla,
no se intenta el delete (se reintenta el UPDATE, CAS-seguro). El único fallo asimétrico posible es
"DB OK, Calendar delete falla" — ya cubierto: DB es la fuente de verdad, Calendar queda como
limpieza diferida documentada, nunca bloquea la confirmación al lead.

- No confirmado / ambiguo: mensaje "tu cita se mantiene" + `CANCEL_PENDING → BOOKED`, sin tocar
  datos de la cita.

---

## 8. Recordatorios — arquitectura

Evaluación A–D pedida:

- **A (cron interno / setInterval en el proceso Node): descartado** — explícitamente lo que el
  prompt pide evitar; no sobrevive un reinicio/redeploy del único proceso Fastify.
- **C (worker separado): descartado para HOY** — infraestructura nueva (proceso adicional,
  despliegue adicional) para un volumen de un solo asesor; sobre-ingeniería en este punto.
- **B (Supabase scheduled job / pg_cron) vs D (automatización externa): se recomienda D**, con la
  lógica viviendo en TypeScript, no en SQL.

**Recomendación concreta:** un disparador externo (cron de la plataforma de hosting, o si no hay
uno nativo disponible, un GitHub Actions scheduled workflow) que llama cada 15 minutos a un nuevo
endpoint interno protegido (`POST /internal/reminders/run`, mismo patrón de secreto estático que
§6/administración). Toda la lógica de selección/envío/dedup vive en un `ReminderService` de
TypeScript nuevo, reutilizando `MessagingProvider`, `MessageRepository`, `formatSlotForDisplay`, y
el patrón CAS/staleness de `booking_attempts`. Razón: mantiene el "cerebro" de recordatorios en el
mismo lenguaje/test-suite/logging que todo lo demás en este repo (coherente con cómo se usó la RPC
de Postgres SOLO para atomicidad y nunca para lógica en Phase 3C) — pg_cron+pg_net sería un segundo
mecanismo de scheduling, más difícil de observar y probar, sin necesidad real a este volumen. Si
más adelante se prefiere no depender de un scheduler externo, pg_cron es la alternativa válida —
mismo endpoint, sin cambios de lógica.

Cada tick es una barrida sin estado sobre la DB — nunca depende de que el proceso lleve vivo 24h.

### 8.1 Lógica de la barrida (por tipo REMINDER_24H / REMINDER_2H)

```
SELECT a.*, l.status as lead_status FROM appointments a JOIN leads l ON l.id = a.lead_id
WHERE a.status = 'BOOKED'
  AND a.starts_at > now()
  AND a.starts_at <= now() + interval '24 hours'   -- (o '2 hours' para el otro tipo)
  AND l.status NOT IN ('DO_NOT_CONTACT','HUMAN_HANDOFF')   -- HUMAN_HANDOFF: extensión propia,
                                                             -- justificada abajo
  AND NOT EXISTS (
    SELECT 1 FROM appointment_message_deliveries d
    WHERE d.appointment_id = a.id AND d.delivery_type = 'REMINDER_24H' AND d.status IN ('PENDING','SENT')
  )
```

Nota: se agrega `HUMAN_HANDOFF` a la exclusión aunque el prompt solo pidió `DO_NOT_CONTACT`
explícitamente — un lead en medio de una escalación a Héctor no debería recibir un recordatorio
automático genérico; se documenta como extensión deliberada, no silenciosa.

Por cada fila due: `INSERT ... ON CONFLICT DO NOTHING` en `appointment_message_deliveries`
(gana la primera barrida que llega, exactamente como `booking_attempts.create()`) → si ganó, envía
WhatsApp (reutiliza `MessagingProvider.sendText` + persiste como mensaje OUTBOUND, mismo patrón que
`sendAndPersistReply` pero sin un inbound que lo dispare — variante nueva y pequeña) → marca `SENT`.
Si falla el envío: `FAILED`, reintentable por la siguiente barrida vía el mismo
`claimTransition`-style CAS con un umbral de staleness propio (`REMINDER_PENDING_STALE_THRESHOLD_MS`,
deliberadamente NO comparte constante con `PENDING_STALE_THRESHOLD_MS`, mismo principio ya aplicado
a `OFFER_CLAIM_STALE_THRESHOLD_MS`).

Timezone: se reutiliza `formatSlotForDisplay`/`zonedTimeParts` con `config.ADVISOR_TIMEZONE` —
cero lógica de timezone nueva.

---

## 9. No-show — diseño (minimizando falsos NO_SHOW)

**Nunca automático.** Un timeout (p.ej. `starts_at` + 45 min con `status` aún `BOOKED`) dispara
únicamente un *nudge* interno a Héctor (mismo canal que §10 handoff), nunca cambia `status`. El
cambio real a `COMPLETED` o `NO_SHOW` solo ocurre por acción explícita de Héctor vía dos endpoints
administrativos nuevos:

```
POST /api/appointments/:id/mark-completed
POST /api/appointments/:id/mark-no-show
```

Protegidos con un secreto estático por header (`x-admin-token`, comparado con
`timingSafeEqualStrings`, mismo mecanismo ya usado para `WHATSAPP_VERIFY_TOKEN`) — mínimo viable
dado que hoy no existe ninguna autenticación de administrador en el proyecto (ver §1). Ambos:
CAS `status='BOOKED' → 'COMPLETED'|'NO_SHOW'`, `actor='HECTOR'` en `appointment_status_history`,
lead `BOOKED/CONFIRMED → MEETING_COMPLETED|NO_SHOW`.

Tras `NO_SHOW`: mensaje opcional al lead (una sola vez, disparado por la propia transición, no por
un job separado). Retorno a booking: cualquier respuesta del lead en estado `NO_SHOW` transiciona
`NO_SHOW → BOOKING_PENDING` y entra directo al `WhatsAppBookingHandler` ya existente — sin
recalificar (el lead ya tiene `productInterest`/`score` de antes), sin loop porque es exactamente
el mismo flujo de oferta ya usado por booking normal.

---

## 10. Follow-up post-cita

Reutiliza `appointment_message_deliveries` (`delivery_type='POST_MEETING_FOLLOWUP'`), misma barrida
que recordatorios. `scheduled_for = appointment.endsAt + 3h` si cae dentro de horario laboral
(`config.WORKDAY_START/WORKDAY_END`, reutilizado, sin lógica nueva de horario laboral), si no, el
siguiente día hábil a una hora fija (10:00 `ADVISOR_TIMEZONE`). Se dispara solo cuando
`appointments.status = 'COMPLETED'` (nunca para `NO_SHOW`). Mismas exclusiones que recordatorios
(`DO_NOT_CONTACT`, `HUMAN_HANDOFF`).

---

## 11. Human handoff — diseño consistente

Se extiende (no se duplica) `qualification-handoff-triggers.ts`: mismo `HandoffReason` union y
mismo `detectHandoffTrigger`, agregando razones nuevas para Phase 4:
`BOOKING_INCONSISTENCY` (de `ActiveOfferInconsistentError`/`BookingAttemptInconsistentError`,
programático, no por texto), `RESCHEDULE_INCONSISTENCY`, `CANCELLATION_INCONSISTENCY`.

**Estado exacto al escalar:** `lead.status → HUMAN_HANDOFF`, `conversation.status → HUMAN_HANDOFF`
(patrón ya existente), fila en `lead_status_history` con `reason_code` = el `HandoffReason`.

**Canal de aviso inicial a Héctor — recomendación: WhatsApp al propio número de Héctor**, vía la
misma `MessagingProvider` ya integrada y probada (`sendText` a un nuevo
`ADVISOR_NOTIFICATION_WHATSAPP_NUMBER` de `.env`). Se descarta email (no existe ninguna integración
de correo en el repo — sería infraestructura nueva) y dashboard (no existe ninguna UI administrativa
— fuera de alcance). Se reevalúa cuando el volumen supere lo manejable en un solo hilo de WhatsApp.

**Qué NO debe incluir la notificación:** el texto crudo del mensaje del lead (puede contener dato
clínico), cualquier `metadata`/payload en bruto. **Qué SÍ incluye:** nombre del lead, teléfono
(Héctor necesita poder llamar de vuelta — distinto del criterio de logs sanitizados, que existen
por higiene de logs de infraestructura, no aplica igual a una notificación dirigida al humano que
debe actuar), el `reason_code` (código cerrado, nunca texto libre), y el `leadId` como referencia.

---

## 12. Idempotencia / concurrencia — threat model

| # | RISK | EXPECTED BEHAVIOR | DB GUARD | APPLICATION GUARD | COMPENSATION |
|---|---|---|---|---|---|
| 1 | Doble "cancelar" | Solo la 1ª aplica; la 2ª ve "ya cancelada" | CAS `status='BOOKED'→'CANCELLED'` | idempotency key `whatsapp-cancel:{lead}:{appt}` | ninguna — CAS ya es idempotente |
| 2 | Dos selecciones simultáneas al reagendar | Una gana, crea 1 cita nueva; la otra ve "ya se actualizó" | mismo `booking_attempts` + CAS de cierre de la vieja (`WHERE status='BOOKED'`) | re-chequeo de `findActiveByLeadId` inmediatamente antes de `book()`, mismo patrón ya usado en `handleSelection` | si la perdedora ya creó evento Calendar antes de perder: borrar evento huérfano + cancelar su appointment recién creada |
| 3 | Reminder job ejecutado dos veces | Se envía una sola vez | `UNIQUE(appointment_id, delivery_type)` | crear-fila-antes-de-enviar (nunca al revés) | ninguna — el constraint lo previene estructuralmente |
| 4 | Worker/proceso reiniciado | El siguiente tick/reintento retoma sin duplicar | staleness CAS (`PENDING→FAILED→PENDING`), mismo patrón que `claimExistingAttempt` | reutiliza el mismo helper, no uno nuevo | la propia reclamación es la recuperación |
| 5 | Google timeout tras crear/update/delete | Nunca se asume éxito sin confirmación persistida | la fila dueña (`booking_attempts`/`appointment_message_deliveries`) queda PENDING hasta confirmación real | `deleteEvent` idempotente-seguro en 404/410 (§5); `createEvent`-timeout-luego-reintento sigue siendo un riesgo residual **preexistente**, no nuevo de Phase 4 — documentado, no resuelto aquí | ninguna nueva para create (riesgo heredado); ninguna necesaria para delete (ya idempotente) |
| 6 | DB failure después de operación de Google | Compensación ya probada de `completeBooking` (borra evento si el insert falla); para cierre de cita vieja, imposible por construcción (DB va ANTES que delete) | — | orden DB-antes-que-Calendar (§6.1/§7) | borrar evento recién creado (ya existente, reusado) |
| 7/8 | WhatsApp retry / duplicate webhook (Meta) | Procesado exactamente una vez | `messages(channel, provider_message_id)` UNIQUE, ya existente | dedup check al inicio de `handleInboundWhatsAppText`, ya existente | ninguna nueva necesaria — cubierto hoy |
| 9 | Lead manda "1" dos veces (dos mensajes reales, no un solo webhook redelivered) | 2º "1" ve el estado ya cambiado, responde acorde | mismo CAS de cancelación/reagendado | ninguno nuevo — reusa 1/2 | ninguna nueva |
| 10 | Respuesta tardía a slot expirado | Rechazado igual que booking hoy | `offered_slots.expires_at` | `parseSlotSelection` (`expiresAt > now`), reusado sin cambios | ninguna |
| 11 | Slot viejo seleccionado tras nuevo round de reagendado | Rechazado — no está en `activeSlots` | `offered_slots` por ronda | `assertSingleActiveRound`/`parseSlotSelection`, reusados | ninguna |
| 12 | Cancelación en curso mientras reagendado en curso (o viceversa) | Quien complete su CAS primero gana; el otro detecta estado ya cambiado y responde acorde, nunca corrompe | ambos flujos hacen CAS `WHERE status='BOOKED'` sobre la MISMA fila appointment — mutuamente excluyentes por construcción | releer estado fresco inmediatamente antes de la escritura terminal, en ambos flujos (disciplina ya usada en `handleSelection`, debe aplicarse igual aquí) | el perdedor nunca revierte al ganador — solo informa al lead del estado real vigente |

---

## 13. Privacy

Verificado contra la regla existente (nunca texto clínico en storage): `lead_status_history` y
`appointment_status_history` usan `reason_code` cerrado (enum de strings fijos), nunca texto libre
ni el cuerpo del mensaje. `appointment_message_deliveries` guarda solo metadatos de entrega
(timestamps, `provider_message_id`), nunca el cuerpo (el cuerpo ya vive en `messages`, con el mismo
tratamiento que cualquier otro mensaje saliente hoy). La notificación de handoff a Héctor (§11) usa
`reason_code`, nunca el texto original del lead. Ningún nuevo log agrega payload crudo — mismo
patrón sanitizado (`leadId`/`conversationId`/`errorName`) ya establecido en todo el proyecto.

---

## 14. Feature flags

```
WHATSAPP_RESCHEDULE_ENABLED     default false
WHATSAPP_CANCELLATION_ENABLED   default false
APPOINTMENT_REMINDERS_ENABLED   default false
POST_MEETING_FOLLOWUP_ENABLED   default false
NO_SHOW_DETECTION_ENABLED       default false   -- (extensión propia, no pedida explícitamente:
                                                  -- gatea solo el *nudge* automático por timeout;
                                                  -- los endpoints administrativos mark-completed/
                                                  -- mark-no-show no necesitan flag, son inertes
                                                  -- hasta que Héctor los llama)
```

Mismo patrón zod que `WHATSAPP_BOOKING_ENABLED`: `z.preprocess((v)=>v==="true", z.boolean()).default(false)`
— nunca `z.coerce.boolean()`. Cada uno independiente, nunca reutiliza `WHATSAPP_BOOKING_ENABLED`:
son ramas de ruteo nuevas para un lead ya `BOOKED`, un estado que hoy cae al fallback silencioso —
deben poder activarse/desactivarse una por una durante el rollout sin acoplarse entre sí ni con el
booking original.

---

## 15. E2E plan

| | Precondiciones | Pasos | DB esperado | Calendar esperado | WhatsApp esperado | Cleanup |
|---|---|---|---|---|---|---|
| **E2E-4A** reschedule | Lead BOOKED real, appointment BOOKED real | "quiero reagendar" → elegir nuevo slot | 2 filas appointments (vieja RESCHEDULED, nueva BOOKED con `rescheduled_from`), `lead_status_history`+`appointment_status_history` con filas nuevas | evento nuevo existe, evento viejo borrado | mensaje inicio + lista de horarios + confirmación con nuevo link | `reset:test-lead` extendido para limpiar ambas filas de appointment |
| **E2E-4B** cancel | Lead BOOKED real | "cancelar mi cita" → "1" | appointment CANCELLED, lead CANCELLED | evento borrado | confirmación de cancelación con fecha/hora citada | igual |
| **E2E-4C** reminder | Appointment BOOKED con `starts_at` ~24h en el futuro (fixture, no esperar 24h real) | disparar barrida manualmente vía el endpoint interno | fila `appointment_message_deliveries` SENT | sin cambios | mensaje de recordatorio recibido | borrar fila de delivery |
| **E2E-4D** no-show | Appointment BOOKED con `starts_at` en el pasado (fixture) | `POST /api/appointments/:id/mark-no-show` con token admin | appointment NO_SHOW, lead NO_SHOW | sin cambios (evento de Calendar no se toca en no-show) | mensaje opcional enviado | reset |
| **E2E-4E** completed/follow-up | Appointment BOOKED pasado | `mark-completed` → disparar barrida de follow-up | appointment COMPLETED, delivery POST_MEETING_FOLLOWUP SENT | sin cambios | mensaje de follow-up recibido | reset |

Todos reutilizan y extienden `scripts/reset-test-lead.ts`/la RPC `reset_test_lead` (migración 012)
en vez de crear tooling nuevo — la RPC necesitará borrar también las 3 tablas nuevas, scopeadas por
`appointment_id IN (SELECT id FROM appointments WHERE lead_id=...)`.

---

## 16. Implementation slices — orden recomendado

| Slice | Contenido | Flag | Depende de | Riesgo |
|---|---|---|---|---|
| **4A** | Migraciones (3 tablas nuevas) + `LeadStatus`/`state-machine.ts` (CANCEL_PENDING/CANCELLED + aristas nuevas) + hook de `lead_status_history`/`appointment_status_history` en los choke points existentes (`transitionTo`, cierre de appointment) | ninguno (cero comportamiento nuevo visible) | — | mínimo — puro plumbing, sin rutas nuevas |
| **4B** | Cancelación completa + helper compartido `closeOutAppointment(id, terminalStatus, reasonCode)` (usado también por 4C) | `WHATSAPP_CANCELLATION_ENABLED` | 4A | bajo — flujo autocontenido, no reusa SlotOfferingService |
| **4C** | Reagendado completo (extiende `SlotOfferingService`, reusa `book()`, reusa `closeOutAppointment` de 4B) | `WHATSAPP_RESCHEDULE_ENABLED` | 4A, 4B | medio — el flujo más complejo |
| **4D** | Recordatorios (`appointment_message_deliveries`, `ReminderService`, endpoint interno, cron externo) | `APPOINTMENT_REMINDERS_ENABLED` | 4A | bajo-medio — nueva pieza de infraestructura (el cron externo) |
| **4E** | No-show: endpoints admin + nudge + extensión de `HandoffReason`/notificación WhatsApp a Héctor | `NO_SHOW_DETECTION_ENABLED` | 4A, §11 | bajo |
| **4F** | Follow-up post-cita (reusa 4D casi por completo) | `POST_MEETING_FOLLOWUP_ENABLED` | 4D, 4E | mínimo |

Cada slice: compila independiente, tests propios, flag en `false` por defecto, no rompe nada de
Phase 3C (verificado: ninguna ruta/handler existente cambia de comportamiento salvo agregar nuevas
ramas guardadas por flag), commit propio.

---

## 17. Migration plan

Una sola migración SQL nueva (`013_phase4_history_and_deliveries.sql`) cubre TODO el modelo de
datos de Phase 4 (las 3 tablas de §4) — no se requiere ninguna otra migración porque
`rescheduled_from`, y los valores nuevos de `status` en ambas tablas, ya son compatibles con el
esquema real sin cambios de columna ni de constraint. Se implementa en el slice 4A, se aplica a
Supabase real solo cuando el usuario lo autorice explícitamente (mismo procedimiento seguido para
las migraciones 010–012).

---

## 18. Risks / blockers

- **No existe autenticación de administrador hoy.** Los endpoints de §9/§11 necesitan como mínimo
  un secreto estático por header antes de poder existir en producción — no es un blocker para
  diseñar, sí para desplegar 4E de forma segura. Resuelto en el diseño (mismo patrón que
  `WHATSAPP_VERIFY_TOKEN`), pendiente de que el usuario confirme que ese nivel de protección es
  aceptable para producción o si prefiere algo más fuerte antes de 4E.
- **Plataforma de hosting no confirmada en el código** (`server.ts` es genérico). El diseño de
  recordatorios (§8) asume "algún cron externo puede pegarle a un endpoint HTTP" — funciona en
  cualquier plataforma, pero el mecanismo exacto (GitHub Actions vs cron nativo de la plataforma)
  debe confirmarse antes de implementar 4D.
- **Riesgo heredado, no nuevo:** un timeout de Google tras `createEvent` seguido de un reintento
  puede crear un evento duplicado si la llamada original sí llegó a completarse del lado de Google
  — esto ya existe hoy en `completeBooking` (Phase 3C), Phase 4 no lo agrava ni lo resuelve; se
  documenta para que quede explícito, no oculto.
- **`ADVISOR_NOTIFICATION_WHATSAPP_NUMBER`** (§11) es una variable de entorno nueva que debe
  añadirse a `.env` antes de que 4E pueda notificar realmente a Héctor — trivial, pero listado
  para no asumirlo implícito.

---

## 19. Explicit recommendation

**PHASE 4 GO** — el descubrimiento de §1 (gran parte del modelo de datos ya existe sin usar desde
Phase 1) reduce significativamente el riesgo y el alcance real de la migración de datos. El diseño
reutiliza en cada punto posible la maquinaria ya endurecida de Phase 3C (CAS ownership, staleness
reclaim, compensación Calendar-DB, SlotOfferingService, `sendAndPersistReply`,
`detectHandoffTrigger`) en vez de introducir mecanismos nuevos — la superficie de riesgo real
añadida es pequeña: 3 tablas, ~2 endpoints administrativos, 1 disparador de cron externo.

**Primer slice a implementar: 4A** (migraciones + state machine + hooks de auditoría). Es el único
slice sin ningún comportamiento de cara al usuario, cero riesgo de romper Phase 3C, y es la base
literal de la que dependen todos los demás — exactamente el tipo de primer paso "compila
independiente, tests propios, flag irrelevante porque no hay ruta nueva" que este proyecto ya
prefiere consistentemente al iniciar cada fase anterior.
