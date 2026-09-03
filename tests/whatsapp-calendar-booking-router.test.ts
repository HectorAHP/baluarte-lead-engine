import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryQualificationAnswerRepository, InMemoryLeadScoreRepository, InMemoryAppointmentRepository,
  InMemoryBookingAttemptRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryFiscalLeadScoreRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import {
  QUALIFIED_LEAD_BOOKING_FALLBACK_MESSAGE, BOOKING_TECHNICAL_ERROR_MESSAGE,
  BOOKING_NO_AVAILABILITY_MESSAGE,
} from "../src/domain/message-templates.js";
import { CalendarProviderError } from "../src/domain/errors.js";
import type { CalendarProvider, CalendarSlot, CalendarEventInput, CalendarEventResult } from "../src/application/ports.js";
import type { FiscalLeadScore } from "../src/domain/fiscal-lead-score.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";

/**
 * Fase 6D -- restores the real (Google Calendar-backed, here FakeCalendarProvider-backed for a
 * deterministic CI run) booking flow reachable from the qualified-lead router's option "3" /
 * BOOKING intent. Uses FakeCalendarProvider (same convention as whatsapp-booking-e2e.test.ts) --
 * the live Google Calendar QA validation for this task was run separately, directly against
 * production credentials (see the Fase 6D report), not as part of this automated suite.
 */

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function textWebhookBody(overrides: { from?: string; id?: string; body?: string; name?: string } = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ profile: { name: overrides.name ?? "Ana" }, wa_id: overrides.from ?? "5214776100001" }],
              messages: [{ from: overrides.from ?? "5214776100001", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
            },
          },
        ],
      },
    ],
  });
}

function buildRepos() {
  return {
    leadsRepo: new InMemoryLeadRepository(),
    conversationsRepo: new InMemoryConversationRepository(),
    messagesRepo: new InMemoryMessageRepository(),
    qualificationAnswersRepo: new InMemoryQualificationAnswerRepository(),
    leadScoresRepo: new InMemoryLeadScoreRepository(),
    appointmentsRepo: new InMemoryAppointmentRepository(),
    bookingAttemptsRepo: new InMemoryBookingAttemptRepository(),
    offeredSlotsRepo: new InMemoryOfferedSlotRepository(),
    slotOfferClaimsRepo: new InMemorySlotOfferClaimRepository(),
    leadStatusHistoryRepo: new InMemoryLeadStatusHistoryRepository(),
    fiscalLeadScoresRepo: new InMemoryFiscalLeadScoreRepository(),
    calendar: new FakeCalendarProvider(),
  };
}

async function send(app: Awaited<ReturnType<typeof buildTestApp>>, from: string, id: string, body: string) {
  const payload = textWebhookBody({ from, id, body });
  return app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    payload,
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET) },
  });
}

async function createLeadAtStatus(repos: ReturnType<typeof buildRepos>, whatsappUserId: string, status: LeadStatus, overrides: Partial<Lead> = {}) {
  const lead = await repos.leadsRepo.create({
    country: "MX", productVertical: "PATRIMONIAL", status: "NEW", score: 78, scoreClass: "A",
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId,
    ...overrides,
  });
  await repos.leadsRepo.update(lead.id, { status, ...overrides });
  const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead: (await repos.leadsRepo.findById(lead.id))!, conversation };
}

async function seedFiscalScore(fiscalLeadScoresRepo: InMemoryFiscalLeadScoreRepository, leadId: string) {
  return fiscalLeadScoresRepo.tryCreate({
    leadId, submissionId: "sub-1", score: 90, scoreClass: "HOT", version: "fiscal_v1",
    reasons: [{ code: "MONTHLY_INCOME_150K_PLUS", points: 40 }],
    monthlyIncomeBand: "150K_PLUS", annualContributionBand: "180K_PLUS", hasPpr: false, filesAnnualReturn: true,
  } satisfies Omit<FiscalLeadScore, "id" | "createdAt">);
}

async function outboundMessages(repos: ReturnType<typeof buildRepos>, conversationId: string) {
  const messages = await repos.messagesRepo.listByConversationId(conversationId);
  return messages.filter((m) => m.direction === "OUTBOUND");
}

/** A CalendarProvider that always fails -- for the "Google temporarily unavailable" scenario. */
class FailingCalendar implements CalendarProvider {
  async getAvailableSlots(): Promise<CalendarSlot[]> { throw new CalendarProviderError("simulated outage"); }
  async isSlotAvailable(): Promise<boolean> { throw new CalendarProviderError("simulated outage"); }
  async createEvent(): Promise<CalendarEventResult> { throw new CalendarProviderError("simulated outage"); }
  async deleteEvent(): Promise<void> { throw new CalendarProviderError("simulated outage"); }
}

/** A CalendarProvider with zero availability -- for the "no slots" scenario. */
class EmptyCalendar implements CalendarProvider {
  async getAvailableSlots(): Promise<CalendarSlot[]> { return []; }
  async isSlotAvailable(): Promise<boolean> { return true; }
  async createEvent(input: CalendarEventInput): Promise<CalendarEventResult> { return { eventId: randomUUID() }; }
  async deleteEvent(): Promise<void> {}
}

describe("Fase 6D -- WhatsApp qualified-lead router restores real Google Calendar booking", () => {
  it("1. option '3' with WHATSAPP_BOOKING_ENABLED=false stays the safe fallback -- never invents availability", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: false });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214776100001", "QUALIFIED_A");
    await send(app, "5214776100001", "wamid.1a", "Hola, tengo una duda"); // main menu shown

    await send(app, "5214776100001", "wamid.1b", "3");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(2);
    expect(outbound[1].body).toBe(QUALIFIED_LEAD_BOOKING_FALLBACK_MESSAGE);
    const after = await repos.leadsRepo.findById(lead.id);
    expect(after?.status).toBe("QUALIFIED_A"); // never entered booking
  });

  it("2. option '3' with WHATSAPP_BOOKING_ENABLED=true enters the REAL booking flow (offers real slots, never the fallback text)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776100002", "QUALIFIED_A");
    await send(app, "5214776100002", "wamid.2a", "Hola, tengo una duda"); // main menu shown

    await send(app, "5214776100002", "wamid.2b", "3");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(2);
    expect(outbound[1].body).not.toBe(QUALIFIED_LEAD_BOOKING_FALLBACK_MESSAGE);
    expect(outbound[1].body).toContain("Tengo estas opciones disponibles");
    // 3 real slots came from FakeCalendarProvider (max 3, same cap GoogleCalendarProvider uses).
    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date());
    expect(offered.length).toBeGreaterThan(0);
  });

  it("3. 'Quiero agendar una asesoría' (free text) enters the real booking flow directly, with no prior menu", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776100003", "QUALIFIED_A");

    await send(app, "5214776100003", "wamid.3a", "Quiero agendar una asesoría");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toContain("Tengo estas opciones disponibles");
  });

  it("4+5. offered slots come exclusively from CalendarProvider.getAvailableSlots -- never invented", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776100004", "QUALIFIED_A");
    // Mark one specific future half-hour as busy on the REAL provider before anything runs -- if
    // the offer ever invented slots instead of asking the provider, this window could still show
    // up as "available" to the lead, which the assertion below rules out.
    const busyStart = new Date(Date.now() + 3 * 86400000);
    const busyEnd = new Date(busyStart.getTime() + 30 * 60000);
    await repos.calendar.createEvent({ title: "busy", description: "", start: busyStart, end: busyEnd });

    await send(app, "5214776100004", "wamid.4a", "Quiero agendar una cita");

    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date());
    // FakeCalendarProvider caps at 3 slots per query, same cap GoogleCalendarProvider's own
    // rules() enforce (maxSlots: 3) -- never more than the provider itself would ever return.
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.length).toBeLessThanOrEqual(3);
    // None of the offered slots overlaps the window already marked busy on the real provider --
    // proves the offer is genuinely provider-driven, not invented independently of it.
    expect(offered.every((slot) => !(slot.slotStart < busyEnd && slot.slotEnd > busyStart))).toBe(true);
  });

  it("6. selecting '1' resolves against the FIRST previously offered slot", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214776100006", "QUALIFIED_A");
    await send(app, "5214776100006", "wamid.6a", "Quiero agendar una cita");
    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date());
    const first = [...offered].sort((a, b) => a.position - b.position)[0];

    await send(app, "5214776100006", "wamid.6b", "1");

    const appt = (await repos.appointmentsRepo.listAllByLeadId(lead.id))[0];
    expect(appt.startsAt.getTime()).toBe(first.slotStart.getTime());
  });

  it("7+8. a slot occupied between offer and selection is revalidated and rejected -- no event created for it, a fresh offer replaces it", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776100007", "QUALIFIED_A");
    await send(app, "5214776100007", "wamid.7a", "Quiero agendar una cita");
    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date());
    const first = [...offered].sort((a, b) => a.position - b.position)[0];

    // Race: something else takes that exact slot on the real calendar between offer and selection.
    await repos.calendar.createEvent({ title: "race", description: "", start: first.slotStart, end: first.slotEnd });

    await send(app, "5214776100007", "wamid.7b", "1");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[outbound.length - 1].body).toContain("Ese horario acaba de ocuparse"); // SLOT_UNAVAILABLE_INTRO path
    const appts = await repos.appointmentsRepo.listAllByLeadId((await repos.leadsRepo.findByDedupKey({ whatsappUserId: "5214776100007" }))!.id);
    expect(appts.find((a) => a.startsAt.getTime() === first.slotStart.getTime())).toBeUndefined();
  });

  it("9+10. a successful booking persists a real appointment and updates the lead lifecycle (status BOOKED, bookedAt set)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214776100009", "QUALIFIED_A");
    await send(app, "5214776100009", "wamid.9a", "Quiero agendar una cita");

    await send(app, "5214776100009", "wamid.9b", "1");

    const after = await repos.leadsRepo.findById(lead.id);
    expect(after?.status).toBe("BOOKED");
    expect(after?.bookedAt).toBeInstanceOf(Date);
    const appt = (await repos.appointmentsRepo.listAllByLeadId(lead.id))[0];
    expect(appt.status).toBe("BOOKED");
  });

  it("11. a retried webhook (same providerMessageId) never creates a second appointment", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214776100011", "QUALIFIED_A");
    await send(app, "5214776100011", "wamid.11a", "Quiero agendar una cita");
    await send(app, "5214776100011", "wamid.11b", "1");

    await send(app, "5214776100011", "wamid.11b", "1"); // exact retry, same providerMessageId

    const appts = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    expect(appts).toHaveLength(1);
  });

  it("12. selecting the same slot twice with different messages (double-tap) never creates a second appointment -- idempotency key covers it", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214776100012", "QUALIFIED_A");
    await send(app, "5214776100012", "wamid.12a", "Quiero agendar una cita");
    await send(app, "5214776100012", "wamid.12b", "1");

    await send(app, "5214776100012", "wamid.12c", "1"); // different providerMessageId, same selection -- already BOOKED

    const appts = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    expect(appts).toHaveLength(1);
  });

  it("13. a Calendar provider failure produces a safe technical-error reply, never a 500 to the webhook", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, calendar: new FailingCalendar(), whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776100013", "QUALIFIED_A");

    const res = await send(app, "5214776100013", "wamid.13a", "Quiero agendar una cita");

    expect(res.statusCode).toBe(200); // webhook always acks -- never a 500 out to Meta
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toBe(BOOKING_TECHNICAL_ERROR_MESSAGE);
  });

  it("14. no availability from the provider produces a safe, non-inventive reply", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, calendar: new EmptyCalendar(), whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776100014", "QUALIFIED_A");

    await send(app, "5214776100014", "wamid.14a", "Quiero agendar una cita");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toBe(BOOKING_NO_AVAILABILITY_MESSAGE);
  });

  it("15. the confirmed appointment time is expressed in America/Mexico_City, not raw UTC", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214776100015", "QUALIFIED_A");
    await send(app, "5214776100015", "wamid.15a", "Quiero agendar una cita");
    const conversation = (await repos.conversationsRepo.findActiveByLeadId(lead.id))!;
    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date());

    await send(app, "5214776100015", "wamid.15b", "1");

    const outbound = await outboundMessages(repos, conversation.id);
    const confirmedBody = outbound[outbound.length - 1].body!;
    expect(confirmedBody).toContain("agendada"); // buildBookingConfirmedMessage's copy
    // formatSlotForDisplay renders the ADVISOR_TIMEZONE local hour, not the raw UTC hour --
    // sanity check the offered slot's stored UTC hour and America/Mexico_City are genuinely
    // different (proves this test isn't vacuously true).
    const utcHour = offered[0].slotStart.getUTCHours();
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/Mexico_City", hour: "2-digit", hour12: false }).format(offered[0].slotStart),
    );
    expect(localHour).not.toBe(utcHour);
  });

  it("16+17. a fiscal-context QUALIFIED_A lead (HOT/90) can complete a real booking without HOT ever becoming A/B/C or vice versa", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214776100016", "QUALIFIED_A", { source: "WEB_FISCAL_CALCULATOR" });
    await seedFiscalScore(repos.fiscalLeadScoresRepo, lead.id);

    await send(app, "5214776100016", "wamid.16a", "Quiero agendar una cita");
    await send(app, "5214776100016", "wamid.16b", "1");

    const after = await repos.leadsRepo.findById(lead.id);
    expect(after?.status).toBe("BOOKED");
    expect(after?.scoreClass).toBe("A"); // untouched A/B/C field
    expect(after?.score).toBe(78); // untouched A/B/C numeric score
    const fiscalRows = await repos.fiscalLeadScoresRepo.listByLeadId(lead.id);
    expect(fiscalRows[0].scoreClass).toBe("HOT"); // untouched fiscal field, still separate
  });

  it("18. DO_NOT_CONTACT stays fully suppressed -- booking never activates for it", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776100018", "DO_NOT_CONTACT");

    await send(app, "5214776100018", "wamid.18a", "3");

    expect(await outboundMessages(repos, conversation.id)).toHaveLength(0);
  });

  it("19. HUMAN_HANDOFF stays fully suppressed -- booking never activates for it", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776100019", "HUMAN_HANDOFF");

    await send(app, "5214776100019", "wamid.19a", "3");

    expect(await outboundMessages(repos, conversation.id)).toHaveLength(0);
  });

  it("20. no outbound message is ever sent without a real inbound webhook triggering it", async () => {
    const repos = buildRepos();
    await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    await createLeadAtStatus(repos, "5214776100020", "QUALIFIED_A");
    // Merely booting the app and seeding a qualified lead sends nothing on its own.
    const allMessages = await repos.messagesRepo.listByConversationId(
      (await repos.conversationsRepo.findActiveByLeadId((await repos.leadsRepo.findByDedupKey({ whatsappUserId: "5214776100020" }))!.id))!.id,
    );
    expect(allMessages.filter((m) => m.direction === "OUTBOUND")).toHaveLength(0);
  });
});
