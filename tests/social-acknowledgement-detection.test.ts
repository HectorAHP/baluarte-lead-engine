import { describe, it, expect } from "vitest";
import { isSocialAcknowledgement } from "../src/domain/social-acknowledgement-detection.js";

describe("Fase 7J -- isSocialAcknowledgement: positives", () => {
  const positives = [
    "gracias", "Gracias", "GRACIAS", "  gracias  ", "gracias!", "gracias.",
    "muchas gracias", "ok", "Ok", "okay", "va", "perfecto", "listo",
    "entendido", "excelente", "de acuerdo", "sale", "👍",
  ];
  it.each(positives)("%s -> true", (text) => {
    expect(isSocialAcknowledgement(text)).toBe(true);
  });
});

describe("Fase 7J -- isSocialAcknowledgement: negatives (never a substring/fuzzy match)", () => {
  const negatives = [
    "ok pero tengo una duda",
    "gracias, pero quiero preguntar algo más",
    "perfecto, ¿y el seguro de gastos médicos?",
    "no gracias",
    "cancelar",
    "reagendar",
    "mejor el domingo",
    "¿me puedes explicar qué pasa si mi empresa me paga por honorarios pero también tengo nómina?",
    "",
    "1",
  ];
  it.each(negatives)("%s -> false", (text) => {
    expect(isSocialAcknowledgement(text)).toBe(false);
  });
});
