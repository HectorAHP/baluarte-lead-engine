# WhatsApp architecture — Sprint 2 Phase 2

Transport + persistence only. No conversational qualifier, no AI, no Meta Lead Ads. Never write real tokens into this file — see `.env.example` for the variable names.

## Provider selection

`MessagingProvider` (`src/application/ports.ts`) has two implementations, selected the same way `CalendarProvider` already is:

- `FakeMessagingProvider` — in-memory, records every send. Used in all tests and in dev without WhatsApp credentials.
- `MetaWhatsAppProvider` — real WhatsApp Cloud API via `fetch`. Selected automatically only when `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, and `META_APP_SECRET` are **all** present (`hasWhatsAppCredentials` in `src/config.ts`). Missing any one falls back to `FakeMessagingProvider` — the server always boots, and no test can accidentally reach Meta.

No Meta-specific concept (wa_id, Graph API shapes, template categories) appears in `MessagingProvider`, `LeadService`, or `handleInboundWhatsAppText` — those live only inside `MetaWhatsAppProvider` and the webhook payload parser.

## Request flow

```
Meta → GET /webhooks/whatsapp   (one-time subscription verification)
Meta → POST /webhooks/whatsapp  (every inbound event)
         │
         ├─ signature check (X-Hub-Signature-256, HMAC-SHA256 over the RAW body)
         │    fails closed: no META_APP_SECRET configured → 401, always
         │
         ├─ parse payload (src/domain/whatsapp-webhook-payload.ts, pure, zod-validated)
         │    unrecognized-but-signed shape (e.g. a status callback) → 200, no-op
         │
         └─ per message:
              unsupported type (audio/image/video/document/location/reaction/interactive)
                → logged, skipped, never crashes
              text
                → handleInboundWhatsAppText() (src/application/whatsapp-inbound-service.ts)
```

### Raw body capture for signature verification

Meta signs the exact raw bytes it sent. Fastify's default JSON parser only exposes the parsed object, and re-serializing it can byte-differ (whitespace, key order) from what Meta actually signed — that would make genuinely valid signatures fail. `app.ts` overrides the `application/json` content-type parser to stash the raw `Buffer` on `req.rawBody` before parsing, with identical parsing behavior for every other route.

### Ingestion vs. processing boundary

```
validate signature → idempotent ingestion → persist → processing → ack Meta
                      (dedup, lead/conversation
                       resolution, message persist)
```

Everything up through message persistence happens before any reply is attempted. Reply-decision-and-send runs through `runProcessingBoundary()` (`src/application/processing-boundary.ts`), which catches and logs any failure there without ever invalidating the already-ingested inbound message.

**Limitation, stated plainly:** this is not a real queue. Phase 2 has no slow work (no AI call, no Calendar call) — the only network call is the WhatsApp send itself — so `runProcessingBoundary` currently just awaits the work synchronously rather than truly deferring it. This keeps behavior deterministic and testable now. It is the exact seam where a later phase (the AI qualifier, which *will* be slow) would swap in a real queue or a `setImmediate` fire-and-forget, without any caller needing to change.

## Message idempotency

Same mechanism as internal messaging (Phase 1): dedup key is `(channel, providerMessageId)`, not `providerMessageId` alone. For a duplicate webhook delivery, `handleInboundWhatsAppText` finds the existing message via `MessageRepository.findByProviderMessageId("WHATSAPP", id)` and returns immediately — no second lead, no second message, no second reply. The webhook still acknowledges 200, so Meta doesn't retry.

## Lead resolution

Priority order (reusing `LeadRepository.findByDedupKey`, unchanged from Phase 1): `whatsapp_user_id` → `phone_e164`. If neither matches, a new lead is created with `source: "WHATSAPP"`, `whatsappUserId`, and the normalized phone. Product vertical is deliberately left `UNKNOWN` — Phase 2 has no qualifier to determine it yet.

### Phone normalization: the WhatsApp Mexico `wa_id` quirk

WhatsApp's `wa_id` for Mexican numbers is `"52" + "1" + <10-digit number>` (e.g. `5214771234567`) — a legacy WhatsApp Business API convention. True E.164 for Mexico dropped that extra `"1"` in the 2019 national numbering reform, so a naive parse of the raw `wa_id` is **invalid** E.164 and `normalizePhoneToE164` would return `null`. `src/domain/phone.ts` detects this specific shape (`521` + 10 digits) and retries without the `"1"` before giving up. Verified against real WhatsApp Cloud API webhook payload conventions; covered by `tests/phone.test.ts`.

### `first_contact_at` / `first_response_at` semantics

`LeadService.recordInboundContact(id)`:

- **Brand-new lead (status `NEW`):** the inbound message is simultaneously their first contact *and* first response — both timestamps are set together, alongside the `NEW → CONTACTED` transition.
- **Already-contacted lead** (created manually, via Meta Lead Ads, or Héctor reached out first through another channel): only backfills `first_response_at` if it was never set. Status and `first_contact_at` are left untouched — this isn't a new contact event, just their first reply.

## Conversation resolution

`ConversationRepository.findActiveByLeadId(leadId)` — if none, create `{channel: "WHATSAPP", status: "ACTIVE"}`. All inbound/outbound messages for that lead thread through the same conversation until it's closed (opt-out) or handed off (sensitive health).

## Health privacy boundary

Unchanged from Phase 1 (`src/domain/health-redaction.ts`, `src/application/message-ingestion.ts`) and mandatory here too: every inbound message passes through `persistInboundMessage`, which redacts sensitive health text before it ever reaches `messages.body`, and never touches `qualification_answers` at all (structural guarantee, not a runtime check). When sensitive content is detected, the webhook flow additionally:

1. Calls `LeadService.requestHumanHandoff(leadId)` — a state-machine-valid transition, not an arbitrary status write.
2. Sets `conversation.status = "HUMAN_HANDOFF"`.
3. Sends the fixed neutral response (no medical interpretation, no further automated qualification) and never sends anything else automated until a human resumes it — checked via `wasAlreadySuppressed` on every subsequent inbound message.

## Do-not-contact detection

`src/domain/opt-out-detection.ts` — plain regex against a fixed phrase list, deliberately **not** LLM-based (a missed opt-out is a compliance failure an LLM could get wrong or have prompt-injected into agreeing not to honor). Some patterns (`baja`, `stop`, `detener`) are intentionally broad — over-flagging is the acceptable failure mode here, same principle as health-redaction.

On detection: `LeadService.requestDoNotContact(leadId)`, `conversation.status = "CLOSED"`, one confirmation message sent, then silence — enforced the same way as the handoff case (`wasAlreadySuppressed` check on every later message).

## Outbound send behavior

`sendAndPersistReply` in `whatsapp-inbound-service.ts`: on `sendText` success, persists the outbound message with the real `providerMessageId` Meta returned, `aiGenerated: false`. On failure, logs a sanitized warning (`{leadId, conversationId, reason}` — never the Graph API response body or the access token) and returns without persisting a phantom "sent" message. The webhook still acknowledges Meta 200 in both cases — the inbound message that triggered the reply was already safely ingested before the reply was ever attempted, and a failed reply is not Meta's problem to retry.

No automatic retry loop exists yet, as scoped.

## Human handoff

`LeadService.requestHumanHandoff(id)` — a named application method (not an arbitrary `setStatus`), validated through `assertTransition` like every other status change in this codebase. Throws `InvalidLeadTransitionError` from states where handoff isn't a valid target (e.g. already `BOOKED`); the webhook handler catches this inside `runProcessingBoundary` and logs it rather than crashing.
