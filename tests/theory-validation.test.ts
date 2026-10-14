import { describe, expect, it } from "vitest";
import {
  COMPARISON_OPERATORS,
  THEORY_ERROR,
  isValidatedTheory,
  measureTheoryComplexity,
  validateTheory,
} from "../src/language/theory.js";
import { bin, glowMeasurement, k, v } from "./helpers/expression-builders.js";

describe("Theory validation", () => {
  it.each(COMPARISON_OPERATORS)("accepts the %s comparison operator", (operator) => {
    const result = validateTheory({
      measurement: glowMeasurement(),
      operator,
      threshold: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isValidatedTheory(result.theory)).toBe(true);
      expect(result.theory).toStrictEqual({
        measurement: glowMeasurement(),
        operator,
        threshold: 0,
      });
    }
  });

  it.each([
    ["unknown operator", { measurement: v("a"), operator: "eq", threshold: 0 }],
    ["non-finite threshold", { measurement: v("a"), operator: "lt", threshold: Infinity }],
    ["NaN threshold", { measurement: v("a"), operator: "lt", threshold: Number.NaN }],
    ["missing threshold", { measurement: v("a"), operator: "lt" }],
    ["extra field", { measurement: v("a"), operator: "lt", threshold: 0, confidence: 1 }],
    ["invalid expression", { measurement: v("unknown"), operator: "lt", threshold: 0 }],
    ["extra expression field", { measurement: { var: "a", extra: true }, operator: "lt", threshold: 0 }],
    ["non-object", null],
  ])("rejects %s", (_label, input) => {
    expect(validateTheory(input)).toEqual({ ok: false, error: THEORY_ERROR });
  });

  it("returns a fresh immutable theory and expression", () => {
    const input = { measurement: glowMeasurement(), operator: "lt", threshold: 0 };
    const result = validateTheory(input);
    if (!result.ok) throw new Error("expected valid theory");

    expect(result.theory).not.toBe(input);
    expect(result.theory.measurement).not.toBe(input.measurement);
    expect(Object.isFrozen(result.theory)).toBe(true);
    expect(Object.isFrozen(result.theory.measurement)).toBe(true);
  });

  it("fails safely when a top-level getter throws", () => {
    const input = {
      get measurement(): unknown {
        throw new Error("private detail");
      },
      operator: "lt",
      threshold: 0,
    };
    expect(validateTheory(input)).toEqual({ ok: false, error: THEORY_ERROR });
  });
});

describe("Theory complexity", () => {
  it("reports measurement AST node count and depth separately", () => {
    const result = validateTheory({
      measurement: glowMeasurement(),
      operator: "lt",
      threshold: 0,
    });
    if (!result.ok) throw new Error("expected valid theory");
    expect(measureTheoryComplexity(result.theory)).toStrictEqual({ nodeCount: 7, depth: 3 });
  });

  it("distinguishes simple and larger measurements deterministically", () => {
    const simple = validateTheory({ measurement: v("a"), operator: "gt", threshold: 5 });
    const larger = validateTheory({
      measurement: bin("add", v("a"), bin("mul", v("b"), k(2))),
      operator: "gte",
      threshold: 0,
    });
    if (!simple.ok || !larger.ok) throw new Error("expected valid theories");

    expect(measureTheoryComplexity(simple.theory)).toStrictEqual({ nodeCount: 1, depth: 1 });
    expect(measureTheoryComplexity(larger.theory)).toStrictEqual({ nodeCount: 5, depth: 3 });
    expect(measureTheoryComplexity(larger.theory)).toStrictEqual(
      measureTheoryComplexity(larger.theory),
    );
  });
});
