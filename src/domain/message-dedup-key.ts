/**
 * Composes the in-memory dedup key for inbound messages. Deliberately takes plain `string`
 * rather than `Message["channel"]` -- this is a generic key-composition algorithm, not a claim
 * that any particular channel value is a supported MessageChannel (today there is only one:
 * "WHATSAPP"). JSON-encoding the pair, rather than a plain `${channel}:${id}` join, avoids any
 * boundary-collision risk: ("A:B", "C") and ("A", "B:C") would be indistinguishable under a
 * naive colon join but produce different keys here, since JSON.stringify escapes embedded
 * delimiter-like characters instead of leaving them ambiguous with the join separator.
 */
export function messageDedupKey(channel: string, providerMessageId: string): string {
  return JSON.stringify([channel, providerMessageId]);
}
