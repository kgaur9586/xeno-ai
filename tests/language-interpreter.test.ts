import { describe, expect, it } from "vitest";
import { evaluateExpression } from "../src/language/interpreter.js";
import { bin, call, deepFreeze, failureOf, glowMeasurement, k, v } from "./helpers/expression-builders.js";

const vars = { a: 8, b: 2, c: 1 };

function valueOf(expression: unknown, variables: unknown = vars): number {
  const result = evaluateExpression(expression, variables);
  if (!result.ok) {
    throw new Error(`Expected a value, got ${result.error.code}`);
  }
  return result.value;
}

describe("Arithmetic", () => {
  it("adds, subtracts, multiplies, and divides", () => {
    expect(valueOf(bin("add", k(2), k(3)))).toBe(5);
    expect(valueOf(bin("sub", k(2), k(3)))).toBe(-1);
    expect(valueOf(bin("mul", k(2), k(3)))).toBe(6);
    expect(valueOf(bin("div", k(3), k(2)))).toBe(1.5);
  });

  it("keeps left and right in order for sub and div", () => {
    expect(valueOf(bin("sub", v("a"), v("b")))).toBe(6);
    expect(valueOf(bin("sub", v("b"), v("a")))).toBe(-6);
    expect(valueOf(bin("div", v("a"), v("b")))).toBe(4);
    expect(valueOf(bin("div", v("b"), v("a")))).toBe(0.25);
  });

  it("reads each variable from the supplied values", () => {
    const values = { a: 1.5, b: -2, c: 100 };
    expect(valueOf(v("a"), values)).toBe(1.5);
    expect(valueOf(v("b"), values)).toBe(-2);
    expect(valueOf(v("c"), values)).toBe(100);
  });

  it("returns constants unchanged", () => {
    expect(valueOf(k(-3.25))).toBe(-3.25);
    expect(valueOf(k(Number.MAX_VALUE))).toBe(Number.MAX_VALUE);
  });
});

describe("Functions", () => {
  it("abs", () => {
    expect(valueOf(call("abs", k(-3)))).toBe(3);
    expect(valueOf(call("abs", k(3)))).toBe(3);
    expect(valueOf(call("abs", k(0)))).toBe(0);
  });

  it("sqrt", () => {
    expect(valueOf(call("sqrt", k(9)))).toBe(3);
    expect(valueOf(call("sqrt", k(0)))).toBe(0);
    expect(valueOf(call("sqrt", k(2)))).toBeCloseTo(Math.SQRT2, 12);
  });

  it("log is the natural logarithm", () => {
    expect(valueOf(call("log", k(1)))).toBe(0);
    expect(valueOf(call("log", k(Math.E)))).toBeCloseTo(1, 12);
    expect(valueOf(call("log", k(0.5)))).toBeCloseTo(-Math.LN2, 12);
  });

  it("min and max with 2, 3, and 4 arguments", () => {
    expect(valueOf(call("min", k(3), k(1)))).toBe(1);
    expect(valueOf(call("max", k(3), k(1)))).toBe(3);
    expect(valueOf(call("min", k(3), k(-1), k(2)))).toBe(-1);
    expect(valueOf(call("max", v("a"), v("b"), v("c"), k(7)))).toBe(8);
  });
});

describe("Nested expressions", () => {
  it("evaluates nested trees according to their structure", () => {
    // sqrt(abs(a - 10) + b * c) = sqrt(2 + 2) = 2
    const expression = call("sqrt", bin("add", call("abs", bin("sub", v("a"), k(10))), bin("mul", v("b"), v("c"))));
    expect(valueOf(expression)).toBe(2);
  });

  it("the tree, not operator precedence, decides the order", () => {
    // (2 + 3) * 4 versus 2 + (3 * 4)
    expect(valueOf(bin("mul", bin("add", k(2), k(3)), k(4)))).toBe(20);
    expect(valueOf(bin("add", k(2), bin("mul", k(3), k(4))))).toBe(14);
  });

  it("evaluates functions of functions", () => {
    expect(valueOf(call("max", call("min", k(1), k(5)), call("abs", k(-4))))).toBe(4);
    expect(valueOf(call("log", call("sqrt", k(Math.E * Math.E))))).toBeCloseTo(1, 12);
  });
});

describe("The Glow World measurement (a - 5) * (b - 5)", () => {
  it("computes the documented values", () => {
    expect(valueOf(glowMeasurement(), { a: 8, b: 2, c: 1 })).toBe(-9);
    expect(valueOf(glowMeasurement(), { a: 2, b: 8, c: 1 })).toBe(-9);
    expect(valueOf(glowMeasurement(), { a: 8, b: 8, c: 1 })).toBe(9);
    expect(valueOf(glowMeasurement(), { a: 2, b: 2, c: 1 })).toBe(9);
    // 0 * -3 is -0 in standard floating-point arithmetic; -0 === 0.
    expect(valueOf(glowMeasurement(), { a: 5, b: 2, c: 1 }) === 0).toBe(true);
    expect(valueOf(glowMeasurement(), { a: 0, b: 10, c: 1 })).toBe(-25);
  });

  it("matches (a - 5) * (b - 5) across a grid of values, and ignores c", () => {
    for (let a = 0; a <= 10; a += 0.5) {
      for (let b = 0; b <= 10; b += 0.5) {
        for (const c of [0, 5, 10]) {
          expect(valueOf(glowMeasurement(), { a, b, c })).toBe((a - 5) * (b - 5));
        }
      }
    }
  });

  it("accepts values outside the world's input range (needed for later extrapolation tests)", () => {
    expect(valueOf(glowMeasurement(), { a: 20, b: -10, c: 0 })).toBe(-225);
  });
});

describe("Evaluation errors", () => {
  it("rejects division by zero, including negative zero and computed zero", () => {
    expect(evaluateExpression(bin("div", k(1), k(0)), vars)).toEqual(failureOf("DIVISION_BY_ZERO"));
    expect(evaluateExpression(bin("div", k(1), k(-0)), vars)).toEqual(failureOf("DIVISION_BY_ZERO"));
    expect(evaluateExpression(bin("div", k(1), bin("sub", v("a"), v("a"))), vars)).toEqual(
      failureOf("DIVISION_BY_ZERO"),
    );
    expect(evaluateExpression(bin("div", k(0), k(0)), vars)).toEqual(failureOf("DIVISION_BY_ZERO"));
  });

  it("rejects the square root of a negative number", () => {
    expect(evaluateExpression(call("sqrt", k(-1)), vars)).toEqual(failureOf("SQRT_OF_NEGATIVE"));
    expect(evaluateExpression(call("sqrt", bin("sub", v("b"), v("a"))), vars)).toEqual(
      failureOf("SQRT_OF_NEGATIVE"),
    );
  });

  it("rejects the logarithm of zero or a negative number", () => {
    expect(evaluateExpression(call("log", k(0)), vars)).toEqual(failureOf("LOG_OF_NON_POSITIVE"));
    expect(evaluateExpression(call("log", k(-0)), vars)).toEqual(failureOf("LOG_OF_NON_POSITIVE"));
    expect(evaluateExpression(call("log", k(-2)), vars)).toEqual(failureOf("LOG_OF_NON_POSITIVE"));
  });

  it.each([
    ["multiplication overflow", bin("mul", k(1e308), k(10))],
    ["addition overflow", bin("add", k(Number.MAX_VALUE), k(Number.MAX_VALUE))],
    ["subtraction overflow", bin("sub", k(-1e308), k(1e308))],
    ["division overflow", bin("div", k(1e308), k(1e-308))],
    ["overflow inside a function", call("abs", bin("mul", k(-1e308), k(1e308)))],
    ["overflow inside min", call("min", k(1), bin("mul", k(1e308), k(1e308)))],
  ])("rejects a non-finite result from %s", (_label, expression) => {
    expect(evaluateExpression(expression, vars)).toEqual(failureOf("NON_FINITE_RESULT"));
  });

  it("allows results that underflow to zero, which are finite", () => {
    expect(valueOf(bin("mul", k(1e-308), k(1e-308)))).toBe(0);
  });

  it("reports the first failure in left-to-right order", () => {
    const expression = bin("add", bin("div", k(1), k(0)), call("sqrt", k(-1)));
    expect(evaluateExpression(expression, vars)).toEqual(failureOf("DIVISION_BY_ZERO"));
  });

  it("reports expression problems before variable problems", () => {
    expect(evaluateExpression(v("d"), { a: 1 })).toEqual(failureOf("UNKNOWN_VARIABLE"));
  });
});

describe("Variable values", () => {
  it.each([
    ["missing c", { a: 1, b: 2 }],
    ["an extra variable", { a: 1, b: 2, c: 3, d: 4 }],
    ["NaN", { a: Number.NaN, b: 2, c: 3 }],
    ["Infinity", { a: 1, b: Number.POSITIVE_INFINITY, c: 3 }],
    ["a string", { a: "1", b: 2, c: 3 }],
    ["null values", null],
    ["an array", [1, 2, 3]],
    ["a number", 5],
  ])("rejects %s", (_label, variables) => {
    expect(evaluateExpression(v("a"), variables)).toEqual(failureOf("INVALID_VARIABLES"));
  });

  it("fails safely when reading a variable throws", () => {
    const hostile = {
      get a(): number {
        throw new Error("internal detail");
      },
      b: 1,
      c: 1,
    };
    const result = evaluateExpression(v("b"), hostile);
    expect(result).toEqual(failureOf("INVALID_VARIABLES"));
  });
});

describe("Immutability and determinism", () => {
  it("does not modify a frozen expression or frozen variables", () => {
    const expression = deepFreeze(glowMeasurement());
    const variables = deepFreeze({ a: 8, b: 2, c: 1 });
    const before = structuredClone({ expression, variables });
    expect(evaluateExpression(expression, variables)).toEqual({ ok: true, value: -9 });
    expect({ expression, variables }).toStrictEqual(before);
  });

  it("gives the same result for the same inputs every time", () => {
    const expression = call("log", bin("add", call("abs", bin("sub", v("a"), v("c"))), k(1)));
    const first = evaluateExpression(expression, vars);
    for (let i = 0; i < 50; i++) {
      expect(evaluateExpression(expression, vars)).toStrictEqual(first);
    }
  });

  it("returns exactly ok and value on success", () => {
    const result = evaluateExpression(k(1), vars);
    expect(Object.keys(result).sort()).toEqual(["ok", "value"]);
  });
});
