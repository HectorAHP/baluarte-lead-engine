import type { QualificationVertical } from "./qualification-fields.js";

export type QualificationFieldSource = "AI_EXTRACTED" | "MANUAL";

export interface QualificationAnswer {
  id: string;
  leadId: string;
  conversationId?: string;
  vertical: QualificationVertical;
  fieldName: string;
  fieldValue: unknown;
  source: QualificationFieldSource;
  createdAt: Date;
}
