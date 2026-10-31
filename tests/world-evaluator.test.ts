import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  booleanPassThreshold,
  evaluateBooleanWorldTheory,
  evaluateNumericWorldTheory,
  generateWorldCases,
  numericPassThreshold,
  numericTolerance,
  type BooleanWorldReport,
  type NumericWorldReport,
} from "../src/evaluator/world-evaluator.js";
import { THEORY_ERROR, validateTheory } from "../src/language/theory.js";
import { createVariableSet } from "../src/language/expression.js";
import { createWorldTools } from "../src/tools/world-tools.js";
import { DRIFT_WORLD } from "../src/worlds/drift-world.js";
import { GLOW_WORLD } from "../src/worlds/glow-world.js";
import { RING_WORLD } from "../src/worlds/ring-world.js";
import type { World } from "../src/worlds/world.js";
import { bin, call, k, v } from "./helpers/expression-builders.js";

const OPTIONS = { inRangeSeed: 11, outOfRangeSeed: 22, caseCount: 200 };

const squared = (name: string, center: number) =>
  bin("mul", bin("sub", v(name), k(center)), bin("sub", v(name), k(center)));
const ringMeasurement = () => bin("add", squared("p", 10), squared("q", 5));
const driftMeasurement = (uWeight = 2) =>
  bin("add", bin("sub", bin("mul", k(uWeight), v("u")), bin("mul", k(3), v("v"))), k(10));
const glowMeasurement = () => bin("mul", bin("sub", v("a"), k(5)), bin("sub", v("b"), k(5)));

function booleanReport(world: World, theory: unknown): BooleanWorldReport {
  if (world.kind !== "boolean") throw new Error("boolean world expected");
  const result = evaluateBooleanWorldTheory(world, theory, OPTIONS);
  if (!result.ok) throw new Error("theory rejected");
  return result.report;
}

function numericReport(theory: unknown): NumericWorldReport {
  const result = evaluateNumericWorldTheory(DRIFT_WORLD, theory, OPTIONS);
  if (!result.ok) throw new Error("theory rejected");
  return result.report;
}

describe("World evaluation cases", () => {
  it.each([GLOW_WORLD, RING_WORLD, DRIFT_WORLD].map((world) => [world.spec.worldId, world] as const))(
    "%s: the same seed reproduces the same cases, and another seed does not",
    (_id, world) => {
      const first = generateWorldCases(world, 7, 40, "in-range");
      expect(generateWorldCases(world, 7, 40, "in-range")).toStrictEqual(first);
      expect(generateWorldCases(world, 8, 40, "in-range")).not.toStrictEqual(first);
      expect(first).toHaveLength(40);
    },
  );

  it.each([GLOW_WORLD, RING_WORLD].map((world) => [world.spec.worldId, world] as const))(
    "%s: balances the noiseless classes in both regions",
    (_id, world) => {
      if (world.kind !== "boolean") throw new Error("boolean world expected");
      for (const region of ["in-range", "out-of-range"] as const) {
        const cases = generateWorldCases(world, 3, 200, region);
        expect(cases.filter((testCase) => world.trueOutcome(testCase.inputs)).length).toBe(100);
      }
    },
  );

  it("keeps Ring World's label noise in the held-out labels, and Glow World's labels exact", () => {
    const ring = generateWorldCases(RING_WORLD, 5, 2000, "in-range");
    const flipped = ring.filter((testCase) => testCase.outcome !== RING_WORLD.trueOutcome(testCase.inputs)).length;
    expect(flipped / ring.length).toBeGreaterThan(0.035);
    expect(flipped / ring.length).toBeLessThan(0.065);
    const glow = generateWorldCases(GLOW_WORLD, 5, 200, "in-range");
    expect(glow.every((testCase) => testCase.outcome === GLOW_WORLD.trueOutcome(testCase.inputs))).toBe(true);
  });

  it("adds Drift World's measurement noise to the held-out values", () => {
    const cases = generateWorldCases(DRIFT_WORLD, 5, 2000, "in-range");
    const errors = cases.map((testCase) => (testCase.outcome as number) - DRIFT_WORLD.trueOutcome(testCase.inputs));
    const rms = Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length);
    expect(rms).toBeGreaterThan(0.45);
    expect(rms).toBeLessThan(0.55);
  });

  it.each([GLOW_WORLD, RING_WORLD, DRIFT_WORLD].map((world) => [world.spec.worldId, world] as const))(
    "%s: in-range cases stay in range; out-of-range cases move only the profiled attributes",
    (_id, world) => {
      for (const testCase of generateWorldCases(world, 13, 100, "in-range")) {
        for (const name of world.spec.attributeNames) {
          expect(testCase.inputs[name]).toBeGreaterThanOrEqual(0);
          expect(testCase.inputs[name]).toBeLessThanOrEqual(10);
        }
      }
      const { outsideAttributes, extendedAttributes } = world.extrapolation;
      for (const testCase of generateWorldCases(world, 13, 100, "out-of-range")) {
        for (const name of world.spec.attributeNames) {
          const value = testCase.inputs[name]!;
          if (outsideAttributes.includes(name)) {
            expect(value < -1 || value > 11).toBe(true);
            expect(value).toBeGreaterThanOrEqual(-21);
            expect(value).toBeLessThanOrEqual(21);
          } else if (extendedAttributes.includes(name)) {
            expect(value).toBeGreaterThanOrEqual(-10);
            expect(value).toBeLessThanOrEqual(20);
          } else {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(10);
          }
        }
      }
    },
  );

  it("rejects invalid case counts", () => {
    expect(() => generateWorldCases(RING_WORLD, 1, 3, "in-range")).toThrow();
    expect(() => generateWorldCases(RING_WORLD, 1, 0, "in-range")).toThrow();
    expect(generateWorldCases(DRIFT_WORLD, 1, 3, "in-range")).toHaveLength(3);
  });
});

describe("Noise-aware pass thresholds", () => {
  it("lowers a boolean threshold by the flip rate and three standard errors", () => {
    expect(booleanPassThreshold(0.05, 200)).toBeCloseTo(0.95 - 3 * Math.sqrt((0.05 * 0.95) / 200), 12);
    expect(booleanPassThreshold(0, 200)).toBeCloseTo(1 - 3 * Math.sqrt((0.005 * 0.995) / 200), 12);
    expect(booleanPassThreshold(0.05, 50)).toBeLessThan(booleanPassThreshold(0.05, 200));
    expect(booleanPassThreshold(0.45, 4)).toBe(0.5);
  });

  it("sets the numeric tolerance at three noise standard deviations", () => {
    expect(numericTolerance(0.5)).toBe(1.5);
    expect(numericTolerance(0)).toBeGreaterThan(0);
    expect(numericTolerance(0)).toBeLessThan(1e-6);
    expect(numericPassThreshold(200)).toBeCloseTo(0.9973 - 3 * Math.sqrt((0.9973 * 0.0027) / 200), 12);
  });
});

describe("Boolean world scoring", () => {
  it("passes Ring World's true theory below 100%, because the labels are noisy", () => {
    const report = booleanReport(RING_WORLD, { measurement: ringMeasurement(), operator: "lt", threshold: 25 });
    expect(report.noiseCeiling).toBe(0.95);
    for (const dataset of [report.inRange, report.outOfRange]) {
      expect(dataset.passed).toBe(true);
      expect(dataset.accuracy).toBeGreaterThanOrEqual(dataset.passThreshold);
      expect(dataset.accuracy).toBeLessThan(1);
      expect(dataset.evaluationErrors).toEqual({});
    }
  });

  it("fails Ring World theories built on a distractor, a constant, or one relevant attribute", () => {
    const distractor = booleanReport(RING_WORLD, { measurement: v("r"), operator: "gt", threshold: 5 });
    const constant = booleanReport(RING_WORLD, { measurement: k(0), operator: "gt", threshold: 0 });
    const partial = booleanReport(RING_WORLD, { measurement: v("p"), operator: "gt", threshold: 6 });
    for (const report of [distractor, constant]) {
      for (const dataset of [report.inRange, report.outOfRange]) {
        expect(dataset.passed).toBe(false);
        expect(dataset.accuracy).toBeGreaterThan(0.35);
        expect(dataset.accuracy).toBeLessThan(0.65);
      }
    }
    expect(partial.inRange.passed).toBe(false);
    expect(partial.outOfRange.passed).toBe(false);
    expect(partial.inRange.accuracy).toBeGreaterThan(distractor.inRange.accuracy);
  });

  it("scores Glow World through the generic path: the true theory is exact, a distractor is chance", () => {
    const truth = booleanReport(GLOW_WORLD, { measurement: glowMeasurement(), operator: "lt", threshold: 0 });
    expect(truth.noiseCeiling).toBe(1);
    expect(truth.inRange.accuracy).toBe(1);
    expect(truth.outOfRange.accuracy).toBe(1);
    expect(truth.inRange.passed && truth.outOfRange.passed).toBe(true);
    const distractor = booleanReport(GLOW_WORLD, { measurement: v("c"), operator: "gt", threshold: 5 });
    expect(distractor.inRange.passed).toBe(false);
    expect(distractor.inRange.accuracy).toBeGreaterThan(0.35);
    expect(distractor.inRange.accuracy).toBeLessThan(0.65);
  });

  it("accepts an already validated, frozen theory", () => {
    const validated = validateTheory(
      { measurement: ringMeasurement(), operator: "lt", threshold: 25 },
      createVariableSet(["p", "q", "r", "s"]),
    );
    if (!validated.ok) throw new Error("expected valid");
    expect(booleanReport(RING_WORLD, validated.theory).inRange.passed).toBe(true);
  });

  it("rejects a theory that names another world's attributes or has the numeric shape", () => {
    const invalid = { ok: false, error: THEORY_ERROR };
    expect(evaluateBooleanWorldTheory(RING_WORLD, { measurement: glowMeasurement(), operator: "lt", threshold: 0 }, OPTIONS)).toEqual(invalid);
    expect(evaluateBooleanWorldTheory(RING_WORLD, { measurement: v("p") }, OPTIONS)).toEqual(invalid);
    expect(evaluateBooleanWorldTheory(RING_WORLD, null, OPTIONS)).toEqual(invalid);
  });

  it("counts a measurement error as a wrong prediction", () => {
    const report = booleanReport(RING_WORLD, { measurement: call("log", bin("sub", v("p"), k(20))), operator: "gt", threshold: 0 });
    expect(report.inRange.correctPredictions).toBe(0);
    expect(report.inRange.evaluationErrors).toEqual({ LOG_OF_NON_POSITIVE: 200 });
  });
});

describe("Numeric world scoring", () => {
  it("passes Drift World's true theory with an error close to the noise level", () => {
    const report = numericReport({ measurement: driftMeasurement() });
    expect(report.noiseStandardDeviation).toBe(0.5);
    expect(report.tolerance).toBe(1.5);
    for (const dataset of [report.inRange, report.outOfRange]) {
      expect(dataset.passed).toBe(true);
      expect(dataset.scoredCases).toBe(200);
      expect(dataset.rootMeanSquaredError).toBeGreaterThan(0.4);
      expect(dataset.rootMeanSquaredError).toBeLessThan(0.6);
    }
  });

  it("fails a slightly wrong coefficient, most clearly out of range", () => {
    const report = numericReport({ measurement: driftMeasurement(2.1) });
    expect(report.inRange.passed).toBe(false);
    expect(report.outOfRange.passed).toBe(false);
    expect(report.outOfRange.withinToleranceRate).toBeLessThan(report.inRange.withinToleranceRate);
  });

  it("passes a range-clamped theory in range and fails it out of range", () => {
    const report = numericReport({ measurement: call("max", k(-20), call("min", k(30), driftMeasurement())) });
    expect(report.inRange.passed).toBe(true);
    expect(report.outOfRange.passed).toBe(false);
  });

  it("fails theories built on distractors or a constant", () => {
    for (const measurement of [bin("add", v("w"), v("x")), k(5)]) {
      const report = numericReport({ measurement });
      expect(report.inRange.passed).toBe(false);
      expect(report.outOfRange.passed).toBe(false);
      expect(report.inRange.meanAbsoluteError).toBeGreaterThan(5);
    }
  });

  it("rejects the boolean theory shape and other worlds' attributes", () => {
    const invalid = { ok: false, error: THEORY_ERROR };
    expect(evaluateNumericWorldTheory(DRIFT_WORLD, { measurement: v("u"), operator: "gt", threshold: 0 }, OPTIONS)).toEqual(invalid);
    expect(evaluateNumericWorldTheory(DRIFT_WORLD, { measurement: v("a") }, OPTIONS)).toEqual(invalid);
  });

  it("reports null error metrics when no case can be scored", () => {
    const report = numericReport({ measurement: bin("div", v("u"), k(0)) });
    expect(report.inRange.scoredCases).toBe(0);
    expect(report.inRange.meanAbsoluteError).toBeNull();
    expect(report.inRange.rootMeanSquaredError).toBeNull();
    expect(report.inRange.withinToleranceRate).toBe(0);
    expect(report.inRange.evaluationErrors).toEqual({ DIVISION_BY_ZERO: 200 });
  });
});

describe("World evaluator separation", () => {
  it("returns aggregate metrics only", () => {
    const boolean = booleanReport(RING_WORLD, { measurement: v("p"), operator: "gt", threshold: 6 });
    expect(Object.keys(boolean).sort()).toEqual(["complexity", "inRange", "kind", "noiseCeiling", "outOfRange"]);
    expect(Object.keys(boolean.inRange).sort()).toEqual([
      "accuracy",
      "correctPredictions",
      "evaluationErrors",
      "incorrectPredictions",
      "passThreshold",
      "passed",
      "totalCases",
    ]);
    const numeric = numericReport({ measurement: v("u") });
    expect(Object.keys(numeric).sort()).toEqual([
      "complexity",
      "inRange",
      "kind",
      "noiseStandardDeviation",
      "outOfRange",
      "tolerance",
    ]);
  });

  it("does not touch the experiment tools", () => {
    const tools = createWorldTools(RING_WORLD, { budget: 5 });
    tools.runExperiment({ p: 1, q: 1, r: 1, s: 1 });
    const log = tools.getObservationLog();
    booleanReport(RING_WORLD, { measurement: ringMeasurement(), operator: "lt", threshold: 25 });
    expect(tools.getObservationLog()).toStrictEqual(log);
    expect(tools.getRemainingBudget()).toBe(4);
    const source = readFileSync(new URL("../src/evaluator/world-evaluator.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+"\.\.\/tools\//);
  });
});
