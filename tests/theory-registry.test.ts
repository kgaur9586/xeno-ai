import { describe, expect, it } from "vitest";
import { evaluateTheory } from "../src/evaluator/evaluator.js";
import { createTheoryRegistry } from "../src/evaluator/theory-registry.js";
import { validateTheory, type ValidatedTheory } from "../src/language/theory.js";
import { glowMeasurement } from "./helpers/expression-builders.js";

function targetTheory(): ValidatedTheory {
  const result = validateTheory({
    measurement: glowMeasurement(),
    operator: "lt",
    threshold: 0,
  });
  if (!result.ok) throw new Error("expected valid theory");
  return result.theory;
}

describe("In-memory theory registry", () => {
  it("records theories with their exact evaluation metrics", () => {
    const registry = createTheoryRegistry();
    const candidate = targetTheory();
    const evaluation = evaluateTheory(candidate, {
      inRangeSeed: 11,
      outOfRangeSeed: 22,
      caseCount: 100,
    });

    const record = registry.register(candidate, evaluation);
    expect(record.id).toBe(1);
    expect(record.theory).toStrictEqual({
      measurement: glowMeasurement(),
      operator: "lt",
      threshold: 0,
    });
    expect(record.evaluation).toStrictEqual(evaluation);
    expect(record.evaluation.inRange.correctPredictions).toBe(100);
    expect(record.evaluation.outOfRange.correctPredictions).toBe(100);
    expect(record.evaluation.complexity).toStrictEqual({ nodeCount: 7, depth: 3 });
    expect(registry.get(1)).toStrictEqual(record);
    expect(registry.list()).toStrictEqual([record]);
  });

  it("assigns deterministic increasing IDs", () => {
    const registry = createTheoryRegistry();
    const candidate = targetTheory();
    const evaluation = evaluateTheory(candidate, {
      inRangeSeed: 1,
      outOfRangeSeed: 2,
      caseCount: 20,
    });

    expect(registry.register(candidate, evaluation).id).toBe(1);
    expect(registry.register(candidate, evaluation).id).toBe(2);
    expect(registry.get(999)).toBeUndefined();
  });

  it("keeps defensive copies of theories and metrics", () => {
    const registry = createTheoryRegistry();
    const candidate = targetTheory();
    const evaluation = evaluateTheory(candidate, {
      inRangeSeed: 1,
      outOfRangeSeed: 2,
      caseCount: 20,
    });
    const first = registry.register(candidate, evaluation);

    first.theory.threshold = 999;
    (first.theory.measurement as { op: string }).op = "add";
    first.evaluation.inRange.correctPredictions = 0;
    first.evaluation.inRange.evaluationErrors.DIVISION_BY_ZERO = 20;
    const listed = registry.list();
    listed[0]!.evaluation.outOfRange.accuracy = 0;

    const stored = registry.get(1);
    expect(stored?.theory.threshold).toBe(0);
    expect(stored?.theory.measurement).toStrictEqual(glowMeasurement());
    expect(stored?.evaluation.inRange.correctPredictions).toBe(20);
    expect(stored?.evaluation.inRange.evaluationErrors).toStrictEqual({});
    expect(stored?.evaluation.outOfRange.accuracy).toBe(1);
  });

  it("rejects forged theories", () => {
    const registry = createTheoryRegistry();
    const forged = {
      measurement: glowMeasurement(),
      operator: "lt",
      threshold: 0,
    } as unknown as ValidatedTheory;
    expect(() =>
      registry.register(forged, {
        inRange: {
          totalCases: 0,
          correctPredictions: 0,
          incorrectPredictions: 0,
          accuracy: 0,
          evaluationErrors: {},
        },
        outOfRange: {
          totalCases: 0,
          correctPredictions: 0,
          incorrectPredictions: 0,
          accuracy: 0,
          evaluationErrors: {},
        },
        complexity: { nodeCount: 1, depth: 1 },
      }),
    ).toThrow(/validated/);
  });
});
