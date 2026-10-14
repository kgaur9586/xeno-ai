import { describe, expect, it } from "vitest";
import {
  BASELINE_COMPARISON_BUDGET,
  BASELINE_COMPARISON_SEED,
  formatBaselineComparison,
  runBaselineComparison,
} from "../src/agents/baseline-comparison.js";
import { runBaseline } from "../src/agents/baseline-runner.js";
import { createRandomExplorer } from "../src/agents/random-explorer.js";
import { createSystematicExplorer } from "../src/agents/systematic-explorer.js";

describe("Baseline comparison", () => {
  it("uses a budget of 27 and seed 42", () => {
    expect(BASELINE_COMPARISON_BUDGET).toBe(27);
    expect(BASELINE_COMPARISON_SEED).toBe(42);
  });

  it("runs both explorers through the existing runner with the same budget", () => {
    const [random, systematic] = runBaselineComparison();
    expect(random).toStrictEqual(runBaseline(createRandomExplorer({ seed: 42 }), { budget: 27 }));
    expect(systematic).toStrictEqual(runBaseline(createSystematicExplorer(), { budget: 27 }));
    expect(random!.budget).toBe(systematic!.budget);
    expect(random!.experimentCount).toBe(27);
    expect(systematic!.experimentCount).toBe(27);
  });

  it("produces identical output on every run", () => {
    expect(formatBaselineComparison(runBaselineComparison())).toBe(
      formatBaselineComparison(runBaselineComparison()),
    );
  });

  it("labels the output as exploration metrics, not discovery accuracy", () => {
    const output = formatBaselineComparison(runBaselineComparison());
    expect(output).toContain("EXPLORATION METRICS ONLY");
    expect(output).toContain("do NOT measure");
    expect(output).toContain("rule-discovery accuracy");
  });

  it("reports every required metric for both explorers", () => {
    const output = formatBaselineComparison(runBaselineComparison());
    for (const label of [
      "random-explorer",
      "systematic-explorer",
      "Experiments run",
      "Unique inputs",
      "Repeated inputs",
      "Glowing outcomes",
      "Non-glowing outcomes",
      "Coverage of a",
      "Coverage of b",
      "Coverage of c",
    ]) {
      expect(output).toContain(label);
    }
  });

  it("describes the systematic grid's coverage from its report", () => {
    const output = formatBaselineComparison(runBaselineComparison());
    const coverageLine = output.split("\n").find((line) => line.startsWith("Coverage of a"))!;
    expect(coverageLine).toContain("3 distinct, 0 to 10, 3/5 bins");
  });
});
