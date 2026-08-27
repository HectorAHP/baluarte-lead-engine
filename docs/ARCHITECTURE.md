# Architecture — Sprint 1

## Objetivo
Crear el núcleo del Baluarte Lead Engine sin WhatsApp ni Meta todavía.

## Flujo
1. Crear lead manual.
2. Identificar vertical.
3. Capturar datos de calificación.
4. Calcular score determinístico.
5. Consultar disponibilidad.
6. Crear cita.
7. Crear Google Meet.
8. Persistir datos.

## Principios
- Strict TypeScript.
- Zod en frontera HTTP.
- Idempotencia en operaciones externas.
- Lógica de negocio fuera de handlers.
- LLM nunca controla directamente el estado.
- Secrets solo backend.

## Calendar architecture

`CalendarProvider` (puerto en `src/application/ports.ts`) tiene dos implementaciones:

- `FakeCalendarProvider` — en memoria, usada en tests y en dev sin credenciales de Google.
- `GoogleCalendarProvider` — OAuth2 + Google Calendar API v3. `server.ts` la selecciona automáticamente sólo si `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `GOOGLE_REFRESH_TOKEN` están las tres presentes; si falta cualquiera, usa `FakeCalendarProvider`. Los tests nunca dependen de credenciales reales.

La disponibilidad se calcula así:

1. `src/domain/availability.ts` (puro, sin I/O) aplica las reglas de negocio: horario laboral (`WORKDAY_START`/`WORKDAY_END`, timezone `ADVISOR_TIMEZONE`), aviso mínimo (`BOOKING_MIN_NOTICE_HOURS`), horizonte máximo (`BOOKING_MAX_DAYS_AHEAD`), duración solicitada, y devuelve máximo 3 slots ordenados cronológicamente.
2. `GoogleCalendarProvider.getAvailableSlots` obtiene los periodos ocupados vía `calendar.freebusy.query` (nunca listando eventos crudos) y se los pasa a `computeAvailableSlots`.
3. `src/domain/timezone.ts` hace la conversión wall-clock ↔ UTC para `ADVISOR_TIMEZONE` usando `Intl.DateTimeFormat` (sin dependencia externa; correcto incluso si la zona tuviera DST).

`createEvent` siempre revalida `isSlotAvailable` inmediatamente antes de insertar el evento (no confía únicamente en el chequeo previo del caller) y lanza `SlotUnavailableError` si el slot ya no está libre. La conferencia de Meet se crea con `conferenceDataVersion: 1` y un `requestId` único por intento (`randomUUID()` en cada llamada a `createEvent`). Si la creación de la conferencia queda `pending` (sin `hangoutLink` ni `entryPoints` todavía), `createEvent` no lanza — devuelve `meetingUrl: undefined` en vez de fallar.

## Booking idempotency

`POST /api/appointments` requiere un header `Idempotency-Key` (validado por Zod; su ausencia es un 400). `AppointmentService.book` (`src/application/services.ts`):

1. Calcula un fingerprint SHA-256 del payload relevante (`leadId`, `title`, `description`, `start`, `end`, `attendeeEmail`).
2. Busca un `BookingAttempt` existente por `idempotencyKey` (tabla `booking_attempts`, migración `002_booking_idempotency_and_locking.sql`).
   - Mismo key + mismo fingerprint + ya `COMPLETED` → devuelve la cita ya creada (no llama a Google de nuevo).
   - Mismo key + fingerprint distinto → `IdempotencyConflictError` (409).
   - Key nueva → crea un `BookingAttempt` `PENDING` y continúa.
3. Si el intento ya tiene `providerEventId` (de un intento previo que creó el evento de Google pero no llegó a persistir la cita — p. ej. el proceso murió a la mitad), reutiliza ese evento en vez de crear uno nuevo en Google.

Esto cierra el caso más común de duplicado (reintentos de red del cliente con el mismo key) sin depender de que Google Calendar API tenga su propio mecanismo de idempotencia para `events.insert` (no lo tiene; el `requestId` de `conferenceData.createRequest` sólo deduplica la *conferencia*, no el evento).

**Límite conocido:** si el proceso muere *después* de `calendar.createEvent` pero *antes* de guardar `providerEventId` en `booking_attempts` (una ventana de una sola escritura), un reintento con el mismo key no encontrará el evento previo y creará uno nuevo en Google — un evento huérfano sin cita asociada. Mitigarlo por completo requeriría una transacción distribuida entre Postgres y la API de Google, que no existe. El resto de esta cadena (marcar `FAILED`, seleccionar el evento existente, best-effort `deleteEvent` de compensación) sí cubre todos los demás casos de fallo a mitad de camino.

## Double-booking protection

Dos leads distintos pueden intentar reservar el mismo horario al mismo tiempo (dos `Idempotency-Key` distintas, no es un problema de idempotencia). La protección real vive en la base de datos, no en memoria de proceso:

```sql
alter table appointments add column time_range tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored;
alter table appointments add constraint appointments_no_overlap exclude using gist (time_range with &&) where (status <> 'CANCELLED');
```

Un *exclusion constraint* de Postgres garantiza, de forma atómica, que nunca existan dos citas activas con rangos de tiempo solapados — incluso si ambas peticiones pasaron su propio chequeo de `freeBusy` (que tiene una ventana de carrera inherente: la lectura de Google no es instantánea ni transaccional con la escritura en Postgres). El `INSERT` perdedor recibe `SQLSTATE 23P01` (`exclusion_violation`), que `SupabaseAppointmentRepository.create` traduce a `SlotUnavailableError`. `AppointmentService` responde a ese error borrando (best-effort) el evento de Google que el perdedor ya había creado, para no dejar invitaciones huérfanas en el calendario de Héctor.

`InMemoryAppointmentRepository` implementa el mismo chequeo de solapamiento en JS para que el mismo comportamiento sea testeable sin Postgres — pero esto **sólo es seguro dentro de un mismo proceso Node** (correcto para tests/dev de un solo proceso gracias al single-threading de JS); no ofrece ninguna garantía si se corrieran varias instancias del servidor en memoria. La garantía real de producción es el exclusion constraint, no el repositorio en memoria.

**Límite conocido:** el exclusion constraint protege la tabla `appointments`, asumiendo un único calendario/asesor (no hay columna `advisor_id`) — correcto para el alcance actual (Héctor es el único asesor). No protege eventos huérfanos en Google Calendar del lado perdedor de la carrera antes de que `deleteEvent` corra (best-effort: si el `deleteEvent` de compensación también falla, queda un evento de Google sin cita asociada en la base de datos; se loguea pero no bloquea la respuesta de error al cliente).

## App factory (`src/app.ts`)

Desde Sprint 2 Phase 2, `server.ts` ya no construye el servidor Fastify directamente — es un bootstrap de dos líneas que llama a `buildApp()` (`src/app.ts`) y luego `.listen(...)`. `buildApp(overrides?)` construye y registra toda la app (CORS, parser JSON con captura de raw body, todas las rutas, error handler) pero nunca llama `.listen()`, y acepta un objeto de overrides para cada repositorio/provider. Esto existe para que las rutas HTTP sean testeables con `app.inject()` (usado extensamente por los tests de webhooks de WhatsApp) sin abrir un puerto real ni depender de qué haya en `.env` — `tests/helpers/test-app.ts` siempre pasa un set completo de repos/providers en memoria, precisamente porque `.env` en este proyecto puede (y en etapas posteriores, sí) contener credenciales reales de Supabase/Google/Meta.

## WhatsApp

Ver [docs/WHATSAPP-ARCHITECTURE.md](WHATSAPP-ARCHITECTURE.md) para el diseño completo del transporte de WhatsApp (Sprint 2 Phase 2): verificación de webhook, validación de firma HMAC, límite ingestión/procesamiento, idempotencia por `(channel, providerMessageId)`, resolución de leads, redacción de salud sensible, y detección de opt-out.
