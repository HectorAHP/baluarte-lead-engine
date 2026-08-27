import { describe, expect, it, vi, afterEach } from "vitest";
import { MetaWhatsAppProvider } from "../src/infrastructure/meta-whatsapp-provider.js";
import { MessagingProviderError } from "../src/domain/errors.js";

// This project's .env has real WhatsApp credentials at this stage, so `new
// MetaWhatsAppProvider()` will construct successfully -- but global fetch is always mocked
// below, so no test here ever makes a real network call or sends a real message.

function mockFetchOnce(response: Partial<Response> & { ok: boolean; status: number; json: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue(response as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MetaWhatsAppProvider.sendText", () => {
  it("returns the providerMessageId on success", async () => {
    mockFetchOnce({ ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.success123" }] }) });
    const provider = new MetaWhatsAppProvider();
    const result = await provider.sendText("5214771234567", "hola");
    expect(result.providerMessageId).toBe("wamid.success123");
  });

  it("extracts httpStatus, metaErrorCode, and metaErrorType from a Meta error response (e.g. an expired token)", async () => {
    mockFetchOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } }),
    });
    const provider = new MetaWhatsAppProvider();
    await expect(provider.sendText("5214771234567", "hola")).rejects.toMatchObject({
      httpStatus: 401,
      metaErrorCode: 190,
      metaErrorType: "OAuthException",
    });
  });

  it("throws MessagingProviderError (not a raw fetch error) on failure", async () => {
    mockFetchOnce({ ok: false, status: 400, json: async () => ({ error: { code: 100, type: "GraphMethodException" } }) });
    const provider = new MetaWhatsAppProvider();
    await expect(provider.sendText("5214771234567", "hola")).rejects.toBeInstanceOf(MessagingProviderError);
  });

  it("does not crash when the error response body isn't valid JSON, and still reports httpStatus", async () => {
    mockFetchOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });
    const provider = new MetaWhatsAppProvider();
    await expect(provider.sendText("5214771234567", "hola")).rejects.toMatchObject({
      httpStatus: 500,
      metaErrorCode: undefined,
      metaErrorType: undefined,
    });
  });

  it("never includes the raw Meta error message in the thrown error's own message (only status/code/type are structured fields)", async () => {
    mockFetchOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "SECRET-LOOKING-TEXT-THAT-MUST-NOT-LEAK", type: "OAuthException", code: 190 } }),
    });
    const provider = new MetaWhatsAppProvider();
    try {
      await provider.sendText("5214771234567", "hola");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MessagingProviderError);
      expect((err as MessagingProviderError).message).not.toContain("SECRET-LOOKING-TEXT-THAT-MUST-NOT-LEAK");
    }
  });

  it("wraps a network-level failure (fetch throwing) as MessagingProviderError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const provider = new MetaWhatsAppProvider();
    await expect(provider.sendText("5214771234567", "hola")).rejects.toBeInstanceOf(MessagingProviderError);
  });
});
