import type { Message } from "./message.js";
import type { Daypart, DatePreference } from "./date-preference.js";

type Weekday = NonNullable<DatePreference["weekday"]>;

/**
 * Fase 7K -- "Sandler Booking Flow" (spec sections 5/13/38). Persistent conversational state for
 * the two new turns this feature introduces: "we asked which daypart you prefer" and "we asked
 * whether anything could stop you from connecting". Reuses the EXACT SAME mechanism as
 * qualified-lead-menu-state.ts's resolvePendingQualifiedMenu -- the last OUTBOUND message's own
 * `metadata.expectedIntent` marker -- rather than any new table/column/cache. This is what
 * section 38 asks be checked before proposing a migration: messages.metadata already holds
 * arbitrary small JSON (see qualified-lead-menu-state.ts, health-redaction.ts,
 * origin/fiscalContextAvailable), survives a restart/webhook retry for free (it's read back from
 * the persisted message row, never an in-process cache), and needs no new infrastructure -- so no
 * migration is proposed here.
 *
 * Deliberately a distinct marker NAMESPACE from qualified-lead-menu-state.ts's own
 * "QUALIFIED_MAIN_MENU"/"QUALIFIED_OPTIONS_MENU" values under the same `expectedIntent` key --
 * the two features never run in the same conversational turn (one is BOOKING_PENDING-adjacent,
 * the other CONTACTED-menu-adjacent), and resolvePendingBookingFlowState here simply returns
 * `null` for a marker it doesn't recognize, exactly mirroring resolvePendingQualifiedMenu's own
 * "neither -> null" contract -- so the two coexist safely without any shared vocabulary.
 */

export type BookingFlowMode = "BOOKING" | "RESCHEDULE";

const EXPECTED_INTENT_KEY = "expectedIntent";
const DAYPART_MARKER = "AWAITING_DAYPART_PREFERENCE";
const COMMITMENT_MARKER = "AWAITING_BOOKING_COMMITMENT";

/** What we already knew about the requested date BEFORE asking the daypart question, so the
 * eventual daypart reply can be merged back into one complete DatePreference instead of losing
 * an explicit "el sabado" the lead already gave. Never both targetDate and weekday (same
 * invariant DatePreference itself keeps).
 *
 * `offerAction` records whether an active round already existed at the moment the daypart
 * question was asked: "NEW" (no round yet -- e.g. the very first turn of a booking episode) means
 * the eventual answer should call getOrCreateOffer; "REPLACE" (a preference arrived mid-round,
 * e.g. "mejor el sabado" while Monday options were still active) means it must call replaceOffer
 * instead -- getOrCreateOffer would otherwise just REUSE that still-active, wrong-daypart round
 * once the question is answered, silently ignoring the very daypart the lead just gave. */
export interface PendingDaypartQuestion {
  mode: BookingFlowMode;
  oldAppointmentId?: string;
  targetDate?: string;
  weekday?: Weekday;
  offerAction: "NEW" | "REPLACE";
  /** Carries SlotOfferParams.skipRoundCap through to the round eventually created once daypart is
   * answered (see slot-offering-service.ts's own doc comment: only ever true for round 1 of a
   * brand-new booking episode, e.g. WhatsAppPastBookedRecoveryHandler.startNewBooking). Omitted
   * (undefined) is the overwhelmingly common case and behaves exactly as before this field
   * existed. */
  skipRoundCap?: boolean;
}

/** Section 13's exact field list: selectedSlot (id + start/end so the commitment message and the
 * eventual re-lookup never need a second DB round-trip to describe what was offered),
 * slotOfferRoundId, mode (BOOKING|RESCHEDULE), oldAppointmentId when applicable, timestamp (when
 * the commitment question was asked -- used for TTL/staleness reasoning, section 25), and
 * clarificationAsked (section 16's "ask once" bookkeeping). `daypart`/`targetDate`/`weekday`
 * (beyond section 13's literal list) capture the DatePreference that produced the offered round
 * this commitment is about -- so an OBSTACLE reply (section 15/21: "keep the chosen daypart/date
 * preference") can generate its fresh alternative offer without re-deriving or guessing it. */
export interface PendingBookingCommitment {
  selectedSlotId: string;
  slotStart: string; // ISO 8601
  slotEnd: string; // ISO 8601
  slotOfferRoundId: string;
  mode: BookingFlowMode;
  oldAppointmentId?: string;
  timestamp: string; // ISO 8601 -- when the commitment question was sent
  clarificationAsked: boolean;
  daypart: Daypart;
  targetDate?: string;
  weekday?: Weekday;
}

export type PendingBookingFlowState =
  | { type: "DAYPART"; data: PendingDaypartQuestion }
  | { type: "COMMITMENT"; data: PendingBookingCommitment };

export function daypartQuestionMetadata(data: PendingDaypartQuestion): Record<string, unknown> {
  return { [EXPECTED_INTENT_KEY]: DAYPART_MARKER, ...data };
}

export function bookingCommitmentMetadata(data: PendingBookingCommitment): Record<string, unknown> {
  return { [EXPECTED_INTENT_KEY]: COMMITMENT_MARKER, ...data };
}

function isMode(value: unknown): value is BookingFlowMode {
  return value === "BOOKING" || value === "RESCHEDULE";
}

function isWeekday(value: unknown): value is Weekday {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

function isOfferAction(value: unknown): value is "NEW" | "REPLACE" {
  return value === "NEW" || value === "REPLACE";
}

function readDaypartQuestion(metadata: Record<string, unknown>): PendingDaypartQuestion | null {
  if (!isMode(metadata.mode) || !isOfferAction(metadata.offerAction)) return null;
  const data: PendingDaypartQuestion = { mode: metadata.mode, offerAction: metadata.offerAction };
  if (typeof metadata.oldAppointmentId === "string") data.oldAppointmentId = metadata.oldAppointmentId;
  if (typeof metadata.targetDate === "string") data.targetDate = metadata.targetDate;
  if (isWeekday(metadata.weekday)) data.weekday = metadata.weekday;
  if (typeof metadata.skipRoundCap === "boolean") data.skipRoundCap = metadata.skipRoundCap;
  return data;
}

function isDaypart(value: unknown): value is Daypart {
  return value === "MORNING" || value === "AFTERNOON" || value === "EVENING";
}

function readBookingCommitment(metadata: Record<string, unknown>): PendingBookingCommitment | null {
  if (
    typeof metadata.selectedSlotId !== "string" ||
    typeof metadata.slotStart !== "string" ||
    typeof metadata.slotEnd !== "string" ||
    typeof metadata.slotOfferRoundId !== "string" ||
    !isMode(metadata.mode) ||
    typeof metadata.timestamp !== "string" ||
    typeof metadata.clarificationAsked !== "boolean" ||
    !isDaypart(metadata.daypart)
  ) {
    return null; // malformed/corrupted metadata -- never guess, treat as "no pending state"
  }
  const data: PendingBookingCommitment = {
    selectedSlotId: metadata.selectedSlotId,
    slotStart: metadata.slotStart,
    slotEnd: metadata.slotEnd,
    slotOfferRoundId: metadata.slotOfferRoundId,
    mode: metadata.mode,
    timestamp: metadata.timestamp,
    clarificationAsked: metadata.clarificationAsked,
    daypart: metadata.daypart,
  };
  if (typeof metadata.oldAppointmentId === "string") data.oldAppointmentId = metadata.oldAppointmentId;
  if (typeof metadata.targetDate === "string") data.targetDate = metadata.targetDate;
  if (isWeekday(metadata.weekday)) data.weekday = metadata.weekday;
  return data;
}

/**
 * Same ordering contract as resolvePendingQualifiedMenu: `messages` must already be ascending
 * chronological (MessageRepository.listByConversationId's documented order); takes the array's
 * own last OUTBOUND element rather than re-sorting.
 *
 * Returns `null` for: no outbound message yet, a marker this module doesn't own (e.g. the
 * qualified-menu markers), or a recognized marker whose payload fails validation (defensive --
 * never act on unverified state; the caller falls back to "no pending state", the same safe
 * default as before this feature existed).
 */
export function resolvePendingBookingFlowState(messages: readonly Message[]): PendingBookingFlowState | null {
  const outboundMessages = messages.filter((m) => m.direction === "OUTBOUND");
  const lastOutbound = outboundMessages[outboundMessages.length - 1];
  const metadata = lastOutbound?.metadata;
  if (!metadata) return null;
  const marker = metadata[EXPECTED_INTENT_KEY];
  if (marker === DAYPART_MARKER) {
    const data = readDaypartQuestion(metadata);
    return data ? { type: "DAYPART", data } : null;
  }
  if (marker === COMMITMENT_MARKER) {
    const data = readBookingCommitment(metadata);
    return data ? { type: "COMMITMENT", data } : null;
  }
  return null;
}
