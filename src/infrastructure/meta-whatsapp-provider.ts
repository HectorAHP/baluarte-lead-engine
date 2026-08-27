import type { MessagingProvider, SendMessageResult } from "../application/ports.js";
import { MessagingProviderError } from "../domain/errors.js";
import { diagnoseMetaError } from "../domain/meta-error-diagnosis.js";
import { config } from "../config.js";

interface GraphSendResponse {
  messages?: Array<{ id: string }>;
}

export class MetaWhatsAppProvider implements MessagingProvider {
  private readonly endpoint: string;
  private readonly accessToken: string;

  constructor() {
    if (!config.WHATSAPP_ACCESS_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID) {
      throw new MessagingProviderError("WhatsApp credentials are not configured");
    }
    this.accessToken = config.WHATSAPP_ACCESS_TOKEN;
    this.endpoint = `https://graph.facebook.com/${config.META_GRAPH_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  }

  async sendText(to: string, body: string): Promise<SendMessageResult> {
    const data = await this.post({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    });
    return { providerMessageId: data.messages?.[0]?.id };
  }

  async sendTemplate(to: string, templateName: string, languageCode: string, params?: string[]): Promise<SendMessageResult> {
    const data = await this.post({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(params && params.length > 0
          ? { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] }
          : {}),
      },
    });
    return { providerMessageId: data.messages?.[0]?.id };
  }

  async markRead(providerMessageId: string): Promise<void> {
    await this.post({ messaging_product: "whatsapp", status: "read", message_id: providerMessageId });
  }

  private async post(body: unknown): Promise<GraphSendResponse> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new MessagingProviderError("Failed to reach the WhatsApp Cloud API", { cause: err });
    }
    if (!response.ok) {
      // Deliberately extract ONLY the numeric `code` and the `type` string from Meta's error
      // body -- both are public API error taxonomy (e.g. code 190 = invalid/expired token,
      // type "OAuthException"), safe to surface. Never the `message`/`error_user_msg` fields or
      // the raw body: those can echo back request content and this error may end up in logs.
      let metaErrorCode: number | undefined;
      let metaErrorType: string | undefined;
      try {
        const errorBody = (await response.json()) as { error?: { code?: number; type?: string } };
        metaErrorCode = errorBody.error?.code;
        metaErrorType = errorBody.error?.type;
      } catch {
        // Response body wasn't valid JSON (or was empty) -- proceed with just the HTTP status.
      }
      throw new MessagingProviderError(`WhatsApp Cloud API request failed with status ${response.status}`, {
        httpStatus: response.status,
        metaErrorCode,
        metaErrorType,
        sanitizedDiagnosis: diagnoseMetaError(metaErrorCode, metaErrorType),
        phoneNumberIdLast4: config.WHATSAPP_PHONE_NUMBER_ID?.slice(-4),
      });
    }
    return (await response.json()) as GraphSendResponse;
  }
}
