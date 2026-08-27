# Sprint 1 checklist

- [x] Estructura inicial
- [x] Entidades base
- [x] Estados de lead
- [x] State machine
- [x] Scoring Patrimonial
- [x] Scoring GMM
- [x] Contratos de repositorio
- [x] Contrato CalendarProvider
- [x] API base Fastify
- [x] Migración inicial Supabase
- [x] Unit tests de scoring
- [x] Supabase repositories
- [x] GoogleCalendarProvider
- [x] Qualification orchestration
- [x] Booking idempotency
- [x] Double-booking protection
- [ ] E2E con cita real (bloqueado: faltan credenciales Google de Héctor)

## Qualification orchestration

`LeadService` ahora enruta todo cambio de estado a través de `assertTransition`:

```
NEW → CONTACTED → QUALIFYING → QUALIFIED_A / QUALIFIED_B / NURTURE_C
```

- `markContacted(id)` — NEW/CONTACT_PENDING → CONTACTED.
- `startQualification(id)` — CONTACTED → QUALIFYING.
- `scorePatrimonialLead(id, input)` / `scoreGmmLead(id, input)` — calculan el score determinístico y sólo persisten si `QUALIFYING → QUALIFIED_A|QUALIFIED_B|NURTURE_C` es una transición válida.

Un lead que salta un paso (p. ej. `NEW → QUALIFIED_A` directo) lanza `InvalidLeadTransitionError` (HTTP 409) y no se persiste. Un `leadId` inexistente lanza `LeadNotFoundError` (HTTP 404). No existe ningún `setStatus` genérico — todo cambio de estado pasa por un método de aplicación explícito.

Endpoints nuevos: `POST /api/leads/:id/contact`, `POST /api/leads/:id/qualification/start`.

## Google Calendar y booking hardening

`GoogleCalendarProvider` ([src/infrastructure/google-calendar-provider.ts](../src/infrastructure/google-calendar-provider.ts)) implementa `CalendarProvider` usando OAuth2 (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`) contra `GOOGLE_CALENDAR_ID`. `server.ts` lo selecciona automáticamente cuando las tres credenciales están presentes; si falta cualquiera, cae a `FakeCalendarProvider` (el mismo que usan los tests — nunca se eliminó). Disponibilidad vía `freebusy.query` (nunca listado crudo de eventos), reglas de negocio (horario laboral, aviso mínimo, horizonte máximo, máx. 3 slots) viven en `src/domain/availability.ts` — puras, sin I/O, testeadas sin credenciales.

Detalle completo de idempotencia y protección contra doble-booking: ver `docs/ARCHITECTURE.md`.
