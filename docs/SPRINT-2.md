# Sprint 2 checklist

## Phase 1 — Production persistence
- [x] ConversationRepository / MessageRepository / QualificationAnswerRepository / LeadScoreRepository / OfferedSlotRepository (Supabase + in-memory)
- [x] Phone normalization to E.164 (`libphonenumber-js`)
- [x] Lead dedup by metaLeadId → whatsappUserId → phoneE164 → email
- [x] Qualification field whitelist enforced in code (`QualificationService`)
- [x] Sensitive-health redaction boundary (`persistInboundMessage`)
- [x] Lifecycle timestamps: `created_at`, `first_contact_at`, `qualified_at`, `booked_at` wired; `first_response_at`, `booking_started_at`, `meeting_at`, `closed_at` reserved until a real triggering event exists
- [x] Migrations 003–007 written, reviewed, applied to the real Supabase project
- [x] Real Supabase persistence validated end-to-end (leads, appointments, booking attempts, score history all survive a full server restart)

## Phase 2 — WhatsApp Cloud API (transport + persistence only)
- [x] `GET /api/appointments/:id` (added as prerequisite, with tests)
- [x] `MessagingProvider` port + `FakeMessagingProvider` + `MetaWhatsAppProvider`
- [x] WhatsApp/Meta env config (`hasWhatsAppCredentials`, analogous to Google/Supabase selection)
- [x] `GET /webhooks/whatsapp` verification
- [x] `POST /webhooks/whatsapp` — signature validation, idempotent ingestion, unsupported-type handling
- [x] Message dedup by `(channel, providerMessageId)`
- [x] Lead resolution (whatsapp_user_id → phone_e164 → new), including the WhatsApp Mexico `wa_id` phone quirk
- [x] Conversation resolution (find-active-or-create)
- [x] Health privacy boundary wired into the WhatsApp flow (redact + handoff)
- [x] Deterministic do-not-contact detection
- [x] Deterministic welcome message (not the qualifier)
- [x] Outbound send + persistence, including failure handling
- [x] `requestHumanHandoff` / `requestDoNotContact` / `recordInboundContact` as named `LeadService` methods
- [x] 173/173 tests passing, all against fakes — no test sends a real WhatsApp message

## Not started (explicitly out of scope for Phase 2)
- [ ] Conversational qualifier (Phase 4)
- [ ] PATRIMONIAL / GMM playbooks (Phase 5/6)
- [ ] Booking through chat (Phase 7)
- [ ] Meta Lead Ads
- [ ] Real queue for webhook processing (currently an awaited in-process boundary — see `docs/WHATSAPP-ARCHITECTURE.md`)
- [ ] Connecting a real WhatsApp phone number / production Meta webhook configuration
