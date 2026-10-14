import { describe, expect, it } from "vitest";
import {
  evaluateTheory,
  generateInRangeEvaluationCases,
  generateOutOfRangeEvaluationCases,
} from "../src/evaluator/evaluator.js";
import { evaluateExpression } from "../src/language/interpreter.js";
import {
  validateTheory,
  type ComparisonOperator,
  type ValidatedTheory,
} from "../src/language/theory.js";
import { createExperimentTools } from "../src/tools/experiment-tools.js";
import { computeGlowOutcome } from "../src/worlds/glow-world.js";
import { bin, glowMeasurement, k, v } from "./helpers/expression-builders.js";

const OPTIONS = { inRangeSeed: 101, outOfRangeSeed: 202, caseCount: 1000 };

function theory(
  measurement: unknown,
  operator: ComparisonOperator,
  threshold: number,
): ValidatedTheory {
  const result = validateTheory({ measurement, operator, threshold });
  if (!result.ok) throw new Error("expected a valid theory");
  return result.theory;
}

describe("Phase 4 evaluation datasets", () => {
  it("generates reproducible, exactly balanced in-range cases", () => {
    const first = generateInRangeEvaluationCases(42, 1000);
    expect(generateInRangeEvaluationCases(42, 1000)).toStrictEqual(first);
    expect(generateInRangeEvaluationCases(43, 1000)).not.toStrictEqual(first);
    expect(first.filter(({ glows }) => glows)).toHaveLength(500);
    expect(first.filter(({ glows }) => !glows)).toHaveLength(500);

    for (const testCase of first) {
      expect(testCase.glows).toBe(computeGlowOutcome(testCase.inputs).glows);
      for (const value of Object.values(testCase.inputs)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(10);
      }
    }
  });

  it("generates reproducible, exactly balanced out-of-range cases", () => {
    const first = generateOutOfRangeEvaluationCases(42, 1000);
    expect(generateOutOfRangeEvaluationCases(42, 1000)).toStrictEqual(first);
    expect(generateOutOfRangeEvaluationCases(43, 1000)).not.toStrictEqual(first);
    expect(first.filter(({ glows }) => glows)).toHaveLength(500);
    expect(first.filter(({ glows }) => !glows)).toHaveLength(500);

    for (const testCase of first) {
      expect(testCase.glows).toBe(computeGlowOutcome(testCase.inputs).glows);
      expect(testCase.inputs.a < 0 || testCase.inputs.a > 10).toBe(true);
      expect(Number.isFinite(testCase.inputs.a)).toBe(true);
      expect(Number.isFinite(testCase.inputs.b)).toBe(true);
      expect(testCase.inputs.c).toBeGreaterThanOrEqual(0);
      expect(testCase.inputs.c).toBeLessThanOrEqual(10);
    }
  });

  it("rejects invalid case counts for both datasets", () => {
    for (const count of [0, -2, 3, 2.5, Number.NaN]) {
      expect(() => generateInRangeEvaluationCases(1, count)).toThrow();
      expect(() => generateOutOfRangeEvaluationCases(1, count)).toThrow();
    }
  });
});

describe("Theory scoring", () => {
  it.each([
    ["lt", glowMeasurement()],
    ["lte", glowMeasurement()],
    ["gt", bin("sub", k(0), glowMeasurement())],
    ["gte", bin("sub", k(0), glowMeasurement())],
  ] as const)("supports %s and predicts the target outcomes", (operator, measurement) => {
    const result = evaluateTheory(theory(measurement, operator, 0), {
      ...OPTIONS,
      caseCount: 500,
    });
    expect(result.inRange.accuracy).toBe(1);
    expect(result.outOfRange.accuracy).toBe(1);
  });

  it("reports all aggregate fields and no cases or seeds", () => {
    const result = evaluateTheory(theory(glowMeasurement(), "lt", 0), OPTIONS);
    for (const metrics of [result.inRange, result.outOfRange]) {
      expect(metrics).toStrictEqual({
        totalCases: 1000,
        correctPredictions: 1000,
        incorrectPredictions: 0,
        accuracy: 1,
        evaluationErrors: {},
      });
    }
    expect(Object.keys(result).sort()).toEqual(["complexity", "inRange", "outOfRange"]);
    expect(JSON.stringify(result)).not.toContain("seed");
    expect(JSON.stringify(result)).not.toContain("inputs");
    expect(JSON.stringify(result)).not.toContain("glows");
  });

  it("keeps complexity separate from both accuracy metrics", () => {
    const result = evaluateTheory(theory(glowMeasurement(), "lt", 0), OPTIONS);
    expect(result.complexity).toStrictEqual({ nodeCount: 7, depth: 3 });
    expect(result.inRange).not.toHaveProperty("score");
    expect(result.outOfRange).not.toHaveProperty("score");
  });

  it("constant theories score exactly 50% on balanced datasets", () => {
    for (const constant of [
      theory(k(1), "gt", 0),
      theory(k(0), "gt", 0),
    ]) {
      const result = evaluateTheory(constant, OPTIONS);
      expect(result.inRange.accuracy).toBe(0.5);
      expect(result.outOfRange.accuracy).toBe(0.5);
    }
  });

  it("simple single-attribute and distractor theories stay near chance", () => {
    for (const candidate of [
      theory(v("a"), "gt", 5),
      theory(v("b"), "gt", 5),
      theory(v("c"), "gt", 5),
    ]) {
      const result = evaluateTheory(candidate, { ...OPTIONS, caseCount: 4000 });
      for (const metrics of [result.inRange, result.outOfRange]) {
        expect(metrics.accuracy).toBeGreaterThanOrEqual(0.45);
        expect(metrics.accuracy).toBeLessThanOrEqual(0.55);
      }
    }
  });

  it("demonstrates one specific range-overfit theory", () => {
    // Multiplying by a * (10 - a) preserves the target sign inside (0, 10)
    // but reverses it whenever a is outside the public range.
    const overfitMeasurement = bin(
      "mul",
      glowMeasurement(),
      bin("mul", v("a"), bin("sub", k(10), v("a"))),
    );
    const overfitTheory = theory(overfitMeasurement, "lt", 0);
    const selectedObservations = [
      { a: 2, b: 8, c: 1 },
      { a: 8, b: 2, c: 9 },
      { a: 2, b: 2, c: 4 },
      { a: 8, b: 8, c: 6 },
    ];

    for (const inputs of selectedObservations) {
      const measurement = evaluateExpression(overfitTheory.measurement, inputs);
      if (!measurement.ok) throw new Error("unexpected measurement error");
      expect(measurement.value < overfitTheory.threshold).toBe(computeGlowOutcome(inputs).glows);
    }

    const result = evaluateTheory(overfitTheory, OPTIONS);
    expect(result.inRange.accuracy).toBe(1);
    expect(result.outOfRange.accuracy).toBe(0);
  });

  it("counts each measurement failure as an incorrect prediction", () => {
    const alwaysInvalid = theory(
      bin("div", k(1), bin("sub", v("a"), v("a"))),
      "lt",
      0,
    );
    const result = evaluateTheory(alwaysInvalid, { ...OPTIONS, caseCount: 100 });

    for (const metrics of [result.inRange, result.outOfRange]) {
      expect(metrics).toStrictEqual({
        totalCases: 100,
        correctPredictions: 0,
        incorrectPredictions: 100,
        accuracy: 0,
        evaluationErrors: { DIVISION_BY_ZERO: 100 },
      });
    }
  });

  it("rejects a forged, unvalidated theory object", () => {
    const forged = {
      measurement: glowMeasurement(),
      operator: "lt",
      threshold: 0,
    } as unknown as ValidatedTheory;
    expect(() => evaluateTheory(forged, OPTIONS)).toThrow(/validated/);
  });

  it("does not mutate observations or consume experiment budget", () => {
    const tools = createExperimentTools({ budget: 3 });
    tools.runExperiment({ a: 2, b: 8, c: 1 });
    const observations = tools.getObservationLog();
    const snapshot = structuredClone(observations);
    const budget = tools.getRemainingBudget();

    evaluateTheory(theory(glowMeasurement(), "lt", 0), OPTIONS);

    expect(observations).toStrictEqual(snapshot);
    expect(tools.getObservationLog()).toStrictEqual(snapshot);
    expect(tools.getRemainingBudget()).toBe(budget);
  });
});
