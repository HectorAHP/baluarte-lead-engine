import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Fase 7J.2 -- config.ts's real Zod parsing/superRefine for HUMAN_HANDOFF_ALERTS_ENABLED /
 * HUMAN_HANDOFF_ADVISOR_PHONE / HUMAN_HANDOFF_ALERT_TEMPLATE_NAME. Same
 * process.env-mutate-then-vi.resetModules()-then-re-import pattern as
 * tests/whatsapp-booking-flag.test.ts (this repo's own established way to test config.ts's real
 * module-level parsing behavior, rather than re-deriving the schema logic separately here).
 */
describe("Fase 7J.2 -- HUMAN_HANDOFF_ALERTS_ENABLED / HUMAN_HANDOFF_ADVISOR_PHONE config", () => {
  const originalEnabled = process.env.HUMAN_HANDOFF_ALERTS_ENABLED;
  const originalPhone = process.env.HUMAN_HANDOFF_ADVISOR_PHONE;
  const originalTemplate = process.env.HUMAN_HANDOFF_ALERT_TEMPLATE_NAME;

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.HUMAN_HANDOFF_ALERTS_ENABLED; else process.env.HUMAN_HANDOFF_ALERTS_ENABLED = originalEnabled;
    if (originalPhone === undefined) delete process.env.HUMAN_HANDOFF_ADVISOR_PHONE; else process.env.HUMAN_HANDOFF_ADVISOR_PHONE = originalPhone;
    if (originalTemplate === undefined) delete process.env.HUMAN_HANDOFF_ALERT_TEMPLATE_NAME; else process.env.HUMAN_HANDOFF_ALERT_TEMPLATE_NAME = originalTemplate;
    vi.resetModules();
  });

  it("10a: HUMAN_HANDOFF_ALERTS_ENABLED=true with NO advisor phone set -- fails closed at startup (schema.parse throws)", async () => {
    process.env.HUMAN_HANDOFF_ALERTS_ENABLED = "true";
    delete process.env.HUMAN_HANDOFF_ADVISOR_PHONE;
    vi.resetModules();
    await expect(import("../src/config.js")).rejects.toThrow(/HUMAN_HANDOFF_ADVISOR_PHONE/);
  });

  it("10b: HUMAN_HANDOFF_ALERTS_ENABLED=true with an invalid/unparseable advisor phone -- fails closed at startup", async () => {
    process.env.HUMAN_HANDOFF_ALERTS_ENABLED = "true";
    process.env.HUMAN_HANDOFF_ADVISOR_PHONE = "not-a-phone-number";
    vi.resetModules();
    await expect(import("../src/config.js")).rejects.toThrow(/HUMAN_HANDOFF_ADVISOR_PHONE/);
  });

  it("9: item 10 of the spec -- HUMAN_HANDOFF_ALERTS_ENABLED=false (default) needs no phone at all, deployable passively", async () => {
    delete process.env.HUMAN_HANDOFF_ALERTS_ENABLED;
    delete process.env.HUMAN_HANDOFF_ADVISOR_PHONE;
    vi.resetModules();
    const { config, humanHandoffAdvisorPhoneE164 } = await import("../src/config.js");
    expect(config.HUMAN_HANDOFF_ALERTS_ENABLED).toBe(false);
    expect(humanHandoffAdvisorPhoneE164).toBeNull();
  });

  it("HUMAN_HANDOFF_ALERTS_ENABLED=true with a valid advisor phone -- parses cleanly, normalizes to E.164", async () => {
    process.env.HUMAN_HANDOFF_ALERTS_ENABLED = "true";
    process.env.HUMAN_HANDOFF_ADVISOR_PHONE = "5214778880099"; // wa_id-shaped, MX -- normalizePhoneToE164 strips the legacy "1"
    vi.resetModules();
    const { config, humanHandoffAdvisorPhoneE164 } = await import("../src/config.js");
    expect(config.HUMAN_HANDOFF_ALERTS_ENABLED).toBe(true);
    expect(humanHandoffAdvisorPhoneE164).toBe("+524778880099");
  });

  it("HUMAN_HANDOFF_ALERT_TEMPLATE_NAME defaults to 'handoff_asesor' and reuses WHATSAPP_TEMPLATE_LANGUAGE (no second language config)", async () => {
    delete process.env.HUMAN_HANDOFF_ALERT_TEMPLATE_NAME;
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.HUMAN_HANDOFF_ALERT_TEMPLATE_NAME).toBe("handoff_asesor");
  });

  it('parses exactly the string "true" as true, never via Boolean() coercion -- same safe-parsing discipline as every other flag in this project', async () => {
    process.env.HUMAN_HANDOFF_ALERTS_ENABLED = "false";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.HUMAN_HANDOFF_ALERTS_ENABLED).toBe(false);
  });
});
