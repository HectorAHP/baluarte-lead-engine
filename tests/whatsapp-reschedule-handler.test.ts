import { describe, it, expect, vi } from "vitest";
import { WhatsAppRescheduleHandler } from "../src/application/whatsapp-reschedule-handler.js";
import { AppointmentRescheduleService } from "../src/application/appointment-reschedule-service.js";
import { AppointmentCancellationService } from "../src/application/appointment-cancellation-service.js";
import { SlotOfferingService } from "../src/application/slot-offering-service.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryAppointmentRepository,
  InMemoryMessageRepository, InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository,
  InMemoryAppointmentCancellationRepository, InMemoryAppointmentRescheduleRepository,
  InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import type { Lead } from "../src/domain/lead.js";

function makeHandler() {
  const leads = new InMemoryLeadRepository();
  const conversations = new InMemoryConversationRepository();
  const appointments = new InMemoryAppointmentRepository();
  const offeredSlots = new InMemoryOfferedSlotRepository();
  const slotOfferClaims = new InMemorySlotOfferClaimRepository();
  const messages = new InMemoryMessageRepository();
  const messaging = new FakeMessagingProvider();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const appointmentStatusHistory = new InMemoryAppointmentStatusHistoryRepository();
  const cancellations = new InMemoryAppointmentCancellationRepository();
  const reschedules = new InMemoryAppointmentRescheduleRepository();
  const calendar = new FakeCalendarProvider();
  const logger = new FakeLogger();
  const cancellationService = new AppointmentCancellationService(calendar, appointments, cancellations, appointmentStatusHistory, logger);
  const rescheduleService = new AppointmentRescheduleService(calendar, appointments, reschedules, appointmentStatusHistory, cancellationService, logger);
  const slotOffering = new SlotOfferingService(calendar, offeredSlots, appointments, leads, slotOfferClaims, leadStatusHistory, logger);
  const handler = new WhatsAppRescheduleHandler(
    { leads, conversations, appointments, offeredSlots, slotOffering, rescheduleService, messaging, messages, leadStatusHistory, logger },
    "America/Mexico_City",
  );
  return { leads, conversations, appointments, offeredSlots, messages, messaging, leadStatusHistory, appointmentStatusHistory, cancellations, reschedules, calendar, logger, handler };
}

async function makeBookedLeadWithAppointment(h: ReturnType<typeof makeHandler>) {
  const lead = await h.leads.create({
    country: "MX", productVertical: "GMM", status: "BOOKED", score: 71,
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214771234567",
    // Realistic original-booking data: bookedAt is set once, at the original booking, and must
    // NEVER change on a later reschedule -- meetingAt starts at the original appointment's time.
    bookedAt: new Date("2026-02-20T10:00:00.000Z"),
    meetingAt: new Date("2026-03-02T15:00:00.000Z"),
  });
  const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  const appointment = await h.appointments.create({
    leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"),
    endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-1",
  });
  return { lead, conversation, appointment };
}

const NOW = new Date("2026-03-01T09:00:00.000Z");

describe("WhatsAppRescheduleHandler -- intent turn (BOOKED)", () => {
  it("BOOKED + reschedule-intent turn -> RESCHEDULE_REQUESTED, sends intro + new slot options", async () => {
    const h = makeHandler();
    const { lead, conversation } = await makeBookedLeadWithAppointment(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "quiero reagendar", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    expect(h.messaging.sentTexts.length).toBeGreaterThanOrEqual(2);
    expect(h.messaging.sentTexts[0].body).toContain("puedo ayudarte a cambiar tu cita");
    expect(h.messaging.sentTexts[1].body).toContain("Responde con el número");
    const history = await h.leadStatusHistory.listByLeadId(lead.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "RESCHEDULE_REQUESTED", eventType: "RESCHEDULE_REQUESTED" });
  });

  it("BOOKED with no active appointment -> HUMAN_HANDOFF", async () => {
    const h = makeHandler();
    const lead = await h.leads.create({ country: "MX", productVertical: "GMM", status: "BOOKED", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true });
    const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "quiero reagendar", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
  });

  it("BOOKED with more than one active appointment -> HUMAN_HANDOFF", async () => {
    const h = makeHandler();
    const { lead, conversation } = await makeBookedLeadWithAppointment(h);
    await h.appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-03T15:00:00.000Z"), endsAt: new Date("2026-03-03T15:30:00.000Z"), timezone: "America/Mexico_City" });

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "quiero reagendar", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
  });
});

async function toRescheduleRequested(h: ReturnType<typeof makeHandler>) {
  const ctx = await makeBookedLeadWithAppointment(h);
  await h.handler.handleTurn({ lead: ctx.lead, conversationId: ctx.conversation.id, whatsappUserId: "5214771234567", inboundText: "quiero reagendar", now: NOW });
  const pendingLead = (await h.leads.findById(ctx.lead.id))!;
  const activeSlots = await h.offeredSlots.listActiveByConversationId(ctx.conversation.id, NOW);
  return { ...ctx, pendingLead, activeSlots };
}

describe("WhatsAppRescheduleHandler -- RESCHEDULE_REQUESTED turn", () => {
  it("valid slot selection -> new appointment BOOKED (rescheduledFrom = old.id), old -> RESCHEDULED, lead -> BOOKED, confirmation message with the new date", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);
    const originalBookedAt = pendingLead.bookedAt;
    expect(originalBookedAt).toBeTruthy();

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW });

    const finalLead = await h.leads.findById(pendingLead.id);
    expect(finalLead?.status).toBe("BOOKED");
    const oldAppt = await h.appointments.findById(appointment.id);
    expect(oldAppt?.status).toBe("RESCHEDULED");
    const newAppt = await h.appointments.findActiveByLeadId(pendingLead.id);
    expect(newAppt?.rescheduledFrom).toBe(appointment.id);
    expect(newAppt?.id).not.toBe(appointment.id);

    // A: meetingAt syncs to the NEW appointment's time, never the old one.
    expect(finalLead?.meetingAt?.getTime()).toBe(newAppt!.startsAt.getTime());
    expect(finalLead?.meetingAt?.getTime()).not.toBe(appointment.startsAt.getTime());
    // B: bookedAt is preserved from the original booking -- never overwritten by a reschedule.
    expect(finalLead?.bookedAt?.getTime()).toBe(originalBookedAt!.getTime());

    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).toContain("tu cita fue reagendada");

    const leadHistory = await h.leadStatusHistory.listByLeadId(pendingLead.id);
    expect(leadHistory.map((r) => [r.fromStatus, r.toStatus])).toEqual([
      ["BOOKED", "RESCHEDULE_REQUESTED"],
      ["RESCHEDULE_REQUESTED", "BOOKED"],
    ]);
    const apptHistory = await h.appointmentStatusHistory.listByAppointmentId(appointment.id);
    expect(apptHistory).toHaveLength(1);
    expect(apptHistory[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "RESCHEDULED" });
  });

  it("C: a stale-snapshot retry AFTER a completed reschedule never corrupts the already-correct meetingAt/status, and never duplicates history -- findTargetAppointment re-resolves against the NOW-active new appointment (old is RESCHEDULED, no longer 'active'), so this retry is harmlessly absorbed as a fresh (spurious but inert) offer round rather than re-entering the confirmation path -- see the D test below for the genuinely concurrent case that DOES re-enter it", async () => {
    const h = makeHandler();
    const { pendingLead, conversation } = await toRescheduleRequested(h);
    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW });
    const afterFirst = (await h.leads.findById(pendingLead.id))!;
    const newAppt = await h.appointments.findActiveByLeadId(pendingLead.id);
    expect(afterFirst.meetingAt?.getTime()).toBe(newAppt!.startsAt.getTime());
    const historyCountAfterFirst = (await h.leadStatusHistory.listByLeadId(pendingLead.id)).length;

    // A retry turn holding the SAME stale RESCHEDULE_REQUESTED snapshot as before the first call.
    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW });

    const afterRetry = await h.leads.findById(pendingLead.id);
    expect(afterRetry?.status).toBe("BOOKED");
    expect(afterRetry?.meetingAt?.getTime()).toBe(newAppt!.startsAt.getTime()); // never reverted to old, never corrupted
    const historyCountAfterRetry = (await h.leadStatusHistory.listByLeadId(pendingLead.id)).length;
    expect(historyCountAfterRetry).toBe(historyCountAfterFirst); // no duplicate row
  });

  it("C2: TWO genuinely concurrent selections of the SAME slot (both reading the old appointment as still-active before either's CAS lands) converge through ensureLeadBookedAfterReschedule's idempotent/self-heal branch -- meetingAt is set exactly once, to the new appointment's time, never duplicated or reverted", async () => {
    const h = makeHandler();
    const { pendingLead, conversation } = await toRescheduleRequested(h);

    await Promise.all([
      h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW }),
      h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW }),
    ]);

    const finalLead = await h.leads.findById(pendingLead.id);
    const newAppt = await h.appointments.findActiveByLeadId(pendingLead.id);
    expect(finalLead?.status).toBe("BOOKED");
    expect(finalLead?.meetingAt?.getTime()).toBe(newAppt!.startsAt.getTime());
    const leadHistory = await h.leadStatusHistory.listByLeadId(pendingLead.id);
    expect(leadHistory.filter((r) => r.toStatus === "BOOKED")).toHaveLength(1); // one winner, one write
  });

  it("D: self-heal -- a lead already BOOKED with a STALE meetingAt (e.g. legacy data from before this fix, or any future bug) is corrected to newAppointment.startsAt the next time ensureLeadBookedAfterReschedule runs for it, with no history row for the pure field correction. This exact branch (current.status already 'BOOKED' when re-read) is unreachable through the public handleTurn API once a reschedule has genuinely completed -- findTargetAppointment always re-resolves against listActiveByLeadId, and the OLD appointment is no longer active once RESCHEDULED, so a later turn can never re-target it. It exists as defense-in-depth insurance (the genuinely-concurrent C2 case above also passes through it, as a no-op) and as the mechanism that would self-heal a lead like this if it were ever reprocessed -- exercised directly here since the public API cannot reach it after the fact.", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);
    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW });
    const newAppt = (await h.appointments.findActiveByLeadId(pendingLead.id))!;
    // Simulate the exact legacy artifact the real production lead had: lead BOOKED, meetingAt
    // still the OLD appointment's time.
    await h.leads.update(pendingLead.id, { meetingAt: appointment.startsAt });
    const staleLead = (await h.leads.findById(pendingLead.id))!;
    expect(staleLead.meetingAt?.getTime()).toBe(appointment.startsAt.getTime());
    const historyCountBeforeHeal = (await h.leadStatusHistory.listByLeadId(pendingLead.id)).length;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const healed: typeof staleLead = await (h.handler as any).ensureLeadBookedAfterReschedule(staleLead, newAppt);

    expect(healed.status).toBe("BOOKED");
    expect(healed.meetingAt?.getTime()).toBe(newAppt.startsAt.getTime()); // healed to the NEW appointment, never old
    expect((await h.leadStatusHistory.listByLeadId(pendingLead.id)).length).toBe(historyCountBeforeHeal); // no history row for a pure field self-heal
  });

  it("invalid text never reschedules -- resends the same active slots", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "no se", now: NOW });

    expect((await h.leads.findById(pendingLead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED");
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    // Pre-launch hardening: no longer the terse "Por favor responde 1, 2 o 3" nag -- a friendlier
    // fallback that still restates the active options and points at the real escape hatch
    // (cancellation-intent, already handled above this check -- see handOffToCancellation).
    expect(lastMessage.body).toContain("Estamos en el proceso de cambiar tu cita");
    expect(lastMessage.body).toContain("Responde con el número de la opción que prefieras");
  });

  it("'otro horario' (DECLINED) fetches a new round instead of rescheduling", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "otro horario", now: NOW });

    expect((await h.leads.findById(pendingLead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED");
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).toContain("Ese horario acaba de ocuparse");
  });

  it("item 13: 'cancelar cita' while RESCHEDULE_REQUESTED hands off to CANCEL_PENDING with the SAME confirmation prompt cancellation uses from BOOKED", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "cancelar cita", now: NOW });

    expect((await h.leads.findById(pendingLead.id))?.status).toBe("CANCEL_PENDING");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED"); // untouched -- only the lead moved to CANCEL_PENDING
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).toContain("1. Sí, cancelar");
    const history = await h.leadStatusHistory.listByLeadId(pendingLead.id);
    expect(history[history.length - 1]).toMatchObject({ fromStatus: "RESCHEDULE_REQUESTED", toStatus: "CANCEL_PENDING", eventType: "CANCELLATION_REQUESTED" });
  });

  it("duplicate selection (two turns racing the same RESCHEDULE_REQUESTED slot) is idempotent: exactly one reschedule, lead ends BOOKED once, no duplicate appointment history", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);

    await Promise.all([
      h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW }),
      h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW }),
    ]);

    expect((await h.leads.findById(pendingLead.id))?.status).toBe("BOOKED");
    const apptHistory = await h.appointmentStatusHistory.listByAppointmentId(appointment.id);
    expect(apptHistory).toHaveLength(1);
    const leadHistory = await h.leadStatusHistory.listByLeadId(pendingLead.id);
    expect(leadHistory.filter((r) => r.toStatus === "BOOKED")).toHaveLength(1);
  });
});

describe("WhatsAppRescheduleHandler -- item 13: cancellation-vs-reschedule race", () => {
  it("reschedule completing AFTER a concurrent cancellation-handoff already set CANCEL_PENDING never forces the lead back to BOOKED -- the reschedule's DB effects still land (new appointment BOOKED, old RESCHEDULED), but the pending cancellation question is never silently discarded", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);

    // Simulate Turn B (a concurrent "cancelar cita" handoff) landing FIRST, moving the lead to
    // CANCEL_PENDING behind Turn A's back -- the appointment itself is untouched by this (a
    // cancellation handoff never touches the appointment, only the lead).
    await h.leads.update(pendingLead.id, { status: "CANCEL_PENDING" });

    // Turn A (a valid slot selection, "1") still holds the STALE RESCHEDULE_REQUESTED snapshot.
    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW });

    // The reschedule's own DB truth still lands correctly.
    expect((await h.appointments.findById(appointment.id))?.status).toBe("RESCHEDULED");
    const newAppt = await h.appointments.findActiveByLeadId(pendingLead.id);
    expect(newAppt?.status).toBe("BOOKED");
    expect(newAppt?.rescheduledFrom).toBe(appointment.id);

    // But the lead's CANCEL_PENDING (representing the user's still-open cancellation question)
    // is NEVER silently overwritten back to BOOKED.
    expect((await h.leads.findById(pendingLead.id))?.status).toBe("CANCEL_PENDING");
    const history = await h.leadStatusHistory.listByLeadId(pendingLead.id);
    expect(history.some((r) => r.eventType === "RESCHEDULE_CONFIRMED")).toBe(false);
  });

  it("'cancelar cita' arriving from a stale RESCHEDULE_REQUESTED snapshot, after a concurrent reschedule selection already resolved the lead to BOOKED, is left unactioned -- no CANCEL_PENDING, no message, no misleading history row", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);

    // Simulate Turn A (a valid slot selection) completing FIRST -- lead now BOOKED with a new
    // appointment.
    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW });
    expect((await h.leads.findById(pendingLead.id))?.status).toBe("BOOKED");
    const messageCountBeforeRace = h.messaging.sentTexts.length;

    // Turn B ("cancelar cita") still holds the STALE RESCHEDULE_REQUESTED snapshot from before
    // Turn A ran.
    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "cancelar cita", now: NOW });

    // Left completely unactioned -- lead stays BOOKED (never forced into CANCEL_PENDING against a
    // stale precondition), no new message sent, no history row for this turn.
    expect((await h.leads.findById(pendingLead.id))?.status).toBe("BOOKED");
    expect(h.messaging.sentTexts.length).toBe(messageCountBeforeRace);
    const history = await h.leadStatusHistory.listByLeadId(pendingLead.id);
    expect(history.some((r) => r.toStatus === "CANCEL_PENDING")).toBe(false);
    expect((await h.appointments.findById(appointment.id))?.status).toBe("RESCHEDULED"); // untouched by the race
  });
});

describe("WhatsAppRescheduleHandler -- item 9/12.B/12.C: mandatory reschedule-context invariant (defense-in-depth)", () => {
  it("item 12.B: never accepts a selected slot whose rescheduleContextId is undefined (a leaked booking-context slot) -- no Calendar call, no appointment created, old untouched", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);
    // Simulate a filtering bug (or data corruption) by injecting a booking-context slot into what
    // listActiveByConversationId returns for THIS turn -- the real, fixed repository can never
    // produce this on its own now (see the root-cause fix), so this directly exercises the
    // handler's OWN defense-in-depth check rather than the repository's filter.
    const leakedSlot = { id: "leaked-booking-slot", conversationId: conversation.id, leadId: pendingLead.id, roundId: "leaked-round", slotStart: new Date("2026-03-02T18:00:00.000Z"), slotEnd: new Date("2026-03-02T18:30:00.000Z"), position: 1, expiresAt: new Date("2026-03-01T10:00:00.000Z"), selected: false, createdAt: NOW, rescheduleContextId: undefined };
    vi.spyOn(h.offeredSlots, "listActiveByConversationId").mockResolvedValueOnce([leakedSlot]);
    const createEventSpy = vi.spyOn(h.calendar, "createEvent");

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW });

    expect(createEventSpy).not.toHaveBeenCalled();
    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED"); // untouched
    expect((await h.leads.findById(pendingLead.id))?.status).toBe("RESCHEDULE_REQUESTED"); // untouched
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).toContain("Por favor responde");
  });

  it("item 12.C: never accepts a selected slot whose rescheduleContextId belongs to a DIFFERENT reschedule episode (old=B when the current old appointment is A) -- no Calendar call, no appointment created, old untouched", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);
    const wrongContextSlot = { id: "wrong-context-slot", conversationId: conversation.id, leadId: pendingLead.id, roundId: "other-episode-round", slotStart: new Date("2026-03-02T18:00:00.000Z"), slotEnd: new Date("2026-03-02T18:30:00.000Z"), position: 1, expiresAt: new Date("2026-03-01T10:00:00.000Z"), selected: false, createdAt: NOW, rescheduleContextId: "some-other-old-appointment-id" };
    vi.spyOn(h.offeredSlots, "listActiveByConversationId").mockResolvedValueOnce([wrongContextSlot]);
    const createEventSpy = vi.spyOn(h.calendar, "createEvent");

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW });

    expect(createEventSpy).not.toHaveBeenCalled();
    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED"); // untouched
    expect((await h.leads.findById(pendingLead.id))?.status).toBe("RESCHEDULE_REQUESTED"); // untouched
  });
});

describe("WhatsAppRescheduleHandler -- privacy", () => {
  it("no history row anywhere contains inbound message text or clinical content", async () => {
    const h = makeHandler();
    const { lead, conversation } = await makeBookedLeadWithAppointment(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "quiero reagendar, tengo una cirugía", now: NOW });

    const leadHistory = await h.leadStatusHistory.listByLeadId(lead.id);
    for (const row of leadHistory) {
      expect(JSON.stringify(row.metadata)).not.toContain("cirugía");
      expect(row.eventType).not.toContain("cirugía");
    }
  });
});
