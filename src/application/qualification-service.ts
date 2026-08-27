import type { QualificationAnswerRepository } from "./ports.js";
import type { QualificationAnswer, QualificationFieldSource } from "../domain/qualification-answer.js";
import type { QualificationVertical } from "../domain/qualification-fields.js";
import { isAllowedQualificationField } from "../domain/qualification-fields.js";
import { InvalidQualificationFieldError } from "../domain/errors.js";

export interface RecordAnswerInput {
  leadId: string;
  conversationId?: string;
  vertical: QualificationVertical;
  fieldName: string;
  fieldValue: unknown;
  source: QualificationFieldSource;
}

/**
 * The only code path allowed to write to qualification_answers. Whitelist enforcement lives
 * here in code -- not in an AI system prompt -- because prompt instructions are not a security
 * boundary: a future qualifier LLM extracting structured fields must have its output validated
 * here before persistence, the same way any other untrusted input is validated.
 */
export class QualificationService {
  constructor(private readonly answers: QualificationAnswerRepository) {}

  async recordAnswer(input: RecordAnswerInput): Promise<QualificationAnswer> {
    if (!isAllowedQualificationField(input.vertical, input.fieldName)) {
      throw new InvalidQualificationFieldError(input.vertical, input.fieldName);
    }
    return this.answers.create(input);
  }

  listAnswers(leadId: string) {
    return this.answers.listByLeadId(leadId);
  }
}
