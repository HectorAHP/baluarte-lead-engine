import { describe, it, expect } from "vitest";
import {
  DAYPART_QUESTION_MESSAGE,
  buildCommitmentCheckMessage,
  COMMITMENT_CLARIFICATION_MESSAGE,
  buildCommitmentObstacleMessage,
  COMMITMENT_OBSTACLE_NO_SLOTS_MESSAGE,
} from "../src/domain/message-templates.js";
import type { OfferedSlot } from "../src/domain/offered-slot.js";

const TZ = "America/Mexico_City";

function slot(position: number, iso: string): OfferedSlot {
  return {
    id: `slot-${position}`,
    conversationId: "c1",
    leadId: "l1",
    roundId: "round-1",
    slotStart: new Date(iso),
    slotEnd: new Date(new Date(iso).getTime() + 30 * 60_000),
    position,
    expiresAt: new Date(Date.now() + 20 * 60_000),
    selected: false,
    createdAt: new Date(),
  };
}

describe("Fase 7K message templates", () => {
  it("1. DAYPART_QUESTION_MESSAGE matches the required verbatim copy", () => {
    expect(DAYPART_QUESTION_MESSAGE).toBe(
      "Perfecto. Para buscar algo que realmente te funcione, ¿te acomoda mejor por la mañana o por la tarde?",
    );
  });

  it("2. buildCommitmentCheckMessage embeds the slot's day and time", () => {
    const msg = buildCommitmentCheckMessage(new Date("2026-09-09T17:30:00Z"), TZ); // Wed 11:30 local
    expect(msg).toContain("miércoles 9 a las 11:30 a.m.");
    expect(msg).toMatch(/^Perfecto\. Antes de dejarla reservada:/);
  });

  it("3. buildCommitmentCheckMessage never uses manipulative phrasing", () => {
    const msg = buildCommitmentCheckMessage(new Date("2026-09-09T17:30:00Z"), TZ);
    expect(msg).not.toMatch(/prometes/i);
    expect(msg).not.toMatch(/verdad/i);
    expect(msg).not.toMatch(/comprometas/i);
  });

  it("4. COMMITMENT_CLARIFICATION_MESSAGE matches the required verbatim copy", () => {
    expect(COMMITMENT_CLARIFICATION_MESSAGE).toBe(
      "Solo para confirmar: ¿ese horario lo puedes apartar sin algún compromiso que ya sepas que podría impedirte conectarte?",
    );
  });

  it("5. buildCommitmentObstacleMessage includes the empathetic intro and the new slot list", () => {
    const msg = buildCommitmentObstacleMessage([slot(1, "2026-09-09T17:30:00Z")], TZ);
    expect(msg).toContain("Entendido. Prefiero que encontremos un horario que sí puedas proteger.");
    expect(msg).toContain("1. Miércoles 9");
  });

  it("6. COMMITMENT_OBSTACLE_NO_SLOTS_MESSAGE never fabricates a slot list", () => {
    expect(COMMITMENT_OBSTACLE_NO_SLOTS_MESSAGE).not.toMatch(/\d\.\s/);
  });
});
