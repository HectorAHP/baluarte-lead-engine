import { describe, it, expect } from "vitest";
import { isSocialAcknowledgement, isBareGreeting, isBookingIndecisionReply } from "../src/domain/social-acknowledgement-detection.js";

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

describe("Fase 7J -- isBareGreeting: positives", () => {
  const positives = ["hola", "Hola", "HOLA", "  hola  ", "hola!", "hola.", "hi", "hello", "hey", "buenas", "buenos dias", "buenas tardes", "buenas noches"];
  it.each(positives)("%s -> true", (text) => {
    expect(isBareGreeting(text)).toBe(true);
  });
});

describe("Fase 7J -- isBareGreeting: negatives (never a substring/fuzzy match)", () => {
  const negatives = [
    "hola, tengo una duda sobre mi seguro",
    "hola quiero informacion",
    "buenas, ¿cuáles son los servicios?",
    "cancelar",
    "1",
    "",
  ];
  it.each(negatives)("%s -> false", (text) => {
    expect(isBareGreeting(text)).toBe(false);
  });
});

describe("Fase 7J -- isBookingIndecisionReply: positives", () => {
  const positives = ["no se", "No sé", "NO SE", "  no se  ", "no se.", "no se cual", "no se cual escoger", "cualquiera", "no importa", "me da igual", "no tengo preferencia"];
  it.each(positives)("%s -> true", (text) => {
    expect(isBookingIndecisionReply(text)).toBe(true);
  });
});

describe("Fase 7J -- isBookingIndecisionReply: negatives (never a substring/fuzzy match)", () => {
  const negatives = [
    "no se si puedo ese dia",
    "no importa, mejor cancela mi cita",
    "cualquiera menos el lunes",
    "asdkjfh qlwkejr",
    "1",
    "",
  ];
  it.each(negatives)("%s -> false", (text) => {
    expect(isBookingIndecisionReply(text)).toBe(false);
  });
});
