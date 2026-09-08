# Fase 7K — Sandler Booking Flow + Weekly Slot Diversity

Branch: `feature/sandler-booking-flow` (from `a0450d0`). Final commit: `16c3dd8`. Pushed to
`origin/feature/sandler-booking-flow`. **No merge. No deploy. No production writes at any point.**

## 1. Product goal

Before this phase, `WhatsAppBookingHandler`/`WhatsAppRescheduleHandler` always offered the first
3 chronological slots of the earliest available day, and booked immediately on a numeric
selection. This phase adds three things, in order, without touching booking correctness:

1. **Daypart preference** — ask morning/afternoon before offering, unless already known.
2. **Weekly slot diversity** — when no explicit date/weekday was given, spread the 3 offered
   options across up to 3 distinct days instead of always showing the same day's slots.
3. **Sandler commitment check** — after a slot is chosen, ask a neutral, non-manipulative
   question ("¿hay algo que pudiera impedirte conectarte...?") before ever touching Calendar;
   only a CONFIRMED reply proceeds to the existing booking/reschedule pipeline.

Target flow: `INTENT TO BOOK → DAYPART PREFERENCE → DIVERSE SLOT OFFER → SLOT SELECTION →
SANDLER COMMITMENT CHECK → FINAL CALENDAR REVALIDATION → BOOKING → CONFIRMATION`.

## 2. Architecture — new files

| File | Role |
| --- | --- |
| `src/domain/slot-diversity.ts` | Pure `selectDiverseSlots(slots, maxSlots, timezone)` — one slot per distinct local date, chronological, fills from remaining slots when fewer than `maxSlots` distinct dates exist. |
| `src/domain/daypart-preference-detection.ts` | Pure `parseDaypartReply(text)` — accepts "1"/"mañana"/"por la mañana"/"temprano" → MORNING, "2"/"tarde"/"por la tarde" → AFTERNOON. Deliberately separate from `date-preference-parser.ts`, which keeps its own unchanged "mañana = tomorrow" semantics — the two never collide because this parser only ever runs while a daypart question is actually pending. |
| `src/domain/booking-commitment-detection.ts` | Pure `classifyCommitmentReply(text)` → CONFIRMED / OBSTACLE / AMBIGUOUS, per the spec's exact word lists. Note: "seguro" (listed as a CONFIRMED word) collides with this business's own product name ("seguro" = insurance) — matched only as a bare/exact reply, never as a substring, so a genuine question like "¿cuánto cuesta el seguro de auto?" is never misread as a confirmation. |
| `src/domain/booking-flow-state.ts` | Persistent `AWAITING_DAYPART_PREFERENCE` / `AWAITING_BOOKING_COMMITMENT` state, reusing the exact `metadata.expectedIntent` convention `qualified-lead-menu-state.ts` already established — no migration, no new table. Distinct marker namespace from the qualified-menu's own markers. |
| `src/application/booking-commitment-flow.ts` | Shared, mode-agnostic (BOOKING/RESCHEDULE) flow logic: `offerWithDaypartGate`, `handleDaypartReply`, `initiateCommitmentCheck`, `handleCommitmentReply`. Reused verbatim by `WhatsAppBookingHandler`, `WhatsAppRescheduleHandler`, and (via their own `startNewBooking`) `WhatsAppPastBookedRecoveryHandler` and `WhatsAppReactivationHandler`. |

## 3. Key design decisions

### 3.1 The lead must transition to BOOKING_PENDING at the daypart question, not at the offer

`offerWithDaypartGate`'s "ask the question" branch calls `SlotOfferingService.ensureOfferableLeadStatus`
(promoted from `private` to `public` for this) **before** sending the question. Discovered via a
real routing bug during implementation: without this, a lead answering the daypart question would
still be sitting on `QUALIFIED_A`/`CANCELLED`/etc, and `whatsapp-inbound-service.ts`'s
status-based routing would send that answer to the wrong handler (e.g. back to the qualified-lead
menu) instead of into this same booking flow.

### 3.2 Daypart is inherited across a mid-round date-only change (sections 3/23)

"Mejor el sábado" (no daypart mentioned) while a MORNING round is active never re-asks — the
daypart is derived from the active round's own slots (`resolveDaypartForSlot`, no separate
persistence) and carried into the replacement offer. Only a message that itself changes the
daypart, or the very first offer of an episode (nothing to inherit from), reaches the question.

### 3.3 A date-only reply while awaiting daypart is never misread as unrelated content

"Mejor domingo" in response to the daypart question doesn't answer it, but does carry a date —
`handleDaypartReply` re-parses it with `parseDatePreference` and, if a date is found, updates the
pending question's target date/weekday and asks again, instead of running it through the
stays-generic/escalate classifier (which would otherwise misclassify it and escalate a perfectly
sensible follow-up).

### 3.4 Section 21 vs 22 — "otro horario" keeps the day, "otro día" excludes it

`resolveDatePreferenceForRound(activeSlots, timezone)` derives both daypart and (when every active
slot already shares one local date) `targetDate` from the currently active round. A plain DECLINED
reply ("otro horario"/"ninguno") reuses this to keep the same day. "Otro día"/"otros días"
(recognized via the new `isOtherDayDeclineRequest` predicate, added to `DECLINED_PHRASES`) does the
opposite: drops the inferred `targetDate` and instead sets `DatePreference.excludeLocalDates` (a
new field, applied in `filterSlotsByDatePreference`) to the dates already shown — a simple
exclusion list, never a second diversity pass.

### 3.5 Diversity lives in exactly one place: `computeAvailableSlots`

`selectDiverseSlots` is called only when neither `targetDate` nor `weekday` is set, strictly after
the date-preference filter and the chronological sort, replacing the old plain
`.slice(0, maxSlots)` for that case. `FakeCalendarProvider` (used by most of the pre-existing test
suite) has its own independent slot-generation loop and never calls `computeAvailableSlots` — only
`GoogleCalendarProvider` (production) and the `makeRulesEnforcingCalendar` test harness
(`whatsapp-date-preference-booking.test.ts`'s own pattern, reused here) actually exercise
diversity end to end.

### 3.6 The commitment check reuses Calendar revalidation for free

`AppointmentService.completeBooking()` already re-checks `isWithinBusinessHours` and
`isSlotAvailable` immediately before `createEvent`, and `WhatsAppBookingHandler.handleSelection`
already catches `SlotUnavailableError` and re-offers. `handleCommitmentReply`'s CONFIRMED branch
therefore does nothing more than re-find the slot among the **currently active** offered_slots
(the section 17/25 revalidation — catches TTL expiry and concurrent consumption) and delegate to
the handler's own unmodified `handleSelection`/reschedule `handleSelection` — no duplicated
Calendar-revalidation logic anywhere in this phase.

### 3.7 Round-cap accounting (section 24) falls out of the design for free

Daypart questions and commitment questions never call `getOrCreateOffer`/`replaceOffer`, so
`MAX_OFFER_ROUNDS` is untouched by them structurally — confirmed by dedicated tests, not just by
inspection.

## 4. Deviations from the spec's literal copy (disclosed)

- **Section 15 (OBSTACLE reply)**: the spec's own example is two-step ("¿quieres que revisemos
  otra opción?", waiting for a reply). This implementation combines the empathetic sentence with a
  fresh, daypart-respecting offer in the **same** message (`buildCommitmentObstacleMessage`)
  instead, to avoid introducing a new ambiguous-reply trap (a bare "sí" is not recognized by any
  parser in this codebase as "yes, show me options"). The required phrase itself is used verbatim
  as the lead-in.

## 5. Env vars / migrations

None. No new environment variable. No new table, column, or migration — `messages.metadata`
already holds arbitrary small JSON.

## 6. Files touched (10 modified `src/`, 5 new `src/`, 27 modified tests, 6 new test files)

See `git diff --stat a0450d0` on this branch for the exact list. No file outside
booking/reschedule/availability/date-preference/message-templates/slot-selection was touched —
`trustProxy`, rate limiting, the HubSpot outbox, lead scoring, the frontend fiscal calculator, the
Meta handoff template, appointment reminders, and security headers are all untouched (confirmed via
`git diff --stat`, not just by intent).

## 7. Validation

- `npx vitest run`: **1812/1812 passed**, 141 files, 0 failures.
- `npm run typecheck`: clean.
- `npm run build`: clean.
- `npm audit --production`: 4 pre-existing moderate `uuid`-via-`googleapis` vulnerabilities,
  unrelated to this phase, unchanged from every prior phase in this session.

## 8. Known, disclosed simplifications

- "Otro día" exclusion is a plain list (dates already shown in the current round), not a
  multi-round memory across the whole conversation — matches the spec's own "simple exclusion, no
  complex redesign" instruction.
- `resolveDaypartForSlot`'s "doesn't fit any window" fallback (`MORNING`) is unreachable by
  construction (every round is created only once a daypart is known) but documented rather than
  thrown, since it only ever feeds a re-offer, never booking correctness.
