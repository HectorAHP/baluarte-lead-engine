import { describe, it, expect } from "vitest";
import { classifyCommitmentReply } from "../src/domain/booking-commitment-detection.js";

describe("classifyCommitmentReply (Fase 7K sections 14/15/16)", () => {
  it("1. 'no' -> CONFIRMED", () => expect(classifyCommitmentReply("no")).toBe("CONFIRMED"));
  it("2. 'no, todo bien' -> CONFIRMED", () => expect(classifyCommitmentReply("no, todo bien")).toBe("CONFIRMED"));
  it("3. 'ninguno' -> CONFIRMED", () => expect(classifyCommitmentReply("ninguno")).toBe("CONFIRMED"));
  it("4. 'sin problema' -> CONFIRMED", () => expect(classifyCommitmentReply("sin problema")).toBe("CONFIRMED"));
  it("5. 'ahí estaré' -> CONFIRMED", () => expect(classifyCommitmentReply("ahí estaré")).toBe("CONFIRMED"));
  it("6. 'me funciona' -> CONFIRMED", () => expect(classifyCommitmentReply("me funciona")).toBe("CONFIRMED"));
  it("7. 'confirmado' -> CONFIRMED", () => expect(classifyCommitmentReply("confirmado")).toBe("CONFIRMED"));
  it("8. 'sin inconveniente' -> CONFIRMED", () => expect(classifyCommitmentReply("sin inconveniente")).toBe("CONFIRMED"));
  it("9. 'tal vez tenga junta' -> OBSTACLE", () => expect(classifyCommitmentReply("tal vez tenga junta")).toBe("OBSTACLE"));
  it("10. 'depende del trabajo' -> OBSTACLE", () => expect(classifyCommitmentReply("depende del trabajo")).toBe("OBSTACLE"));
  it("11. 'no estoy seguro' -> OBSTACLE (not CONFIRMED, despite containing 'no')", () =>
    expect(classifyCommitmentReply("no estoy seguro")).toBe("OBSTACLE"));
  it("12. 'podría complicarse' -> OBSTACLE", () => expect(classifyCommitmentReply("podría complicarse")).toBe("OBSTACLE"));
  it("13. 'tal vez no pueda' -> OBSTACLE", () => expect(classifyCommitmentReply("tal vez no pueda")).toBe("OBSTACLE"));
  it("14. unrelated text -> AMBIGUOUS", () => expect(classifyCommitmentReply("¿cuánto cuesta el seguro de auto?")).toBe("AMBIGUOUS"));
  it("15. bare 'seguro' -> CONFIRMED (colloquial 'sure')", () => expect(classifyCommitmentReply("seguro")).toBe("CONFIRMED"));
  it("16. 'seguro' embedded in an insurance question -> AMBIGUOUS, never CONFIRMED (domain-collision guard)", () =>
    expect(classifyCommitmentReply("también quiero saber del seguro de vida")).toBe("AMBIGUOUS"));
});
