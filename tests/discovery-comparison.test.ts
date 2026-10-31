import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BASELINE_COMPARISON_BUDGET, BASELINE_COMPARISON_SEED } from "../src/agents/baseline-comparison.js";
import {
  formatDiscoveryComparison,
  runDiscoveryComparison,
  DISCOVERY_COMPARISON_EVALUATION,
} from "../src/agents/discovery-comparison.js";
import { SUBMIT_THEORY_TOOL } from "../src/agents/discovery-tool-declarations.js";
import { calls, createScriptedProvider } from "./helpers/scripted-provider.js";

const PRODUCT = "((a - 5) * (b - 5)) < 0";

describe("Discovery comparison", () => {
  it("scores the dummy and both baselines at the same budget", async () => {
    const report = await runDiscoveryComparison();
    expect(report.budget).toBe(BASELINE_COMPARISON_BUDGET);
    expect(report.seed).toBe(BASELINE_COMPARISON_SEED);
    expect(report.liveModel).toBe(false);
    expect(report.evaluationOptions).toEqual(DISCOVERY_COMPARISON_EVALUATION);
    expect(report.baselines.map((strategy) => strategy.name)).toEqual(["random-explorer", "systematic-explorer"]);
    expect(report.agent).toMatchObject({
      name: "dummy",
      status: "theory_submitted",
      modelTurns: 2,
      experimentCount: 27,
      remainingBudget: 0,
    });

    for (const strategy of [report.agent, ...report.baselines]) {
      expect(strategy.experimentCount).toBe(27);
      expect(strategy.remainingBudget).toBe(0);
      expect(strategy.inSampleAccuracy).toBe(1);
      expect(strategy.evaluation?.inRange.accuracy).toBe(1);
      expect(strategy.evaluation?.outOfRange.accuracy).toBe(1);
      expect(strategy.evaluation?.complexity.nodeCount).toBe(7);
    }

    const text = formatDiscoveryComparison(report);
    expect(text).toContain("NOT A LIVE MODEL");
    expect(text).toContain("coincides");
    expect(text).toContain(PRODUCT);
    expect(text).toContain("random-explorer");
    expect(text).toContain("systematic-explorer");
    expect(formatDiscoveryComparison(await runDiscoveryComparison())).toBe(text);
  });

  it("shows a short all-dark sample fitting in-sample and missing on held-out cases", async () => {
    const report = await runDiscoveryComparison({ budget: 4, timeoutMs: 1_000, maxRetries: 0 });
    const systematic = report.baselines.find((strategy) => strategy.name === "systematic-explorer");
    expect(report.agent.experimentCount).toBe(4);
    expect(report.agent.inSampleAccuracy).toBe(1);
    expect(report.agent.evaluation?.inRange.accuracy).toBe(0.5);
    expect(report.agent.evaluation?.outOfRange.accuracy).toBe(0.5);
    expect(report.agent.evaluation?.complexity.nodeCount).toBe(1);
    expect(systematic?.experimentCount).toBe(4);
    expect(systematic?.inSampleAccuracy).toBe(1);
    expect(systematic?.evaluation?.inRange.accuracy).toBe(0.5);
    expect(systematic?.evaluation?.complexity.nodeCount).toBe(1);
    expect(formatDiscoveryComparison(report)).toContain("0 > 0");
  });

  it("does not send comparison notes or evaluation seeds to the provider", async () => {
    const script = createScriptedProvider([
      calls(SUBMIT_THEORY_TOOL, { measurement: { const: 0 }, operator: "gt", threshold: 0 }, "theory"),
    ]);
    const report = await runDiscoveryComparison({
      provider: script.provider,
      timeoutMs: 1_000,
      maxRetries: 0,
      maxModelTurns: 2,
    });

    expect(report.agent.name).toBe("scripted");
    expect(report.agent.experimentCount).toBe(0);
    expect(report.agent.evaluation?.inRange.accuracy).toBe(0.5);
    expect(report.notes.exploration).toContain("supplied by the caller");
    const shown = JSON.stringify(script.requests);
    expect(shown).not.toContain("NOT A LIVE MODEL");
    expect(shown).not.toContain("coincides");
    expect(shown).not.toContain("424242");
    expect(shown).not.toContain("737373");
    expect(shown).not.toContain("correctPredictions");
  });

  it("keeps the comparison orchestrator off the world engine import", () => {
    const source = readFileSync(new URL("../src/agents/discovery-comparison.ts", import.meta.url), "utf8");
    expect(source).toContain('from "../evaluator/evaluator.js"');
    expect(source).not.toMatch(/from\s+"[^"]*worlds/);
    expect(source).not.toMatch(/HIDDEN_THRESHOLD|computeGlowOutcome/);
  });
});
