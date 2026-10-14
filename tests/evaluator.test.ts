import { describe, expect, it } from "vitest";
import {
  evaluatePredictor,
  generateEvaluationCases,
  scorePredictor,
  type Predictor,
} from "../src/evaluator/evaluator.js";
import { createSeededRandom } from "../src/shared/random.js";
import { createExperimentTools } from "../src/tools/experiment-tools.js";

const SEEDS = [1, 42, 2026];
const CASE_COUNT = 1000;

const correctPredictor: Predictor = ({ a, b }) => (a - 5) * (b - 5) < 0;
const alwaysGlows: Predictor = () => true;
const neverGlows: Predictor = () => false;
const aAboveFive: Predictor = ({ a }) => a > 5;
const bAboveFive: Predictor = ({ b }) => b > 5;
const cAboveFive: Predictor = ({ c }) => c > 5;
const partialPredictor: Predictor = ({ a, b }) => a > 5 && b < 5;

describe("Seeded random number generator", () => {
  it("produces the same sequence for the same seed", () => {
    const first = createSeededRandom(123);
    const second = createSeededRandom(123);
    for (let i = 0; i < 1000; i++) {
      expect(second()).toBe(first());
    }
  });

  it("produces different sequences for different seeds", () => {
    const first = createSeededRandom(1);
    const second = createSeededRandom(2);
    const a = Array.from({ length: 10 }, () => first());
    const b = Array.from({ length: 10 }, () => second());
    expect(a).not.toEqual(b);
  });

  it("stays within [0, 1)", () => {
    const random = createSeededRandom(7);
    for (let i = 0; i < 10000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("rejects non-integer seeds", () => {
    expect(() => createSeededRandom(1.5)).toThrow();
    expect(() => createSeededRandom(Number.NaN)).toThrow();
  });
});

describe("[AT-1] Reproducibility of evaluation cases", () => {
  it("the same seed and count produce an identical case list in the same order", () => {
    for (const seed of SEEDS) {
      expect(generateEvaluationCases(seed, CASE_COUNT)).toStrictEqual(
        generateEvaluationCases(seed, CASE_COUNT),
      );
    }
  });

  it("the same seed produces the same score", () => {
    const first = evaluatePredictor(aAboveFive, { seed: 9, caseCount: 200 });
    const second = evaluatePredictor(aAboveFive, { seed: 9, caseCount: 200 });
    expect(second).toStrictEqual(first);
  });

  it("different seeds produce different case lists (the seed is actually used)", () => {
    expect(generateEvaluationCases(1, 20)).not.toEqual(generateEvaluationCases(2, 20));
  });
});

describe("Balanced, in-range case generation", () => {
  it("has exactly half glowing and half not glowing cases", () => {
    for (const seed of SEEDS) {
      const cases = generateEvaluationCases(seed, CASE_COUNT);
      expect(cases).toHaveLength(CASE_COUNT);
      expect(cases.filter((testCase) => testCase.glows)).toHaveLength(CASE_COUNT / 2);
      expect(cases.filter((testCase) => !testCase.glows)).toHaveLength(CASE_COUNT / 2);
    }
  });

  it("labels every case with the world's outcome", () => {
    for (const testCase of generateEvaluationCases(5, CASE_COUNT)) {
      expect(testCase.glows).toBe(correctPredictor(testCase.inputs));
    }
  });

  it("rejects odd, zero, negative, or non-integer case counts", () => {
    for (const count of [0, -2, 3, 2.5, Number.NaN]) {
      expect(() => generateEvaluationCases(1, count)).toThrow();
    }
  });
});

describe("[AT-10] Evaluation separation", () => {
  it("running the evaluator does not change the observation log or the budget", () => {
    const tools = createExperimentTools();
    tools.runExperiment({ a: 8, b: 2, c: 1 });
    const logBefore = tools.getObservationLog();
    const budgetBefore = tools.getRemainingBudget();

    evaluatePredictor(correctPredictor, { seed: 42, caseCount: CASE_COUNT });
    generateEvaluationCases(7, CASE_COUNT);

    expect(tools.getObservationLog()).toStrictEqual(logBefore);
    expect(tools.getRemainingBudget()).toBe(budgetBefore);
  });

  it("all evaluation inputs lie within 0 to 10", () => {
    for (const seed of SEEDS) {
      for (const { inputs } of generateEvaluationCases(seed, CASE_COUNT)) {
        for (const value of [inputs.a, inputs.b, inputs.c]) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(10);
        }
      }
    }
  });

  it("a predictor cannot alter the evaluation cases it is scored on", () => {
    const cases = generateEvaluationCases(3, 100);
    const snapshot = structuredClone(cases);
    const vandal: Predictor = (inputs) => {
      inputs.a = 0;
      inputs.b = 0;
      return true;
    };
    scorePredictor(vandal, cases);
    expect(cases).toStrictEqual(snapshot);
  });
});

describe("[AT-11] Evaluator discriminates between predictors", () => {
  function accuracy(predictor: Predictor, seed: number): number {
    return evaluatePredictor(predictor, { seed, caseCount: CASE_COUNT }).accuracy;
  }

  it.each(SEEDS)("correct predictor scores 100%% (seed %i)", (seed) => {
    const result = evaluatePredictor(correctPredictor, { seed, caseCount: CASE_COUNT });
    expect(result).toStrictEqual({ caseCount: CASE_COUNT, correct: CASE_COUNT, accuracy: 1 });
  });

  it.each(SEEDS)("constant predictors score exactly 50%% (seed %i)", (seed) => {
    expect(accuracy(alwaysGlows, seed)).toBe(0.5);
    expect(accuracy(neverGlows, seed)).toBe(0.5);
  });

  it.each(SEEDS)("single-attribute predictors score near 50%% (seed %i)", (seed) => {
    for (const predictor of [aAboveFive, bAboveFive, cAboveFive]) {
      const score = accuracy(predictor, seed);
      expect(score).toBeGreaterThanOrEqual(0.45);
      expect(score).toBeLessThanOrEqual(0.55);
    }
  });

  it.each(SEEDS)("partial predictor (a > 5 and b < 5) scores near 75%% (seed %i)", (seed) => {
    const score = accuracy(partialPredictor, seed);
    expect(score).toBeGreaterThanOrEqual(0.7);
    expect(score).toBeLessThanOrEqual(0.8);
  });

  it("ranks the predictors in the expected order", () => {
    const seed = 42;
    const correct = accuracy(correctPredictor, seed);
    const partial = accuracy(partialPredictor, seed);
    const single = accuracy(aAboveFive, seed);
    expect(correct).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(single);
  });
});
