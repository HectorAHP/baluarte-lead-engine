import { randomUUID } from "node:crypto";
import type { MessagingProvider, SendMessageResult } from "../application/ports.js";

export class FakeMessagingProvider implements MessagingProvider {
  public readonly sentTexts: Array<{ to: string; body: string }> = [];
  public readonly sentTemplates: Array<{ to: string; templateName: string; languageCode: string; params?: string[] }> = [];
  public readonly markedRead: string[] = [];

  async sendText(to: string, body: string): Promise<SendMessageResult> {
    this.sentTexts.push({ to, body });
    return { providerMessageId: `fake-wamid-${randomUUID()}` };
  }

  async sendTemplate(to: string, templateName: string, languageCode: string, params?: string[]): Promise<SendMessageResult> {
    this.sentTemplates.push({ to, templateName, languageCode, params });
    return { providerMessageId: `fake-wamid-${randomUUID()}` };
  }

  async markRead(providerMessageId: string): Promise<void> {
    this.markedRead.push(providerMessageId);
  }
}
