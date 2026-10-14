import { describe, expect, it } from "vitest";
import { runBaseline } from "../src/agents/baseline-runner.js";
import { createRandomExplorer } from "../src/agents/random-explorer.js";

describe("Random Explorer", () => {
  it("uses the whole default budget of 30 through the tools, with no rejected requests", () => {
    const report = runBaseline(createRandomExplorer({ seed: 1 }));
    expect(report.experimentCount).toBe(30);
    expect(report.observations).toHaveLength(30);
    expect(report.requestCount).toBe(30);
    expect(report.rejectedRequests).toEqual({ INVALID_INPUT: 0, BUDGET_EXHAUSTED: 0 });
    expect(report.remainingBudget).toBe(0);
  });

  it.each([1, 7, 30, 100])("respects a configured budget of %i", (budget) => {
    const report = runBaseline(createRandomExplorer({ seed: 3 }), { budget });
    expect(report.experimentCount).toBe(budget);
    expect(report.requestCount).toBe(budget);
    expect(report.remainingBudget).toBe(0);
  });

  it("keeps every input finite and within 0 to 10", () => {
    for (const seed of [1, 42, 2026]) {
      const report = runBaseline(createRandomExplorer({ seed }), { budget: 200 });
      for (const { inputs } of report.observations) {
        for (const value of [inputs.a, inputs.b, inputs.c]) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(10);
        }
      }
    }
  });

  it("reproduces the same experiments for the same seed", () => {
    const first = runBaseline(createRandomExplorer({ seed: 42 }));
    const second = runBaseline(createRandomExplorer({ seed: 42 }));
    expect(second).toStrictEqual(first);
  });

  it("repeats its choices when the same explorer instance runs twice", () => {
    const explorer = createRandomExplorer({ seed: 42 });
    expect(runBaseline(explorer).observations).toStrictEqual(runBaseline(explorer).observations);
  });

  it("makes different choices for different seeds", () => {
    const first = runBaseline(createRandomExplorer({ seed: 1 }));
    const second = runBaseline(createRandomExplorer({ seed: 2 }));
    expect(second.observations).not.toEqual(first.observations);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid seed (%s)", (seed) => {
    expect(() => createRandomExplorer({ seed })).toThrow();
  });
});
