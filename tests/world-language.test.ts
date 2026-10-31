import { describe, expect, it } from "vitest";
import { createVariableSet, DEFAULT_VARIABLE_SET } from "../src/language/expression.js";
import { evaluateExpression } from "../src/language/interpreter.js";
import { isValidatedNumericTheory, validateNumericTheory } from "../src/language/numeric-theory.js";
import { THEORY_ERROR, validateTheory } from "../src/language/theory.js";
import { parseExpressionJson, validateExpression } from "../src/language/validate.js";
import { bin, failureOf, k, v } from "./helpers/expression-builders.js";

const RING = createVariableSet(["p", "q", "r", "s"]);

describe("Variable sets", () => {
  it("defaults to a, b, and c", () => {
    expect(DEFAULT_VARIABLE_SET.names).toEqual(["a", "b", "c"]);
    expect(validateExpression(v("a")).ok).toBe(true);
    expect(validateExpression(v("p"))).toEqual(failureOf("UNKNOWN_VARIABLE"));
  });

  it("accepts the names of another world and rejects names outside that set", () => {
    expect(validateExpression(bin("sub", v("p"), v("s")), RING).ok).toBe(true);
    expect(validateExpression(v("a"), RING)).toEqual(failureOf("UNKNOWN_VARIABLE"));
    expect(parseExpressionJson('{"var":"q"}', RING).ok).toBe(true);
    expect(parseExpressionJson('{"var":"q"}')).toEqual(failureOf("UNKNOWN_VARIABLE"));
  });

  it("evaluates with exactly the set's variables", () => {
    const values = { p: 4, q: 1, r: 0, s: 9 };
    expect(evaluateExpression(bin("sub", v("p"), v("s")), values, RING)).toEqual({ ok: true, value: -5 });
    expect(evaluateExpression(v("p"), { p: 1, q: 1, r: 1 }, RING)).toEqual(failureOf("INVALID_VARIABLES"));
    expect(evaluateExpression(v("p"), { ...values, t: 1 }, RING)).toEqual(failureOf("INVALID_VARIABLES"));
    expect(evaluateExpression(v("p"), { ...values, p: Number.NaN }, RING)).toEqual(failureOf("INVALID_VARIABLES"));
    expect(evaluateExpression(v("a"), { a: 1, b: 2, c: 3 })).toEqual({ ok: true, value: 1 });
  });

  it("rejects malformed variable sets", () => {
    expect(() => createVariableSet([])).toThrow();
    expect(() => createVariableSet(["p", "p"])).toThrow();
    expect(() => createVariableSet(["P"])).toThrow();
    expect(() => createVariableSet(["1x"])).toThrow();
    expect(() => createVariableSet(["op"])).toThrow();
    expect(() => createVariableSet(Array.from({ length: 17 }, (_, i) => `x${i}`))).toThrow();
  });

  it("validates boolean theories against a chosen set", () => {
    const theory = { measurement: v("q"), operator: "gt", threshold: 1 };
    expect(validateTheory(theory, RING).ok).toBe(true);
    expect(validateTheory(theory)).toEqual({ ok: false, error: THEORY_ERROR });
  });
});

describe("Numeric theories", () => {
  it("accepts exactly one measurement field and returns a frozen, branded copy", () => {
    const input = { measurement: bin("add", v("p"), k(1)) };
    const result = validateNumericTheory(input, RING);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isValidatedNumericTheory(result.theory)).toBe(true);
    expect(isValidatedNumericTheory(structuredClone(result.theory))).toBe(false);
    expect(Object.isFrozen(result.theory)).toBe(true);
    expect(Object.isFrozen(result.theory.measurement)).toBe(true);
    expect(result.theory.measurement).not.toBe(input.measurement);
  });

  it("rejects extra fields, a boolean theory shape, and unknown variables with one fixed error", () => {
    const invalid = { ok: false, error: THEORY_ERROR };
    expect(validateNumericTheory({ measurement: v("p"), operator: "gt" }, RING)).toEqual(invalid);
    expect(validateNumericTheory({ measurement: v("p"), operator: "gt", threshold: 0 }, RING)).toEqual(invalid);
    expect(validateNumericTheory({ measurement: v("a") }, RING)).toEqual(invalid);
    expect(validateNumericTheory({}, RING)).toEqual(invalid);
    expect(validateNumericTheory(null, RING)).toEqual(invalid);
    expect(validateNumericTheory({ measurement: { var: "p", const: 1 } }, RING)).toEqual(invalid);
  });
});
