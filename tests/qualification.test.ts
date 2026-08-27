import { describe, expect, it } from "vitest";
import { QualificationService } from "../src/application/qualification-service.js";
import { InMemoryQualificationAnswerRepository } from "../src/infrastructure/memory-repositories.js";
import { InvalidQualificationFieldError } from "../src/domain/errors.js";

describe("QualificationService whitelist enforcement", () => {
  it("accepts a whitelisted PATRIMONIAL field", async () => {
    const service = new QualificationService(new InMemoryQualificationAnswerRepository());
    const answer = await service.recordAnswer({ leadId: "lead-1", vertical: "PATRIMONIAL", fieldName: "objective", fieldValue: "retiro", source: "AI_EXTRACTED" });
    expect(answer.fieldName).toBe("objective");
  });

  it("accepts a whitelisted GMM field", async () => {
    const service = new QualificationService(new InMemoryQualificationAnswerRepository());
    const answer = await service.recordAnswer({ leadId: "lead-1", vertical: "GMM", fieldName: "coverage_type", fieldValue: "familiar", source: "MANUAL" });
    expect(answer.fieldName).toBe("coverage_type");
  });

  it("rejects a GMM field outside the whitelist (e.g. a health-diagnosis-shaped field) and persists nothing", async () => {
    const repo = new InMemoryQualificationAnswerRepository();
    const service = new QualificationService(repo);
    await expect(
      service.recordAnswer({ leadId: "lead-1", vertical: "GMM", fieldName: "diagnosis", fieldValue: "...", source: "AI_EXTRACTED" }),
    ).rejects.toThrow(InvalidQualificationFieldError);
    expect(await repo.listByLeadId("lead-1")).toHaveLength(0);
  });

  it("rejects a PATRIMONIAL field outside the whitelist", async () => {
    const service = new QualificationService(new InMemoryQualificationAnswerRepository());
    await expect(
      service.recordAnswer({ leadId: "lead-1", vertical: "PATRIMONIAL", fieldName: "bank_account_number", fieldValue: "...", source: "AI_EXTRACTED" }),
    ).rejects.toThrow(InvalidQualificationFieldError);
  });

  it("is append-only: answering the same field twice keeps both rows, latest last", async () => {
    const repo = new InMemoryQualificationAnswerRepository();
    const service = new QualificationService(repo);
    await service.recordAnswer({ leadId: "lead-1", vertical: "PATRIMONIAL", fieldName: "timeline", fieldValue: "3 meses", source: "AI_EXTRACTED" });
    await service.recordAnswer({ leadId: "lead-1", vertical: "PATRIMONIAL", fieldName: "timeline", fieldValue: "1 mes", source: "AI_EXTRACTED" });
    const answers = await service.listAnswers("lead-1");
    expect(answers).toHaveLength(2);
    expect(answers[1].fieldValue).toBe("1 mes");
  });
});
