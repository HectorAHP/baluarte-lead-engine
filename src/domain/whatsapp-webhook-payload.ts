import { z } from "zod";

const contactSchema = z.object({
  profile: z.object({ name: z.string().optional() }).optional(),
  wa_id: z.string().optional(),
});

const messageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
  })
  .passthrough();

const changeValueSchema = z
  .object({
    contacts: z.array(contactSchema).optional(),
    messages: z.array(messageSchema).optional(),
  })
  .passthrough();

const webhookPayloadSchema = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z
        .object({
          changes: z
            .array(
              z
                .object({
                  value: changeValueSchema,
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    )
    .optional(),
});

export type ExtractedWhatsAppMessage =
  | { kind: "text"; whatsappUserId: string; phoneRaw: string; displayName?: string; providerMessageId: string; text: string }
  | { kind: "unsupported"; whatsappUserId: string; providerMessageId: string; messageType: string };

/**
 * Pure parsing: never throws on a structurally-unexpected-but-signed payload (e.g. a Meta
 * status-callback webhook with no `messages` array) -- returns an empty list instead, since
 * those are legitimate Meta deliveries we simply have nothing to do with yet. Returns `null`
 * only when the payload doesn't even match the outer webhook envelope shape.
 */
export function extractWhatsAppMessages(payload: unknown): ExtractedWhatsAppMessage[] | null {
  const parsed = webhookPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;

  const out: ExtractedWhatsAppMessage[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const displayNameByWaId = new Map<string, string>();
      for (const contact of change.value.contacts ?? []) {
        if (contact.wa_id && contact.profile?.name) displayNameByWaId.set(contact.wa_id, contact.profile.name);
      }
      for (const message of change.value.messages ?? []) {
        if (message.type === "text" && message.text?.body !== undefined) {
          out.push({
            kind: "text",
            whatsappUserId: message.from,
            phoneRaw: message.from,
            displayName: displayNameByWaId.get(message.from),
            providerMessageId: message.id,
            text: message.text.body,
          });
        } else {
          out.push({
            kind: "unsupported",
            whatsappUserId: message.from,
            providerMessageId: message.id,
            messageType: message.type,
          });
        }
      }
    }
  }
  return out;
}
