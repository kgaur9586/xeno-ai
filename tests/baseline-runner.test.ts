import { describe, expect, it } from "vitest";
import { runBaseline, summarizeObservations, type BaselineReport } from "../src/agents/baseline-runner.js";
import type { Experimenter } from "../src/agents/experimenter.js";
import { createRandomExplorer } from "../src/agents/random-explorer.js";
import { createSystematicExplorer } from "../src/agents/systematic-explorer.js";
import { createExperimentTools } from "../src/tools/experiment-tools.js";
import type { Observation } from "../src/tools/schemas.js";

const description = createExperimentTools().describeWorld();

function observation(step: number, a: number, b: number, c: number, glows: boolean): Observation {
  return { step, inputs: { a, b, c }, outcome: { glows }, remainingBudget: 30 - step };
}

describe("summarizeObservations", () => {
  const observations = [
    observation(1, 0, 10, 1, true),
    observation(2, 1.99, 2, 1, false),
    observation(3, 2, 2, 1, false),
    observation(4, 0, 10, 1, true),
    observation(5, 10, 5, 9, false),
  ];
  const summary = summarizeObservations(observations, description);

  it("counts experiments, unique inputs, and repeats", () => {
    expect(summary.experimentCount).toBe(5);
    expect(summary.uniqueInputCount).toBe(4);
    expect(summary.repeatedExperimentCount).toBe(1);
  });

  it("counts glowing and non-glowing outcomes", () => {
    expect(summary.outcomeCounts).toEqual({ glowing: 2, notGlowing: 3 });
  });

  it("computes per-attribute min, max, mean, and distinct values", () => {
    expect(summary.attributes.a).toMatchObject({ min: 0, max: 10, distinctValueCount: 4 });
    expect(summary.attributes.a.mean).toBeCloseTo((0 + 1.99 + 2 + 0 + 10) / 5, 10);
    expect(summary.attributes.b).toMatchObject({ min: 2, max: 10, mean: 29 / 5, distinctValueCount: 3 });
    expect(summary.attributes.c).toMatchObject({ min: 1, max: 9, mean: 13 / 5, distinctValueCount: 2 });
  });

  it("builds five equal-width histogram bins over the public range", () => {
    expect(summary.attributes.a.histogram).toEqual([
      { from: 0, to: 2, count: 3 }, // 0, 1.99, 0
      { from: 2, to: 4, count: 1 }, // 2 (lower edge belongs to this bin)
      { from: 4, to: 6, count: 0 },
      { from: 6, to: 8, count: 0 },
      { from: 8, to: 10, count: 1 }, // 10 (range maximum goes to the last bin)
    ]);
    expect(summary.attributes.b.histogram.map((bin) => bin.count)).toEqual([0, 2, 1, 0, 2]);
  });

  it("handles an empty log", () => {
    const empty = summarizeObservations([], description);
    expect(empty).toMatchObject({
      experimentCount: 0,
      uniqueInputCount: 0,
      repeatedExperimentCount: 0,
      outcomeCounts: { glowing: 0, notGlowing: 0 },
    });
    expect(empty.attributes.a).toMatchObject({ min: null, max: null, mean: null, distinctValueCount: 0 });
    expect(empty.attributes.a.histogram.every((bin) => bin.count === 0)).toBe(true);
  });
});

describe("runBaseline", () => {
  function expectConsistent(report: BaselineReport): void {
    expect(report.observations).toHaveLength(report.experimentCount);
    expect(report.experimentCount).toBe(report.budget - report.remainingBudget);
    expect(report.outcomeCounts.glowing + report.outcomeCounts.notGlowing).toBe(report.experimentCount);
    expect(report.uniqueInputCount + report.repeatedExperimentCount).toBe(report.experimentCount);
    expect(report.requestCount).toBe(
      report.experimentCount + report.rejectedRequests.INVALID_INPUT + report.rejectedRequests.BUDGET_EXHAUSTED,
    );
    for (const attribute of ["a", "b", "c"] as const) {
      const histogramTotal = report.attributes[attribute].histogram.reduce((total, bin) => total + bin.count, 0);
      expect(histogramTotal).toBe(report.experimentCount);
    }
  }

  it("reports metrics that match its own observations", () => {
    for (const report of [
      runBaseline(createRandomExplorer({ seed: 5 })),
      runBaseline(createSystematicExplorer()),
    ]) {
      expectConsistent(report);
      const { observations, ...rest } = report;
      expect(rest).toMatchObject(summarizeObservations(observations, description));
    }
  });

  it("names the experimenter and uses a default budget of 30", () => {
    const report = runBaseline(createSystematicExplorer());
    expect(report.experimenter).toBe("systematic-explorer");
    expect(report.budget).toBe(30);
    expect(runBaseline(createRandomExplorer({ seed: 1 })).experimenter).toBe("random-explorer");
  });

  it("counts rejected requests and exhausted-budget refusals", () => {
    const misbehaving: Experimenter = {
      name: "misbehaving",
      run({ tools }) {
        tools.runExperiment({ a: -1, b: 1, c: 1 });
        tools.runExperiment({ a: 1, b: 1, c: 1, extra: true });
        for (let i = 0; i < 5; i++) {
          tools.runExperiment({ a: 8, b: 2, c: 1 });
        }
      },
    };
    const report = runBaseline(misbehaving, { budget: 3 });
    expect(report.requestCount).toBe(7);
    expect(report.rejectedRequests).toEqual({ INVALID_INPUT: 2, BUDGET_EXHAUSTED: 2 });
    expect(report.experimentCount).toBe(3);
    expect(report.remainingBudget).toBe(0);
    expectConsistent(report);
  });

  it("produces identical reports for the same experimenter, seed, and budget", () => {
    expect(runBaseline(createRandomExplorer({ seed: 9 }), { budget: 12 })).toStrictEqual(
      runBaseline(createRandomExplorer({ seed: 9 }), { budget: 12 }),
    );
  });

  it("uses fresh tools for every run", () => {
    const explorer = createSystematicExplorer();
    runBaseline(explorer, { budget: 30 });
    const second = runBaseline(explorer, { budget: 30 });
    expect(second.experimentCount).toBe(27);
    expect(second.observations[0]!.step).toBe(1);
  });

  it("rejects an invalid budget", () => {
    expect(() => runBaseline(createSystematicExplorer(), { budget: 0 })).toThrow();
  });
});
