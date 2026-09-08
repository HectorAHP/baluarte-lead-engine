import { describe, it, expect } from "vitest";
import { selectDiverseSlots } from "../src/domain/slot-diversity.js";
import { resolveDatePreferenceForRound } from "../src/domain/date-preference.js";

const TZ = "America/Mexico_City";

function slot(iso: string) {
  return { start: new Date(iso) };
}

describe("selectDiverseSlots (Fase 7K section 6)", () => {
  it("1. returns [] for an empty input", () => {
    expect(selectDiverseSlots([], 3, TZ)).toEqual([]);
  });

  it("2. returns [] when maxSlots is 0", () => {
    expect(selectDiverseSlots([slot("2026-09-08T15:00:00Z")], 0, TZ)).toEqual([]);
  });

  it("3. picks at most one slot per distinct local date across a spread week", () => {
    const slots = [
      slot("2026-09-08T15:00:00Z"), // Tue 09:00 local
      slot("2026-09-08T16:00:00Z"), // Tue 10:00 local -- same date as above
      slot("2026-09-09T15:00:00Z"), // Wed
      slot("2026-09-10T15:00:00Z"), // Thu
      slot("2026-09-11T15:00:00Z"), // Fri
    ];
    const result = selectDiverseSlots(slots, 3, TZ);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(slots[0]); // first Tue slot, not the second
    expect(result[1]).toBe(slots[2]); // Wed
    expect(result[2]).toBe(slots[3]); // Thu
  });

  it("4. keeps chronological order in the output", () => {
    const slots = [slot("2026-09-08T15:00:00Z"), slot("2026-09-09T15:00:00Z"), slot("2026-09-10T15:00:00Z")];
    const result = selectDiverseSlots(slots, 3, TZ);
    expect(result.map((s) => s.start.getTime())).toEqual(result.map((s) => s.start.getTime()).slice().sort((a, b) => a - b));
  });

  it("5. fills remaining budget with a second same-day slot when fewer than maxSlots distinct dates exist", () => {
    const slots = [
      slot("2026-09-08T15:00:00Z"), // Tue 09:00
      slot("2026-09-08T16:00:00Z"), // Tue 10:00
      slot("2026-09-08T17:00:00Z"), // Tue 11:00
    ];
    const result = selectDiverseSlots(slots, 3, TZ);
    expect(result).toHaveLength(3);
    expect(result).toEqual(slots);
  });

  it("6. returns fewer than maxSlots when fewer slots exist in total", () => {
    const slots = [slot("2026-09-08T15:00:00Z")];
    const result = selectDiverseSlots(slots, 3, TZ);
    expect(result).toHaveLength(1);
  });

  it("7. never invents a slot not present in the input", () => {
    const slots = [slot("2026-09-08T15:00:00Z"), slot("2026-09-09T15:00:00Z")];
    const result = selectDiverseSlots(slots, 3, TZ);
    for (const r of result) expect(slots).toContain(r);
  });

  it("8. respects maxSlots even with many distinct dates available", () => {
    const slots = Array.from({ length: 10 }, (_, i) => slot(`2026-09-${String(8 + i).padStart(2, "0")}T15:00:00Z`));
    const result = selectDiverseSlots(slots, 3, TZ);
    expect(result).toHaveLength(3);
  });

  it("9. is a pure function -- does not mutate the input array", () => {
    const slots = [slot("2026-09-08T15:00:00Z"), slot("2026-09-08T16:00:00Z"), slot("2026-09-09T15:00:00Z")];
    const copy = [...slots];
    selectDiverseSlots(slots, 2, TZ);
    expect(slots).toEqual(copy);
  });

  it("10. two distinct dates with maxSlots=3 fills the third from the second date", () => {
    const slots = [
      slot("2026-09-08T15:00:00Z"), // Tue
      slot("2026-09-09T15:00:00Z"), // Wed
      slot("2026-09-09T16:00:00Z"), // Wed second slot
    ];
    const result = selectDiverseSlots(slots, 3, TZ);
    expect(result).toHaveLength(3);
    expect(result).toEqual(slots);
  });
});

describe("resolveDatePreferenceForRound (Fase 7K section 21)", () => {
  function roundSlot(startIso: string, endIso: string) {
    return { slotStart: new Date(startIso), slotEnd: new Date(endIso) };
  }

  it("1. all slots on the same local date -> pins both daypart and targetDate", () => {
    const round = [
      roundSlot("2026-09-08T15:00:00Z", "2026-09-08T15:30:00Z"), // Tue 09:00-09:30 local
      roundSlot("2026-09-08T16:00:00Z", "2026-09-08T16:30:00Z"), // Tue 10:00-10:30 local
    ];
    const pref = resolveDatePreferenceForRound(round, TZ);
    expect(pref).toEqual({ daypart: "MORNING", targetDate: "2026-09-08" });
  });

  it("2. slots spread across distinct dates -> only daypart, never a targetDate", () => {
    const round = [
      roundSlot("2026-09-08T15:00:00Z", "2026-09-08T15:30:00Z"),
      roundSlot("2026-09-09T15:00:00Z", "2026-09-09T15:30:00Z"),
      roundSlot("2026-09-10T15:00:00Z", "2026-09-10T15:30:00Z"),
    ];
    const pref = resolveDatePreferenceForRound(round, TZ);
    expect(pref).toEqual({ daypart: "MORNING" });
  });

  it("3. a single-slot round pins its own date", () => {
    const round = [roundSlot("2026-09-08T19:00:00Z", "2026-09-08T19:30:00Z")]; // 13:00-13:30 local -> AFTERNOON
    const pref = resolveDatePreferenceForRound(round, TZ);
    expect(pref).toEqual({ daypart: "AFTERNOON", targetDate: "2026-09-08" });
  });
});
