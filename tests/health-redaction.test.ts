import { describe, expect, it } from "vitest";
import { redactSensitiveHealthContent, HEALTH_REDACTION_PLACEHOLDER } from "../src/domain/health-redaction.js";
import { persistInboundMessage } from "../src/application/message-ingestion.js";
import { InMemoryMessageRepository, InMemoryQualificationAnswerRepository } from "../src/infrastructure/memory-repositories.js";

describe("redactSensitiveHealthContent", () => {
  it("passes through ordinary GMM qualification text unchanged", () => {
    const result = redactSensitiveHealthContent("Somos 4 personas, buscamos cobertura familiar en Leon");
    expect(result.sensitiveDetected).toBe(false);
    expect(result.redactedBody).toBe("Somos 4 personas, buscamos cobertura familiar en Leon");
    expect(result.metadata).toEqual({});
  });

  it("redacts a volunteered diagnosis and returns only the whitelisted metadata shape", () => {
    const raw = "Me diagnosticaron diabetes tipo 2 el año pasado y tomo insulina diario";
    const result = redactSensitiveHealthContent(raw);
    expect(result.sensitiveDetected).toBe(true);
    expect(result.redactedBody).toBe(HEALTH_REDACTION_PLACEHOLDER);
    expect(result.redactedBody).not.toContain("diabetes");
    expect(result.redactedBody).not.toContain("insulina");
    expect(result.metadata).toEqual({ sensitive_content_detected: true, category: "HEALTH" });
  });

  it("redacts mentions of surgery/treatment/lab results", () => {
    expect(redactSensitiveHealthContent("tuve una cirugía de rodilla el año pasado").sensitiveDetected).toBe(true);
    expect(redactSensitiveHealthContent("sigo en tratamiento para el cáncer").sensitiveDetected).toBe(true);
    expect(redactSensitiveHealthContent("aquí están mis resultados de laboratorio").sensitiveDetected).toBe(true);
  });

  // Real incident (2026): these two messages were sent during a live GMM E2E test and were NOT
  // detected as sensitive by the previous pattern list -- "disco y ciática" reached the qualifier
  // untouched, and the second one had its "No" parsed as a valid has_current_insurance answer
  // before the medical content was ever noticed. Both must be caught now.
  it.each([
    "disco y ciática",
    "tengo ciática",
    "tengo una hernia de disco",
    "No no cuento tengo hernia de disco y ciática",
    "me duele mucho la espalda",
    "tengo dolor lumbar",
    "me diagnosticaron diabetes",
    "estoy en tratamiento",
    "tomo medicamentos",
    "me operaron de la rodilla",
    "tuve una cirugía",
    "tengo hipertensión",
    "estoy embarazada",
    "tengo un padecimiento",
    "tengo problemas de columna",
  ])("flags %s as sensitive", (text) => {
    expect(redactSensitiveHealthContent(text).sensitiveDetected).toBe(true);
  });

  it.each([
    "quiero cobertura amplia",
    "me interesan buenos hospitales",
    "quiero comparar precios",
    "quiero asegurar a mi familia",
    "vivo cerca del hospital",
    "trabajo en un hospital",
    "quiero empezar este mes",
    "tengo un presupuesto de 5000",
    "tengo seguro actualmente",
    "no tengo seguro",
    "quiero cotizar",
    "quiero una póliza familiar",
  ])("does NOT flag ordinary commercial text: %s", (text) => {
    expect(redactSensitiveHealthContent(text).sensitiveDetected).toBe(false);
  });
});

describe("persistInboundMessage sensitive-health boundary", () => {
  it("stores the redacted body, not the raw sensitive text, and never touches qualification_answers", async () => {
    const messages = new InMemoryMessageRepository();
    const qualificationAnswers = new InMemoryQualificationAnswerRepository();
    const raw = "tuve una biopsia el mes pasado y el tratamiento de quimioterapia sigue";

    const { message, sensitiveDetected } = await persistInboundMessage(
      { messages },
      { conversationId: "conv-1", leadId: "lead-1", body: raw },
    );

    expect(sensitiveDetected).toBe(true);
    expect(message.body).not.toBe(raw);
    expect(message.body).toBe(HEALTH_REDACTION_PLACEHOLDER);
    expect(message.metadata).toEqual({ sensitive_content_detected: true, category: "HEALTH" });

    // Structural guarantee, not just a runtime check: this code path never calls
    // QualificationAnswerRepository at all.
    expect(await qualificationAnswers.listByLeadId("lead-1")).toHaveLength(0);
  });

  it("stores ordinary messages verbatim", async () => {
    const messages = new InMemoryMessageRepository();
    const { message, sensitiveDetected } = await persistInboundMessage(
      { messages },
      { conversationId: "conv-1", leadId: "lead-1", body: "Quiero información sobre el plan PPR" },
    );
    expect(sensitiveDetected).toBe(false);
    expect(message.body).toBe("Quiero información sobre el plan PPR");
  });
});
