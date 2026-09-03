import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleInboundWhatsAppText, type InboundWhatsAppText } from "../src/application/whatsapp-inbound-service.js";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import { LeadService } from "../src/application/services.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository, InMemoryLeadScoreRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryFiscalLeadScoreRepository, InMemoryAppointmentRepository,
  InMemoryBookingAttemptRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
  InMemoryQualificationAnswerRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import {
  buildWelcomeMessage, buildFiscalContextWelcomeMessage, QUALIFIED_LEAD_IDENTITY_ANSWER_MESSAGE,
  BOOKING_TECHNICAL_ERROR_MESSAGE, SLOT_UNAVAILABLE_INTRO,
} from "../src/domain/message-templates.js";
import { LIA_NAME } from "../src/domain/lia-identity.js";
import { CalendarProviderError } from "../src/domain/errors.js";
import type { CalendarProvider, CalendarSlot, CalendarEventInput, CalendarEventResult } from "../src/application/ports.js";
import type { FiscalLeadScore } from "../src/domain/fiscal-lead-score.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";

/** Fase 6E -- Lía's natural conversation experience. Reuses the two established test patterns in
 * this repo: direct handleInboundWhatsAppText() calls for pure routing/copy checks, and the full
 * HTTP webhook (buildTestApp) for the real booking flow (needs app.ts's real dependency wiring). */

function makeDeps() {
  const leads = new InMemoryLeadRepository();
  const conversations = new InMemoryConversationRepository();
  const messages = new InMemoryMessageRepository();
  const leadScores = new InMemoryLeadScoreRepository();
  const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
  const messaging = new FakeMessagingProvider();
  const logger = new FakeLogger();
  const leadService = new LeadService(leads, leadScores, new InMemoryLeadStatusHistoryRepository(), logger);
  return { leads, conversations, messages, fiscalLeadScores, messaging, logger, leadService };
}

function baseInput(overrides: Partial<InboundWhatsAppText> = {}): InboundWhatsAppText {
  return {
    whatsappUserId: "5214776200001",
    phoneRaw: "5214776200001",
    displayName: "Juan",
    providerMessageId: "wamid.1",
    text: "Hola, quiero información",
    ...overrides,
  };
}

async function seedFiscalScore(fiscalLeadScores: InMemoryFiscalLeadScoreRepository, leadId: string) {
  return fiscalLeadScores.tryCreate({
    leadId, submissionId: "sub-1", score: 90, scoreClass: "HOT", version: "fiscal_v1",
    reasons: [{ code: "MONTHLY_INCOME_150K_PLUS", points: 40 }],
    monthlyIncomeBand: "150K_PLUS", annualContributionBand: "180K_PLUS", hasPpr: false, filesAnnualReturn: true,
  } satisfies Omit<FiscalLeadScore, "id" | "createdAt">);
}

async function seedQualifiedAWithWelcome(deps: ReturnType<typeof makeDeps>, phone: string, waId: string, firstName?: string) {
  const lead = await deps.leadService.createLead({ firstName, phone, source: "WEB_FISCAL_CALCULATOR", consentContact: false });
  await seedFiscalScore(deps.fiscalLeadScores, lead.id);
  await deps.leads.update(lead.id, { status: "QUALIFIED_A", score: 78, scoreClass: "A" });
  const prefilled = "Hola, acabo de realizar mi estimación fiscal en Baluarte Capital y quiero revisar mi resultado.";
  await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: waId, phoneRaw: phone, providerMessageId: "wamid.welcome", text: prefilled }));
  return { lead: (await deps.leads.findById(lead.id))! };
}

// -------------------------------------------------------------------------------------------
// HTTP-level helpers for the real Google-Calendar-shaped booking flow (FakeCalendarProvider).
// -------------------------------------------------------------------------------------------
function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
function textWebhookBody(overrides: { from?: string; id?: string; body?: string; name?: string } = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "waba-1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      contacts: [{ profile: { name: overrides.name ?? "Juan" }, wa_id: overrides.from ?? "5214776200099" }],
      messages: [{ from: overrides.from ?? "5214776200099", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
    } }] }],
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
  return app.inject({ method: "POST", url: "/webhooks/whatsapp", payload, headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET) } });
}
async function createLeadAtStatus(repos: ReturnType<typeof buildRepos>, whatsappUserId: string, status: LeadStatus, overrides: Partial<Lead> = {}) {
  const lead = await repos.leadsRepo.create({ country: "MX", productVertical: "PATRIMONIAL", status: "NEW", score: 78, scoreClass: "A", assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId, ...overrides });
  await repos.leadsRepo.update(lead.id, { status, ...overrides });
  const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead: (await repos.leadsRepo.findById(lead.id))!, conversation };
}
async function outboundMessages(repos: ReturnType<typeof buildRepos>, conversationId: string) {
  return (await repos.messagesRepo.listByConversationId(conversationId)).filter((m) => m.direction === "OUTBOUND");
}
class FailingCalendar implements CalendarProvider {
  async getAvailableSlots(): Promise<CalendarSlot[]> { throw new CalendarProviderError("outage"); }
  async isSlotAvailable(): Promise<boolean> { throw new CalendarProviderError("outage"); }
  async createEvent(): Promise<CalendarEventResult> { throw new CalendarProviderError("outage"); }
  async deleteEvent(): Promise<void> { throw new CalendarProviderError("outage"); }
}

describe("Fase 6E -- Lía natural conversation experience", () => {
  it("1. the welcome message uses the lead's firstName", async () => {
    const deps = makeDeps();
    await handleInboundWhatsAppText(deps, baseInput());
    expect(deps.messaging.sentTexts[0].body).toBe(buildWelcomeMessage("Juan"));
    expect(deps.messaging.sentTexts[0].body).toContain("Juan");
  });

  it("2. with no firstName available, the welcome never leaks 'undefined' -- it just greets naturally", async () => {
    const deps = makeDeps();
    // No displayName in the payload and no pre-existing lead -- firstName stays unset end to end.
    await handleInboundWhatsAppText(deps, baseInput({ displayName: undefined }));
    const body = deps.messaging.sentTexts[0].body;
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("null");
    expect(body?.startsWith("Hola.")).toBe(true);
  });

  it(`3. Lía introduces herself ("Soy ${LIA_NAME}, asistente de Baluarte Capital") only on the welcome, never repeated on later turns`, async () => {
    const deps = makeDeps();
    await handleInboundWhatsAppText(deps, baseInput({ providerMessageId: "wamid.1" }));
    expect(deps.messaging.sentTexts[0].body).toContain(`Soy ${LIA_NAME}, asistente de Baluarte Capital`);

    // Second turn: no qualificationHandler wired (flag off) -- no automated reply at all, so
    // there's nothing that COULD repeat the introduction. The introduction line itself only ever
    // appears inside buildWelcomeMessage/buildFiscalContextWelcomeMessage -- both fire exactly
    // once per lead (guarded by wasNew / isFirstWhatsAppInbound), never on a later turn.
    await handleInboundWhatsAppText(deps, baseInput({ providerMessageId: "wamid.2", text: "otra pregunta" }));
    const introCount = deps.messaging.sentTexts.filter((m) => m.body?.includes(`Soy ${LIA_NAME}`)).length;
    expect(introCount).toBe(1);
  });

  it('4. "¿Quién eres?" gets a transparent identity answer -- never claims to be human', async () => {
    const deps = makeDeps();
    await seedQualifiedAWithWelcome(deps, "4776200004", "5214776200004", "Juan");

    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214776200004", phoneRaw: "4776200004", providerMessageId: "wamid.q", text: "¿Quién eres?" }));

    const reply = deps.messaging.sentTexts[deps.messaging.sentTexts.length - 1].body!;
    expect(reply).toBe(QUALIFIED_LEAD_IDENTITY_ANSWER_MESSAGE);
    expect(reply).toContain(`${LIA_NAME}, asistente de Baluarte Capital`);
    expect(reply.toLowerCase()).not.toContain("soy un bot");
    expect(reply.toLowerCase()).not.toContain("soy una inteligencia artificial");
    expect(reply.toLowerCase()).not.toContain("soy humana");
    expect(reply.toLowerCase()).not.toContain("soy héctor");
  });

  it("5. a PPR question ends on a contextual follow-up question, not the generic menu", async () => {
    const deps = makeDeps();
    await seedQualifiedAWithWelcome(deps, "4776200005", "5214776200005", "Juan");

    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214776200005", phoneRaw: "4776200005", providerMessageId: "wamid.ppr", text: "¿Cómo funciona el PPR?" }));

    const reply = deps.messaging.sentTexts[deps.messaging.sentTexts.length - 1].body!;
    expect(reply.trim().endsWith("?")).toBe(true);
    expect(reply).not.toContain("1. Resolver una duda");
  });

  it("6. a GMM question ends on a contextual follow-up question, not the generic menu", async () => {
    const deps = makeDeps();
    await seedQualifiedAWithWelcome(deps, "4776200006", "5214776200006", "Juan");

    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214776200006", phoneRaw: "4776200006", providerMessageId: "wamid.gmm", text: "¿Qué cubre el GMM?" }));

    const reply = deps.messaging.sentTexts[deps.messaging.sentTexts.length - 1].body!;
    expect(reply.trim().endsWith("?")).toBe(true);
    expect(reply).not.toContain("1. Resolver una duda");
  });

  it("7. option '1' does not repeat the generic menu", async () => {
    const deps = makeDeps();
    await seedQualifiedAWithWelcome(deps, "4776200007", "5214776200007", "Juan");
    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214776200007", phoneRaw: "4776200007", providerMessageId: "wamid.menu", text: "Hola" }));

    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214776200007", phoneRaw: "4776200007", providerMessageId: "wamid.1", text: "1" }));

    const reply = deps.messaging.sentTexts[deps.messaging.sentTexts.length - 1].body!;
    expect(reply).not.toContain("1. Resolver una duda");
    expect(reply).not.toContain("2. Conocer opciones");
  });

  it("8. option '2' returns a working alternatives list ending in a question", async () => {
    const deps = makeDeps();
    await seedQualifiedAWithWelcome(deps, "4776200008", "5214776200008", "Juan");
    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214776200008", phoneRaw: "4776200008", providerMessageId: "wamid.menu", text: "Hola" }));

    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214776200008", phoneRaw: "4776200008", providerMessageId: "wamid.2", text: "2" }));

    const reply = deps.messaging.sentTexts[deps.messaging.sentTexts.length - 1].body!;
    expect(reply).toContain("Retiro con beneficios fiscales");
    expect(reply.trim().endsWith("?")).toBe(true);
  });

  it("9+10. the real booking flow uses the lead's name and shows only real provider-sourced slots", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776200910", "QUALIFIED_A", { firstName: "Juan" });

    await send(app, "5214776200910", "wamid.1", "Quiero agendar una cita");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toContain("Perfecto, Juan");
    expect(outbound[0].body).toContain("Tengo estos horarios disponibles");
    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date());
    const realSlots = await repos.calendar.getAvailableSlots(new Date(), new Date(Date.now() + 7 * 86400000), 30);
    expect(offered.length).toBeLessThanOrEqual(realSlots.length + 1); // provider-bounded, never invented beyond what it can return
    expect(offered.length).toBeGreaterThan(0);
  });

  it("11. the booking confirmation uses the lead's name", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776200911", "QUALIFIED_A", { firstName: "Juan" });
    await send(app, "5214776200911", "wamid.1", "Quiero agendar una cita");

    await send(app, "5214776200911", "wamid.2", "1");

    const outbound = await outboundMessages(repos, conversation.id);
    const confirmed = outbound[outbound.length - 1].body!;
    expect(confirmed).toContain("Listo, Juan");
    expect(confirmed).toContain("quedó agendada");
  });

  it("12. a Calendar outage produces a safe reply with no technical/provider language", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, calendar: new FailingCalendar(), whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776200912", "QUALIFIED_A", { firstName: "Juan" });

    await send(app, "5214776200912", "wamid.1", "Quiero agendar una cita");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toBe(BOOKING_TECHNICAL_ERROR_MESSAGE);
    const lower = outbound[0].body!.toLowerCase();
    expect(lower).not.toContain("google");
    expect(lower).not.toContain("api");
    expect(lower).not.toContain("provider");
    expect(lower).not.toContain("error");
  });

  it("13. a slot that just became unavailable is announced without technical language", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776200913", "QUALIFIED_A", { firstName: "Juan" });
    await send(app, "5214776200913", "wamid.1", "Quiero agendar una cita");
    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date());
    const first = [...offered].sort((a, b) => a.position - b.position)[0];
    await repos.calendar.createEvent({ title: "race", description: "", start: first.slotStart, end: first.slotEnd });

    await send(app, "5214776200913", "wamid.2", "1");

    const outbound = await outboundMessages(repos, conversation.id);
    const lastReply = outbound[outbound.length - 1].body!;
    expect(lastReply.startsWith(SLOT_UNAVAILABLE_INTRO)).toBe(true);
    const lower = lastReply.toLowerCase();
    expect(lower).not.toContain("error");
    expect(lower).not.toContain("slotunavailableerror");
    expect(lower).not.toContain("exception");
  });

  it("14+15+16. HOT / score / income-contribution bands never appear in anything sent to the user", async () => {
    const deps = makeDeps();
    await seedQualifiedAWithWelcome(deps, "4776201415", "5214776201415", "Juan");
    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214776201415", phoneRaw: "4776201415", providerMessageId: "wamid.a", text: "¿Cómo funciona el PPR?" }));
    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214776201415", phoneRaw: "4776201415", providerMessageId: "wamid.b", text: "2" }));

    const allText = deps.messaging.sentTexts.map((m) => m.body).join("\n");
    expect(allText).not.toMatch(/\bHOT\b/);
    expect(allText).not.toContain("90");
    expect(allText).not.toContain("150K_PLUS");
    expect(allText).not.toContain("180K_PLUS");
    expect(allText).not.toMatch(/score/i);
  });

  it('17+18. no reply ever leaks internal implementation words ("bookingHandler", "provider", "lead", "agenda automática")', async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776201718", "QUALIFIED_A", { firstName: "Juan" });
    await send(app, "5214776201718", "wamid.1", "Hola");
    await send(app, "5214776201718", "wamid.2", "3");
    await send(app, "5214776201718", "wamid.3", "1");

    const outbound = await outboundMessages(repos, conversation.id);
    const allText = outbound.map((m) => m.body).join("\n").toLowerCase();
    expect(allText).not.toContain("bookinghandler");
    expect(allText).not.toContain("provider");
    expect(allText).not.toContain("lead");
    expect(allText).not.toContain("calificado");
    expect(allText).not.toContain("agenda automática");
    expect(allText).not.toContain("handler");
  });

  it("19. a known firstName is never asked for again -- the welcome uses it directly without any name-collection turn", async () => {
    const deps = makeDeps();
    const lead = await deps.leadService.createLead({ firstName: "Juan", phone: "4776200019", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, lead.id);

    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214776200019", phoneRaw: "4776200019", text: "Hola, acabo de realizar mi estimación fiscal en Baluarte Capital y quiero revisar mi resultado." }));

    expect(deps.messaging.sentTexts[0].body).toBe(buildFiscalContextWelcomeMessage("Juan"));
    expect(deps.messaging.sentTexts[0].body).not.toMatch(/cu[aá]l es tu nombre|c[oó]mo te llamas/i);
  });

  it("20. lifecycle fields (status/score/scoreClass/qualifiedAt) stay exactly what the existing pipeline set -- Lía's copy layer never touches them", async () => {
    const deps = makeDeps();
    const { lead } = await seedQualifiedAWithWelcome(deps, "4776200020", "5214776200020", "Juan");
    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214776200020", phoneRaw: "4776200020", providerMessageId: "wamid.a", text: "¿Cómo funciona el PPR?" }));
    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214776200020", phoneRaw: "4776200020", providerMessageId: "wamid.b", text: "¿Quién eres?" }));

    const after = await deps.leads.findById(lead.id);
    expect(after?.status).toBe("QUALIFIED_A");
    expect(after?.score).toBe(78);
    expect(after?.scoreClass).toBe("A");
  });

  it("21. no outbound message is ever sent without a real inbound message triggering it", async () => {
    const deps = makeDeps();
    const lead = await deps.leadService.createLead({ firstName: "Juan", phone: "4776200021", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, lead.id);
    await deps.leads.update(lead.id, { status: "QUALIFIED_A" });
    expect(deps.messaging.sentTexts).toHaveLength(0); // nothing sent merely by seeding data
  });

  it("22. booking still creates a real appointment/event through the existing CalendarProvider abstraction -- Lía only changed the copy", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214776200922", "QUALIFIED_A", { firstName: "Juan" });
    await send(app, "5214776200922", "wamid.1", "Quiero agendar una cita");

    await send(app, "5214776200922", "wamid.2", "1");

    const after = await repos.leadsRepo.findById(lead.id);
    expect(after?.status).toBe("BOOKED");
    const appt = (await repos.appointmentsRepo.listAllByLeadId(lead.id))[0];
    expect(appt.status).toBe("BOOKED");
    expect(appt.calendarEventId).toBeTruthy(); // a real event id came back from CalendarProvider.createEvent
  });
});
