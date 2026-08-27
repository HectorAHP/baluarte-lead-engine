import { describe, it, expect } from "vitest";
import { parseSlotSelection } from "../src/domain/slot-selection-parser.js";
import { ActiveOfferInconsistentError } from "../src/domain/errors.js";
import type { OfferedSlot } from "../src/domain/offered-slot.js";

const now = new Date("2026-03-02T12:00:00.000Z");

function makeActiveSlots(): OfferedSlot[] {
  const roundId = "round-1";
  const conversationId = "conv-1";
  return [1, 2, 3].map((position) => ({
    id: `slot-${position}`,
    conversationId,
    leadId: "lead-1",
    roundId,
    slotStart: new Date("2026-03-03T15:00:00.000Z"),
    slotEnd: new Date("2026-03-03T15:30:00.000Z"),
    position,
    expiresAt: new Date(now.getTime() + 600_000),
    selected: false,
    createdAt: new Date(now.getTime() - 1_000),
  }));
}

describe("parseSlotSelection -- SELECTED", () => {
  it("A: \"1\" selects position 1", () => {
    const slots = makeActiveSlots();
    const result = parseSlotSelection("1", slots, now);
    expect(result).toEqual({ type: "SELECTED", slot: slots[0] });
  });

  it("B: \"2\" selects position 2", () => {
    const slots = makeActiveSlots();
    const result = parseSlotSelection("2", slots, now);
    expect(result).toEqual({ type: "SELECTED", slot: slots[1] });
  });

  it("C: \"3\" selects position 3", () => {
    const slots = makeActiveSlots();
    const result = parseSlotSelection("3", slots, now);
    expect(result).toEqual({ type: "SELECTED", slot: slots[2] });
  });

  it("accepts trivial, unambiguous variants: \"opcion 1\", \"la 2\", \"el 3\"", () => {
    const slots = makeActiveSlots();
    expect(parseSlotSelection("opción 1", slots, now)).toEqual({ type: "SELECTED", slot: slots[0] });
    expect(parseSlotSelection("La 2", slots, now)).toEqual({ type: "SELECTED", slot: slots[1] });
    expect(parseSlotSelection("el 3", slots, now)).toEqual({ type: "SELECTED", slot: slots[2] });
  });
});

describe("parseSlotSelection -- INVALID", () => {
  it("D: \"4\" (no such active position) -> INVALID", () => {
    expect(parseSlotSelection("4", makeActiveSlots(), now)).toEqual({ type: "INVALID" });
  });

  it("E: \"10\" is parsed as the number ten, not truncated to \"1\" -- INVALID", () => {
    expect(parseSlotSelection("10", makeActiveSlots(), now)).toEqual({ type: "INVALID" });
  });

  it("does not interpret a number embedded in unrelated text (age, postal code, quantity)", () => {
    const slots = makeActiveSlots();
    expect(parseSlotSelection("tengo 10 años", slots, now)).toEqual({ type: "INVALID" });
    expect(parseSlotSelection("mi cp es 10500", slots, now)).toEqual({ type: "INVALID" });
    expect(parseSlotSelection("quiero 2 pólizas", slots, now)).toEqual({ type: "INVALID" });
  });

  it("F: ambiguous free text -> INVALID", () => {
    expect(parseSlotSelection("no se, tal vez el jueves", makeActiveSlots(), now)).toEqual({ type: "INVALID" });
  });

  it("G: a position that exists in the array but is already expired -> INVALID", () => {
    const slots = makeActiveSlots();
    slots[0] = { ...slots[0], expiresAt: new Date(now.getTime() - 1_000) };
    expect(parseSlotSelection("1", slots, now)).toEqual({ type: "INVALID" });
  });

  it("H: a position that exists in the array but is already selected -> INVALID", () => {
    const slots = makeActiveSlots();
    slots[0] = { ...slots[0], selected: true };
    expect(parseSlotSelection("1", slots, now)).toEqual({ type: "INVALID" });
  });

  it("an empty active slot list -> INVALID, never throws", () => {
    expect(parseSlotSelection("1", [], now)).toEqual({ type: "INVALID" });
  });
});

describe("parseSlotSelection -- DECLINED", () => {
  it.each([
    "ninguno",
    "ninguna",
    "ningún horario",
    "otro horario",
    "otros horarios",
    "prefiero otro",
    "prefiero otro horario",
    "ninguno me funciona",
    "NINGUNO", // case-insensitive
    "  ninguno  ", // trimmed
    "Ningún   Horario", // accents + extra whitespace normalized
  ])("I: %j is recognized as DECLINED", (text) => {
    expect(parseSlotSelection(text, makeActiveSlots(), now)).toEqual({ type: "DECLINED" });
  });
});

describe("parseSlotSelection -- round consistency", () => {
  it("J: active slots spanning multiple roundIds -- throws ActiveOfferInconsistentError, never selects across rounds", () => {
    const slots = makeActiveSlots();
    slots[2] = { ...slots[2], roundId: "round-2" };
    expect(() => parseSlotSelection("1", slots, now)).toThrow(ActiveOfferInconsistentError);
  });
});
