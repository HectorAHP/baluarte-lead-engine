import { describe, expect, it } from "vitest";
import { mapRowToConversation, mapConversationToInsertRow, mapConversationPatchToRow, type ConversationRow } from "../src/infrastructure/supabase-conversation-repository.js";
import { mapRowToMessage, mapMessageToInsertRow, type MessageRow } from "../src/infrastructure/supabase-message-repository.js";
import { mapRowToQualificationAnswer, mapQualificationAnswerToInsertRow, type QualificationAnswerRow } from "../src/infrastructure/supabase-qualification-answer-repository.js";
import { mapRowToLeadScoreRecord, mapLeadScoreRecordToInsertRow, type LeadScoreRow } from "../src/infrastructure/supabase-lead-score-repository.js";
import { mapRowToOfferedSlot, mapOfferedSlotToInsertRow, mapOfferedSlotPatchToRow, type OfferedSlotRow } from "../src/infrastructure/supabase-offered-slot-repository.js";
import type { Conversation } from "../src/domain/conversation.js";
import type { Message } from "../src/domain/message.js";
import type { QualificationAnswer } from "../src/domain/qualification-answer.js";
import type { LeadScoreRecord } from "../src/domain/lead-score-record.js";
import type { OfferedSlot } from "../src/domain/offered-slot.js";

describe("supabase conversation mapping", () => {
  const row: ConversationRow = {
    id: "c1", lead_id: "l1", channel: "WHATSAPP", status: "ACTIVE",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("maps row to domain", () => {
    const c = mapRowToConversation(row);
    expect(c.leadId).toBe("l1");
    expect(c.status).toBe("ACTIVE");
    expect(c.createdAt).toBeInstanceOf(Date);
  });

  it("maps insert input to snake_case", () => {
    const input: Omit<Conversation, "id" | "createdAt" | "updatedAt"> = { leadId: "l1", channel: "WHATSAPP", status: "ACTIVE" };
    const r = mapConversationToInsertRow(input);
    expect(r.lead_id).toBe("l1");
    expect(r.status).toBe("ACTIVE");
  });

  it("maps patch to snake_case plus updated_at", () => {
    const r = mapConversationPatchToRow({ status: "HUMAN_HANDOFF" });
    expect(r.status).toBe("HUMAN_HANDOFF");
    expect(typeof r.updated_at).toBe("string");
  });
});

describe("supabase message mapping", () => {
  const row: MessageRow = {
    id: "m1", conversation_id: "c1", lead_id: "l1", direction: "INBOUND", channel: "WHATSAPP",
    sender: "5214771234567", body: "hola", provider_message_id: "wamid.abc", ai_generated: false,
    metadata: { foo: "bar" }, created_at: "2026-01-01T00:00:00.000Z",
  };

  it("maps row to domain", () => {
    const m = mapRowToMessage(row);
    expect(m.body).toBe("hola");
    expect(m.direction).toBe("INBOUND");
    expect(m.providerMessageId).toBe("wamid.abc");
    expect(m.metadata).toEqual({ foo: "bar" });
  });

  it("maps null metadata to an empty object, not null", () => {
    const m = mapRowToMessage({ ...row, metadata: null as unknown as Record<string, unknown> });
    expect(m.metadata).toEqual({});
  });

  it("maps insert input to snake_case", () => {
    const input: Omit<Message, "id" | "createdAt"> = {
      conversationId: "c1", leadId: "l1", direction: "OUTBOUND", channel: "WHATSAPP",
      aiGenerated: true, metadata: {}, body: "hola de vuelta",
    };
    const r = mapMessageToInsertRow(input);
    expect(r.conversation_id).toBe("c1");
    expect(r.ai_generated).toBe(true);
    expect(r.provider_message_id).toBeNull();
  });
});

describe("supabase qualification answer mapping", () => {
  const row: QualificationAnswerRow = {
    id: "q1", lead_id: "l1", conversation_id: "c1", vertical: "PATRIMONIAL",
    field_name: "objective", field_value: "retiro", source: "AI_EXTRACTED", created_at: "2026-01-01T00:00:00.000Z",
  };

  it("maps row to domain", () => {
    const a = mapRowToQualificationAnswer(row);
    expect(a.fieldName).toBe("objective");
    expect(a.fieldValue).toBe("retiro");
    expect(a.vertical).toBe("PATRIMONIAL");
  });

  it("maps insert input to snake_case", () => {
    const input: Omit<QualificationAnswer, "id" | "createdAt"> = {
      leadId: "l1", vertical: "GMM", fieldName: "member_count", fieldValue: 4, source: "MANUAL",
    };
    const r = mapQualificationAnswerToInsertRow(input);
    expect(r.field_name).toBe("member_count");
    expect(r.field_value).toBe(4);
    expect(r.conversation_id).toBeNull();
  });
});

describe("supabase lead score mapping", () => {
  const row: LeadScoreRow = {
    id: "s1", lead_id: "l1", vertical: "PATRIMONIAL", total: 93, score_class: "A",
    breakdown: { urgency: 30, monthlyCapacity: 23 }, rules_version: "PATRIMONIAL_QUALIFICATION_V1", created_at: "2026-01-01T00:00:00.000Z",
  };

  it("maps row to domain", () => {
    const s = mapRowToLeadScoreRecord(row);
    expect(s.total).toBe(93);
    expect(s.scoreClass).toBe("A");
    expect(s.breakdown).toEqual({ urgency: 30, monthlyCapacity: 23 });
    expect(s.rulesVersion).toBe("PATRIMONIAL_QUALIFICATION_V1");
  });

  it("maps insert input to snake_case", () => {
    const input: Omit<LeadScoreRecord, "id" | "createdAt"> = {
      leadId: "l1", vertical: "GMM", total: 100, scoreClass: "A", breakdown: { timing: 30 }, rulesVersion: "GMM_QUALIFICATION_V1",
    };
    const r = mapLeadScoreRecordToInsertRow(input);
    expect(r.total).toBe(100);
    expect(r.breakdown).toEqual({ timing: 30 });
    expect(r.rules_version).toBe("GMM_QUALIFICATION_V1");
  });
});

describe("supabase offered slot mapping", () => {
  const row: OfferedSlotRow = {
    id: "o1", conversation_id: "c1", lead_id: "l1", round_id: "r1",
    slot_start: "2026-03-02T15:00:00.000Z", slot_end: "2026-03-02T15:30:00.000Z",
    position: 1, expires_at: "2026-03-02T14:55:00.000Z", selected: false, created_at: "2026-03-02T14:00:00.000Z",
  };

  it("maps row to domain", () => {
    const s = mapRowToOfferedSlot(row);
    expect(s.position).toBe(1);
    expect(s.selected).toBe(false);
    expect(s.slotStart).toBeInstanceOf(Date);
    expect(s.roundId).toBe("r1");
  });

  it("maps insert input to snake_case", () => {
    const input: Omit<OfferedSlot, "id" | "createdAt"> = {
      conversationId: "c1", leadId: "l1", roundId: "r1",
      slotStart: new Date("2026-03-02T15:00:00.000Z"), slotEnd: new Date("2026-03-02T15:30:00.000Z"),
      position: 2, expiresAt: new Date("2026-03-02T14:55:00.000Z"), selected: false,
    };
    const r = mapOfferedSlotToInsertRow(input);
    expect(r.position).toBe(2);
    expect(r.slot_start).toBe("2026-03-02T15:00:00.000Z");
    expect(r.round_id).toBe("r1");
  });

  it("maps a selection patch", () => {
    const r = mapOfferedSlotPatchToRow({ selected: true });
    expect(r.selected).toBe(true);
    expect(r.expires_at).toBeUndefined();
  });
});
