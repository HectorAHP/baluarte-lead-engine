import { zonedTimeParts } from "./timezone.js";
import type { OfferedSlot } from "./offered-slot.js";

/**
 * Deterministic, non-AI-generated copy for Phase 2 (transport + persistence only -- no
 * conversational qualifier yet). Every message here is sent with aiGenerated=false.
 */
export function buildWelcomeMessage(firstName?: string): string {
  const greeting = firstName ? `Hola, ${firstName}.` : "Hola.";
  return `${greeting} Gracias por contactar a Baluarte Capital. Soy el asistente de Baluarte y puedo ayudarte a preparar tu cita con Héctor.\n\n¿Buscas información sobre:\n\n1. Ahorro e inversión\n2. Retiro / PPR\n3. Gastos Médicos Mayores\n4. Otro tema?`;
}

/**
 * Fase 6B -- sent instead of buildWelcomeMessage ONLY when: this is the lead's first inbound
 * message, a FiscalLeadContext was recovered for this phone (see application/fiscal-lead-context.ts),
 * and the inbound text itself suggests fiscal-calculator origin (see
 * domain/fiscal-calculator-origin-detection.ts). Same menu structure as buildWelcomeMessage
 * (the qualification engine's intent classification on the NEXT turn expects it) -- only the
 * opening line changes. Acknowledges fiscal-calculator origin in general terms only -- never
 * mentions score, scoreClass, income/contribution bands, or any other internal classification.
 */
export function buildFiscalContextWelcomeMessage(firstName?: string): string {
  const greeting = firstName ? `Hola, ${firstName}.` : "Hola.";
  return `${greeting} Claro, ya tengo identificado que vienes de la estimación fiscal de Baluarte Capital. Podemos revisar tu escenario y ver qué alternativas podrían tener sentido para ti.\n\n¿Buscas información sobre:\n\n1. Ahorro e inversión\n2. Retiro / PPR\n3. Gastos Médicos Mayores\n4. Otro tema?`;
}

export const HEALTH_HANDOFF_MESSAGE =
  "Gracias por compartirlo. Para cuidar tu información, este caso debe revisarlo personalmente Héctor. Te ayudaremos a continuar con él.";

export const OPT_OUT_CONFIRMATION_MESSAGE = "Entendido. No te enviaremos más mensajes.";

// Phase 3 conversational qualifier -- general escalation copy (ambiguous intent exhausted,
// complaint/claim, explicit request for a human, fiscal-advice request, aggressive tone,
// out-of-scope exception). Deliberately does not promise a response time: no SLA exists yet.
export const QUALIFIER_HUMAN_HANDOFF_MESSAGE =
  "Para ayudarte correctamente, prefiero que este punto lo revise directamente un asesor de Baluarte Capital. Ya dejé registrada tu solicitud para seguimiento.";

// Phase 3B -- sent when qualification completes. Deliberately does not offer time slots (that's
// Phase 3C); A/B and C get different copy since only A/B are headed toward a meeting.
export const QUALIFICATION_COMPLETE_AB_MESSAGE =
  "Gracias, ya tengo la información principal para preparar tu caso. El siguiente paso es revisar las opciones que mejor se adapten a lo que buscas.";

export const NURTURE_C_MESSAGE =
  "Gracias. Por ahora puedo dejar registrada tu información para que tengas un punto de referencia cuando quieras retomarlo. Si quieres, también puedo explicarte brevemente qué factores conviene comparar.";

// ---------------------------------------------------------------------------------------------
// Phase 3C -- booking copy. Deterministic, professional, no marketing language. Every date/time
// shown to a lead goes through formatSlotForDisplay, which formats in the given IANA timezone
// (the caller passes config.ADVISOR_TIMEZONE / America/Mexico_City) -- never raw UTC.
// ---------------------------------------------------------------------------------------------

const WEEKDAY_ES: Record<string, string> = {
  Sun: "Domingo",
  Mon: "Lunes",
  Tue: "Martes",
  Wed: "Miércoles",
  Thu: "Jueves",
  Fri: "Viernes",
  Sat: "Sábado",
};

/**
 * "Martes 27, 10:00 a.m." -- built from numeric zoned parts (zonedTimeParts), not from an ICU
 * locale-formatted string, so the exact wording/spacing is deterministic across Node/ICU
 * versions. The weekday name is resolved via a stable "en-US" short-weekday lookup (Sun/Mon/...)
 * mapped to Spanish here, rather than trusting an "es-MX" locale string whose exact punctuation
 * (e.g. "a. m." vs "a.m.") can vary by ICU data version.
 */
export function formatSlotForDisplay(date: Date, timezone: string): string {
  const parts = zonedTimeParts(date, timezone);
  const weekdayShort = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(date);
  const weekday = WEEKDAY_ES[weekdayShort] ?? weekdayShort;
  const hour12 = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  const period = parts.hour < 12 ? "a.m." : "p.m.";
  const minute = String(parts.minute).padStart(2, "0");
  return `${weekday} ${parts.day}, ${hour12}:${minute} ${period}`;
}

function positionList(slots: OfferedSlot[]): string {
  const positions = [...slots].map((s) => s.position).sort((a, b) => a - b);
  if (positions.length <= 1) return String(positions[0] ?? "");
  return `${positions.slice(0, -1).join(", ")} o ${positions[positions.length - 1]}`;
}

function formatSlotList(slots: OfferedSlot[], timezone: string): string {
  return [...slots]
    .sort((a, b) => a.position - b.position)
    .map((s) => `${s.position}. ${formatSlotForDisplay(s.slotStart, timezone)}`)
    .join("\n");
}

/** A. Slot offer -- also reused (with a different `intro`) for the "your slot just got taken,
 * here are new options" message (C) so the list-formatting logic is never duplicated. */
export function buildSlotOfferMessage(
  slots: OfferedSlot[],
  timezone: string,
  intro = "Tengo estas opciones disponibles para tu cita con Héctor:",
): string {
  return `${intro}\n\n${formatSlotList(slots, timezone)}\n\nResponde con el número de la opción que prefieras.`;
}

/** C. Sent after SlotUnavailableError triggers a replaceOffer() that produced a new round. */
export const SLOT_UNAVAILABLE_INTRO = "Ese horario acaba de ocuparse. Te muestro otras opciones:";

/** B. Invalid selection -- resends the SAME active slots (never a new round), with the exact
 * currently-valid position numbers spelled out (never hardcoded "1, 2 o 3": a round can have
 * fewer than 3 slots if Calendar returned fewer). */
export function buildInvalidSelectionMessage(slots: OfferedSlot[], timezone: string): string {
  return `Por favor responde ${positionList(slots)} para elegir uno de estos horarios:\n\n${formatSlotList(slots, timezone)}`;
}

/** D. Booking confirmed. No meetingUrl is ever invented -- when the provider didn't return one,
 * a safe alternative message is used instead (see below). */
export function buildBookingConfirmedMessage(when: string, meetingUrl?: string): string {
  if (meetingUrl) {
    return `Listo, tu cita quedó agendada con Héctor para el ${when}. Aquí está el enlace de la videollamada: ${meetingUrl}`;
  }
  return `Listo, tu cita quedó agendada con Héctor para el ${when}. Te compartiremos el enlace de la videollamada antes de la cita.`;
}

/** Idempotent-success / appointment-guard confirmation -- the lead already has a BOOKED
 * appointment (from this turn or an earlier one); same "no invented URL" rule as D. */
export function buildExistingBookingMessage(when: string, meetingUrl?: string): string {
  if (meetingUrl) {
    return `Ya tienes una cita agendada con Héctor para el ${when}. Aquí está el enlace de la videollamada: ${meetingUrl}`;
  }
  return `Ya tienes una cita agendada con Héctor para el ${when}. Te compartiremos el enlace de la videollamada antes de la cita.`;
}

/** E. AppointmentService.book() found a genuinely in-progress (not-yet-stale) booking attempt
 * for this same idempotency key -- never create anything additional, just ask the lead to wait. */
export const BOOKING_IN_PROGRESS_MESSAGE = "Estoy confirmando ese horario. Dame un momento e inténtalo nuevamente.";

/** F. Recoverable technical/infra failure (Calendar or otherwise) -- no state change, no new
 * round; the lead stays BOOKING_PENDING and can simply try again. */
export const BOOKING_TECHNICAL_ERROR_MESSAGE =
  "Tuve un problema técnico al consultar o confirmar el horario. Puedes intentarlo nuevamente en un momento.";

/** G. SlotOfferingService returned NO_AVAILABILITY -- no round was created, nothing to select. */
export const BOOKING_NO_AVAILABILITY_MESSAGE =
  "Por ahora no tengo horarios disponibles para ofrecerte. En cuanto haya opciones te aviso, o si lo prefieres, un asesor puede contactarte directamente.";

/**
 * H. Shared by buildBookingPendingFallbackMessage/buildReschedulePendingFallbackMessage below --
 * pre-launch hardening: replaces the old behavior of resending buildInvalidSelectionMessage's
 * terse "Por favor responde 1, 2 o 3" reminder for EVERY unrecognized inbound while
 * BOOKING_PENDING/RESCHEDULE_REQUESTED (a general question like "¿Cuáles son los servicios?" got
 * the exact same nag as a genuinely invalid number). Still restates the active options (so
 * "agendar"/a vague retry naturally reoffers the current round -- item C.4 of the pre-launch
 * spec) but frames it informatively and always names the way out, instead of only ever repeating
 * the same instruction.
 */
function buildPendingFallbackMessage(intro: string, escapeInstruction: string, slots: OfferedSlot[], timezone: string): string {
  return `${intro}\n\n${formatSlotList(slots, timezone)}\n\nResponde con el número de la opción que prefieras, o ${escapeInstruction}. Si tienes otra duda, escríbela aquí y con gusto te ayudamos.`;
}

/** BOOKING_PENDING: no appointment exists yet -- the escape hatch is "cancelar" (abandon the
 * pending booking, see BOOKING_ABANDONED_MESSAGE / isBookingAbandonRequest), never
 * AppointmentCancellationService. */
export function buildBookingPendingFallbackMessage(slots: OfferedSlot[], timezone: string): string {
  return buildPendingFallbackMessage(
    "Estamos en el proceso de agendar tu cita. Estas son las opciones disponibles:",
    'escribe "cancelar" si prefieres no agendar por ahora',
    slots,
    timezone,
  );
}

/** RESCHEDULE_REQUESTED: a real appointment already exists -- the escape hatch is the existing
 * cancellation-intent handoff into CANCEL_PENDING (see WhatsAppRescheduleHandler.handOffToCancellation),
 * so the copy below points at that real, already-correct path rather than inventing a second one. */
export function buildReschedulePendingFallbackMessage(slots: OfferedSlot[], timezone: string): string {
  return buildPendingFallbackMessage(
    "Estamos en el proceso de cambiar tu cita. Estas son las opciones disponibles:",
    'escribe "cancelar" si prefieres cancelar tu cita en su lugar',
    slots,
    timezone,
  );
}

/** Pre-launch hardening: "cancelar"/"ya no"/"salir" while BOOKING_PENDING abandons the pending
 * booking process (never an appointment cancellation -- none exists yet). Sent once the lead's
 * status has durably returned to its prior qualified tier. */
export const BOOKING_ABANDONED_MESSAGE =
  'De acuerdo, no agendaremos por ahora. Si quieres retomarlo, escribe "agendar".';

/**
 * SlotOfferClaimInProgressError -- a concurrent request is actively creating (or just finished
 * creating) this conversation's offer right now, or a legitimately-in-progress claim simply
 * hasn't finished within the bounded polling window. Purely a timing/concurrency signal, never a
 * data-consistency problem -- deliberately distinct copy from BOOKING_TECHNICAL_ERROR_MESSAGE so
 * this specific, expected condition is never conflated with a genuinely unexpected failure. No
 * state change accompanies this message in either caller (WhatsAppBookingHandler,
 * WhatsAppQualificationHandler) -- retrying shortly resolves it on its own once the winning
 * request's offer becomes visible.
 */
export const SLOT_OFFER_CLAIM_IN_PROGRESS_MESSAGE =
  "Estoy preparando los horarios disponibles. Inténtalo nuevamente en unos segundos.";

// ---------------------------------------------------------------------------------------------
// Phase 4B -- cancellation copy. Same deterministic, professional style as the booking copy
// above; every date/time shown reuses formatSlotForDisplay, never raw UTC.
// ---------------------------------------------------------------------------------------------

/** A. First turn: intent detected while BOOKED -- asks for explicit confirmation before ever
 * cancelling anything. */
export function buildCancelConfirmationPromptMessage(when: string): string {
  return `¿Quieres cancelar tu cita programada para el ${when}?\n\n1. Sí, cancelar\n2. No, conservar`;
}

/** B. Ambiguous reply while CANCEL_PENDING -- re-asks the SAME question, never cancels on an
 * unclear answer. */
export function buildCancelConfirmationRepromptMessage(when: string): string {
  return `No entendí tu respuesta.\n\n${buildCancelConfirmationPromptMessage(when)}`;
}

/** C. Declined ("2" / "no" / "conservar") -- reverts to BOOKED, nothing was ever cancelled. */
export const CANCELLATION_ABORTED_MESSAGE = "Entendido, tu cita se mantiene sin cambios.";

/** D. Confirmed and cancelled -- sent once appointments.status is durably CANCELLED, regardless
 * of whether Google Calendar cleanup has completed yet (that's an internal operational concern,
 * never exposed to the lead -- see AppointmentCancellationService). */
export const CANCELLATION_CONFIRMED_MESSAGE =
  "Listo, tu cita quedó cancelada. Si después quieres agendar nuevamente, puedo ayudarte por aquí.";

/** E. Recoverable technical failure (DB/infra) while processing a cancellation -- no state
 * change, the lead can simply try again. */
export const CANCELLATION_TECHNICAL_ERROR_MESSAGE =
  "Tuve un problema técnico al procesar tu cancelación. Puedes intentarlo nuevamente en un momento.";

// ---------------------------------------------------------------------------------------------
// Phase 4C -- reschedule copy. Same deterministic, professional style as booking/cancellation.
// ---------------------------------------------------------------------------------------------

/** A. First turn: reschedule-intent detected while BOOKED. Reuses buildSlotOfferMessage (via
 * dispatchSlotOfferOutcome) for the actual slot list -- this is only the lead-in line. */
export const RESCHEDULE_INTRO_MESSAGE = "Claro, puedo ayudarte a cambiar tu cita.";

/** B. Reschedule confirmed -- new appointment is BOOKED, old is durably RESCHEDULED. No invented
 * URL -- same rule as buildBookingConfirmedMessage. */
export function buildRescheduleConfirmedMessage(when: string, meetingUrl?: string): string {
  if (meetingUrl) {
    return `Listo, tu cita fue reagendada para el ${when}. Aquí está tu nuevo enlace: ${meetingUrl}`;
  }
  return `Listo, tu cita fue reagendada para el ${when}. Te compartiremos el enlace de la videollamada antes de la cita.`;
}

/** C. Recoverable technical/infra failure (Calendar or otherwise) while rescheduling -- no state
 * change, the lead stays RESCHEDULE_REQUESTED and can simply try again. */
export const RESCHEDULE_TECHNICAL_ERROR_MESSAGE =
  "Estoy actualizando tu cita. Inténtalo nuevamente en unos segundos.";

/** D. RescheduleInProgressError -- a concurrent/duplicate turn already owns this exact selection.
 * Same "someone else is handling this, wait" semantics as BOOKING_IN_PROGRESS_MESSAGE. */
export const RESCHEDULE_IN_PROGRESS_MESSAGE =
  "Estoy actualizando tu cita. Inténtalo nuevamente en unos segundos.";

// ---------------------------------------------------------------------------------------------
// Pre-launch hardening -- a BOOKED lead's free text that is neither a reschedule nor a
// cancellation request must never be met with silence, but must also never imply any state
// change happened. See whatsapp-inbound-service.ts's routing (gated on both
// WHATSAPP_RESCHEDULE_ENABLED and WHATSAPP_CANCELLATION_ENABLED -- the copy below only mentions
// actions that are genuinely available when both are on).
// ---------------------------------------------------------------------------------------------
export const BOOKED_GENERIC_INBOUND_MESSAGE =
  "¡Hola! Ya tienes una cita agendada con nosotros. Si quieres cambiarla escribe \"reagendar\", si necesitas cancelarla escribe \"cancelar\". Si tienes alguna otra duda, escríbela aquí y te ayudamos.";

// ---------------------------------------------------------------------------------------------
// Pre-launch hardening -- reactivating a CANCELLED lead. Same "never silence, never imply a state
// change that didn't happen" principle as BOOKED_GENERIC_INBOUND_MESSAGE above. See
// WhatsAppReactivationHandler.
// ---------------------------------------------------------------------------------------------

/** A. Generic inbound (no clear intent) -- offers reactivation without starting anything. */
export const CANCELLED_GENERIC_INBOUND_MESSAGE =
  "¡Hola! Veo que tu cita anterior fue cancelada. Si quieres agendar una nueva cita, escribe \"agendar\". Si prefieres hacer una pregunta primero, escríbela aquí y con gusto te ayudamos.";

/** B. "Quiero reagendar" from a CANCELLED lead -- there is no active appointment to move, so this
 * is reframed as a new-booking intent, with an explicit acknowledgment before the slot offer
 * (item 3 of the pre-launch spec) so the lead understands why they're seeing fresh availability
 * instead of their old appointment. */
export const CANCELLED_RESCHEDULE_TO_NEW_BOOKING_MESSAGE =
  "Tu cita anterior ya está cancelada. Puedo ayudarte a agendar una nueva.";

/** C. "Quiero cancelar" from a CANCELLED lead -- idempotent, non-destructive: nothing to cancel
 * again, no Calendar call, no state change. */
export const CANCELLED_ALREADY_MESSAGE = "Tu cita anterior ya está cancelada.";

// ---------------------------------------------------------------------------------------------
// Pre-launch hardening -- a BOOKED lead whose appointment is stale/past (status still BOOKED, but
// endsAt already elapsed -- see isUpcomingBooked). Same "never silence, never imply a state that
// didn't happen, never a destructive automatic action" principles as the CANCELLED-reactivation
// copy above, but distinct wording: this lead's own appointment record still says BOOKED, so the
// copy must not falsely claim it was cancelled -- only that it already passed. See
// WhatsAppPastBookedRecoveryHandler.
// ---------------------------------------------------------------------------------------------

/** A. Generic inbound (no clear intent) -- explains the appointment already passed, offers a new
 * one, without starting anything or implying the old one was ever cancelled. */
export const PAST_BOOKED_GENERIC_INBOUND_MESSAGE =
  "¡Hola! Veo que la fecha de tu cita anterior ya pasó. Si quieres agendar una nueva, escribe \"agendar\". Si prefieres hacer una pregunta primero, escríbela aquí y con gusto te ayudamos.";

/** B. "Quiero reagendar" for a past appointment -- there is nothing left to move (the original
 * time already elapsed), so this is reframed as a new-booking intent, same reasoning as
 * CANCELLED_RESCHEDULE_TO_NEW_BOOKING_MESSAGE. */
export const PAST_BOOKED_RESCHEDULE_TO_NEW_BOOKING_MESSAGE =
  "La fecha de tu cita anterior ya pasó. Puedo ayudarte a agendar una nueva.";

/** C. "Quiero cancelar" for a past appointment -- non-destructive: never calls Calendar, never
 * touches the appointment or lead status. A cancellation only makes sense for something still
 * upcoming. */
export const PAST_BOOKED_CANCELLATION_MESSAGE =
  "La fecha de esa cita ya pasó, así que no hay nada que cancelar. Si quieres agendar una nueva, escribe \"agendar\".";

// ---------------------------------------------------------------------------------------------
// Pre-launch hardening -- a QUALIFIED_A/QUALIFIED_B/NURTURE_C lead's free text that carries no
// booking intent (see whatsapp-inbound-service.ts's routing / isNewBookingRequest) must still
// get a reply -- never silence -- without ever mentioning score, tier, internal classification,
// or anything CRM/automation-sounding. No state change accompanies this message; sent only when
// WhatsAppBookingHandler itself did not act on the turn.
// ---------------------------------------------------------------------------------------------
export const QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE =
  'Claro. Ya tengo parte de tu información registrada. ¿Qué te gustaría hacer ahora?\n\n1. Resolver una duda\n2. Conocer opciones\n3. Agendar una asesoría\n\nPuedes responder con el número o escribirme tu pregunta.';

// ---------------------------------------------------------------------------------------------
// Fase 6C -- qualified-lead conversation router. QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE above is
// this menu's MAIN screen; everything below is what each of its 3 options (or the equivalent
// free-text phrasing -- see domain/qualified-lead-intent-detection.ts) actually leads to, so a
// reply of "1"/"2"/"3" (or "¿Cómo funciona el PPR?", "quiero agendar una cita", etc.) produces a
// genuinely different, useful outcome instead of re-showing this same menu. No guaranteed
// returns/benefits/tax outcomes are ever stated -- every topic explanation is deliberately
// hedged ("dependiendo de", "sujeto a", "sin garantía"). No score/tier/HOT-WARM-NURTURE/A-B-C
// wording anywhere in this section.
// ---------------------------------------------------------------------------------------------

/** Option "1" (MENU_QUESTION): a bare digit carries no question content yet -- ask for one.
 * Deliberately does NOT introduce a new tracked "awaiting question" state (see
 * qualified-lead-menu-state.ts's doc comment): the lead's actual next message is checked by the
 * same topic-keyword detection as any other turn, so a real question in reply to this prompt is
 * answered directly, and anything else safely falls back to the main menu again -- no dead end. */
export const QUALIFIED_LEAD_ASK_QUESTION_MESSAGE = "Claro. Escríbeme tu duda y la revisamos.";

const QUALIFIED_LEAD_TOPIC_EXPLANATIONS: Record<"PPR" | "GMM" | "SAVINGS", string> = {
  PPR: "Un PPR es una estrategia de ahorro de largo plazo orientada al retiro. Dependiendo de su estructura y de tu situación fiscal, las aportaciones pueden tener beneficios fiscales sujetos a los requisitos aplicables. La estrategia adecuada depende de tu horizonte, capacidad de aportación y régimen fiscal.",
  GMM: "Un Seguro de Gastos Médicos Mayores (GMM) cubre gastos derivados de enfermedades o accidentes que requieren atención hospitalaria, sujeto a las condiciones, sumas aseguradas y exclusiones de la póliza contratada. La cobertura adecuada depende de tu edad, tu estado de salud y tu presupuesto.",
  SAVINGS: "Un plan de ahorro o inversión de largo plazo busca hacer crecer tu patrimonio de forma disciplinada, sin garantía de rendimiento. El instrumento adecuado depende de tu horizonte de tiempo, tu tolerancia al riesgo y tus objetivos financieros.",
};

/** Answers a recognized topic (PPR/GMM/SAVINGS) with safe, hedged, non-personalized copy, then
 * re-offers the same main menu (QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE) as a natural "anything
 * else?" continuation -- reuses the existing menu copy verbatim rather than duplicating it, and
 * marks this reply as ending with the main menu (see qualified-lead-menu-state.ts) so a following
 * bare "1"/"2"/"3" is still interpretable. */
export function buildQualifiedLeadTopicAnswer(topic: "PPR" | "GMM" | "SAVINGS"): string {
  return `${QUALIFIED_LEAD_TOPIC_EXPLANATIONS[topic]}\n\n${QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE}`;
}

/** Option "2" (EXPLORE_OPTIONS): a short, non-committal list of alternatives -- no product/company
 * names, no HOT/WARM/NURTURE, no scores or bands. `prioritizeRetirement` lets the caller put
 * PPR/retiro first when a fiscal context is available (see whatsapp-inbound-service.ts) -- the
 * ONLY way fiscal context is allowed to influence this reply in this phase. */
export function buildQualifiedLeadOptionsMessage(prioritizeRetirement: boolean): string {
  const items = prioritizeRetirement
    ? ["Retiro con beneficios fiscales", "Ahorro de largo plazo", "Protección patrimonial"]
    : ["Ahorro de largo plazo", "Retiro con beneficios fiscales", "Protección patrimonial"];
  return `Por tu consulta podemos revisar alternativas enfocadas en:\n\n${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}`;
}

/** Option "3" (BOOKING): WHATSAPP_BOOKING_ENABLED stays false -- never invents availability,
 * never creates an appointment/calendar event. Purely an acknowledgment that keeps the
 * conversation moving without implying an automated booking flow exists on this channel yet. */
export const QUALIFIED_LEAD_BOOKING_FALLBACK_MESSAGE =
  "Con gusto. La agenda automática todavía no está habilitada en este canal, pero puedo ayudarte a continuar con el proceso para coordinar tu asesoría.";
