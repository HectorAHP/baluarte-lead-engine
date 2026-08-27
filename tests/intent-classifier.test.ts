import { describe, expect, it } from "vitest";
import { classifyIntent } from "../src/domain/intent-classifier.js";

describe("classifyIntent", () => {
  it.each([
    ["1", "SAVINGS"],
    ["2", "RETIREMENT_PPR"],
    ["3", "GMM"],
  ] as const)("maps menu digit %s to %s", (input, product) => {
    expect(classifyIntent(input)).toEqual({ kind: "MATCHED", product });
  });

  it("maps menu digit 4 to OTHER", () => {
    expect(classifyIntent("4")).toEqual({ kind: "OTHER" });
  });

  it.each([
    "quiero ahorrar",
    "quiero invertir",
    "quiero hacer un plan de ahorro",
  ])("classifies %s as SAVINGS", (text) => {
    expect(classifyIntent(text)).toEqual({ kind: "MATCHED", product: "SAVINGS" });
  });

  it.each([
    "retiro",
    "ppr",
    "quiero ahorrar para mi retiro",
    "quiero deducir impuestos",
  ])("classifies %s as RETIREMENT_PPR", (text) => {
    expect(classifyIntent(text)).toEqual({ kind: "MATCHED", product: "RETIREMENT_PPR" });
  });

  it.each([
    "seguro médico",
    "gastos médicos",
    "quiero un seguro de gastos médicos",
    "quiero proteger a mi familia",
  ])("classifies %s as GMM", (text) => {
    expect(classifyIntent(text)).toEqual({ kind: "MATCHED", product: "GMM" });
  });

  it("is ambiguous for unrelated free text", () => {
    expect(classifyIntent("hola buenos días")).toEqual({ kind: "AMBIGUOUS" });
  });

  it("is ambiguous when two different specific products are both mentioned", () => {
    expect(classifyIntent("quiero mi retiro y también un seguro de gastos médicos")).toEqual({ kind: "AMBIGUOUS" });
  });

  it("tolerates surrounding punctuation/words around a menu digit", () => {
    expect(classifyIntent("la opción 2 por favor")).toEqual({ kind: "MATCHED", product: "RETIREMENT_PPR" });
  });
});
