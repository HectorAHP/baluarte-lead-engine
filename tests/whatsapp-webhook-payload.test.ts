import { describe, expect, it } from "vitest";
import { extractWhatsAppMessages } from "../src/domain/whatsapp-webhook-payload.js";

function textWebhook(overrides: { type?: string; body?: string } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ profile: { name: "Ana" }, wa_id: "5214771234567" }],
              messages: [
                overrides.type && overrides.type !== "text"
                  ? { from: "5214771234567", id: "wamid.1", type: overrides.type }
                  : { from: "5214771234567", id: "wamid.1", type: "text", text: { body: overrides.body ?? "Hola" } },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("extractWhatsAppMessages", () => {
  it("extracts a text message with sender, id, and display name", () => {
    const result = extractWhatsAppMessages(textWebhook({ body: "Quiero información" }));
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      kind: "text",
      whatsappUserId: "5214771234567",
      phoneRaw: "5214771234567",
      displayName: "Ana",
      providerMessageId: "wamid.1",
      text: "Quiero información",
    });
  });

  it("marks a non-text message as unsupported instead of crashing", () => {
    const result = extractWhatsAppMessages(textWebhook({ type: "image" }));
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({ kind: "unsupported", whatsappUserId: "5214771234567", providerMessageId: "wamid.1", messageType: "image" });
  });

  it.each(["audio", "video", "document", "location", "reaction", "interactive"])("marks %s as unsupported", (type) => {
    const result = extractWhatsAppMessages(textWebhook({ type }));
    expect(result![0].kind).toBe("unsupported");
  });

  it("returns an empty list for a status-callback-shaped payload (no messages field)", () => {
    const result = extractWhatsAppMessages({
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", statuses: [{ id: "wamid.1", status: "delivered" }] } }] }],
    });
    expect(result).toEqual([]);
  });

  it("returns null for a payload that doesn't match the webhook envelope at all", () => {
    expect(extractWhatsAppMessages({ totally: "unrelated" })).toEqual([]);
    expect(extractWhatsAppMessages("not even an object")).toBeNull();
    expect(extractWhatsAppMessages(null)).toBeNull();
  });
});
