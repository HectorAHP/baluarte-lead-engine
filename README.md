# Baluarte Lead Engine

MVP de captación, calificación y agendamiento para Baluarte Capital.

## Sprint 1
`Lead manual -> Router -> Qualification -> Score -> Google Calendar -> Google Meet`

## Inicio
```bash
cp .env.example .env
npm install
npm run typecheck
npm test
npm run dev
```

## Endpoints
- `GET /health`
- `POST /api/leads`
- `GET /api/leads/:id`
- `POST /api/leads/:id/contact`
- `POST /api/leads/:id/qualification/start`
- `POST /api/leads/:id/score`
- `GET /api/availability`
- `GET /api/appointments/:id`
- `POST /api/appointments` — requiere header `Idempotency-Key`
- `GET /webhooks/whatsapp` — verificación de suscripción de Meta
- `POST /webhooks/whatsapp` — eventos entrantes de WhatsApp (requiere `X-Hub-Signature-256` válido)

## Google Calendar

Sin `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN` en `.env`, el servidor usa `FakeCalendarProvider` (en memoria) automáticamente — no hace falta nada para desarrollar o correr los tests. Para conectar el Google Calendar real de Héctor, ver [docs/GOOGLE-CALENDAR-SETUP.md](docs/GOOGLE-CALENDAR-SETUP.md).

## WhatsApp (Sprint 2 Phase 2)

Transporte + persistencia únicamente — todavía no hay calificador conversacional. Sin las cuatro variables `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/`WHATSAPP_VERIFY_TOKEN`/`META_APP_SECRET`, el servidor usa `FakeMessagingProvider` automáticamente. Ver [docs/WHATSAPP-ARCHITECTURE.md](docs/WHATSAPP-ARCHITECTURE.md) para el diseño completo (verificación de webhook, validación de firma, idempotencia, resolución de leads, redacción de salud sensible, opt-out).
