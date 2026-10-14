import { describe, expect, it } from "vitest";
import { runBaseline } from "../src/agents/baseline-runner.js";
import { createSystematicExplorer, planGrid } from "../src/agents/systematic-explorer.js";
import { createExperimentTools } from "../src/tools/experiment-tools.js";
import type { PublicDescription } from "../src/tools/schemas.js";

const description = createExperimentTools().describeWorld();

function inputKey(inputs: { a: number; b: number; c: number }): string {
  return `${inputs.a},${inputs.b},${inputs.c}`;
}

describe("planGrid", () => {
  it("plans every min/midpoint/max combination exactly once (27 inputs)", () => {
    const plan = planGrid(description);
    expect(plan).toHaveLength(27);
    expect(new Set(plan.map(inputKey)).size).toBe(27);
    for (const attribute of ["a", "b", "c"] as const) {
      expect([...new Set(plan.map((inputs) => inputs[attribute]))].sort((x, y) => x - y)).toEqual([0, 5, 10]);
    }
  });

  it("orders the plan with a changing slowest and c fastest", () => {
    const plan = planGrid(description);
    expect(plan.slice(0, 4)).toEqual([
      { a: 0, b: 0, c: 0 },
      { a: 0, b: 0, c: 5 },
      { a: 0, b: 0, c: 10 },
      { a: 0, b: 5, c: 0 },
    ]);
    expect(plan.at(-1)).toEqual({ a: 10, b: 10, c: 10 });
  });

  it("derives its levels from the public bounds, not from fixed numbers", () => {
    const custom: PublicDescription = {
      ...description,
      attributes: { a: { min: 2, max: 4 }, b: { min: 0, max: 1 }, c: { min: 7, max: 7 } },
    };
    const plan = planGrid(custom);
    expect([...new Set(plan.map(({ a }) => a))]).toEqual([2, 3, 4]);
    expect([...new Set(plan.map(({ b }) => b))]).toEqual([0, 0.5, 1]);
    // A zero-width range contributes one level, so no duplicate inputs are planned.
    expect([...new Set(plan.map(({ c }) => c))]).toEqual([7]);
    expect(plan).toHaveLength(9);
    expect(new Set(plan.map(inputKey)).size).toBe(9);
  });

  it("supports other grid sizes", () => {
    expect(planGrid(description, 2)).toHaveLength(8);
    expect(planGrid(description, 4)).toHaveLength(64);
  });

  it.each([0, 1, 2.5, Number.NaN])("rejects an invalid level count (%s)", (levels) => {
    expect(() => planGrid(description, levels)).toThrow();
    expect(() => createSystematicExplorer({ levelsPerAttribute: levels })).toThrow();
  });
});

describe("Systematic Explorer", () => {
  it("runs exactly its planned grid, in order, and stops when the grid is complete", () => {
    const report = runBaseline(createSystematicExplorer(), { budget: 30 });
    expect(report.observations.map(({ inputs }) => inputs)).toEqual(planGrid(description));
    expect(report.experimentCount).toBe(27);
    expect(report.requestCount).toBe(27);
    expect(report.remainingBudget).toBe(3);
    expect(report.rejectedRequests).toEqual({ INVALID_INPUT: 0, BUDGET_EXHAUSTED: 0 });
  });

  it("never repeats an input", () => {
    const report = runBaseline(createSystematicExplorer());
    expect(report.uniqueInputCount).toBe(report.experimentCount);
    expect(report.repeatedExperimentCount).toBe(0);
  });

  it("stops at the budget when the grid is larger than the budget", () => {
    const small = runBaseline(createSystematicExplorer(), { budget: 10 });
    expect(small.observations.map(({ inputs }) => inputs)).toEqual(planGrid(description).slice(0, 10));
    expect(small.requestCount).toBe(10);
    expect(small.remainingBudget).toBe(0);

    const fine = runBaseline(createSystematicExplorer({ levelsPerAttribute: 4 }), { budget: 30 });
    expect(fine.experimentCount).toBe(30);
    expect(fine.requestCount).toBe(30);
    expect(fine.repeatedExperimentCount).toBe(0);
    expect(fine.rejectedRequests).toEqual({ INVALID_INPUT: 0, BUDGET_EXHAUSTED: 0 });
  });

  it("keeps every input within 0 to 10", () => {
    const report = runBaseline(createSystematicExplorer({ levelsPerAttribute: 4 }), { budget: 64 });
    for (const { inputs } of report.observations) {
      for (const value of [inputs.a, inputs.b, inputs.c]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(10);
      }
    }
  });

  it("is deterministic", () => {
    expect(runBaseline(createSystematicExplorer())).toStrictEqual(runBaseline(createSystematicExplorer()));
  });
});
