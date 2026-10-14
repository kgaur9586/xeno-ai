import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runDiscoverySession } from "../src/agents/discovery-session.js";
import {
  EVALUATE_MEASUREMENT_TOOL,
  RUN_EXPERIMENT_TOOL,
  SUBMIT_THEORY_TOOL,
} from "../src/agents/discovery-tool-declarations.js";
import {
  generateInRangeEvaluationCases,
  generateOutOfRangeEvaluationCases,
} from "../src/evaluator/evaluator.js";
import { calls, createScriptedProvider } from "./helpers/scripted-provider.js";
import { glowMeasurement } from "./helpers/expression-builders.js";

const EVALUATION = { inRangeSeed: 424242, outOfRangeSeed: 737373, caseCount: 100 };

describe("Discovery session", () => {
  it("evaluates a submitted theory only after the provider has finished", async () => {
    const script = createScriptedProvider([
      calls(RUN_EXPERIMENT_TOOL, { a: 1, b: 2, c: 3 }, "exp"),
      calls(
        SUBMIT_THEORY_TOOL,
        { measurement: glowMeasurement(), operator: "lt", threshold: 0 },
        "theory",
      ),
      calls(RUN_EXPERIMENT_TOOL, { a: 0, b: 0, c: 0 }, "after-theory"),
    ]);

    const result = await runDiscoverySession({
      provider: script.provider,
      budget: 5,
      maxModelTurns: 4,
      timeoutMs: 1_000,
      maxRetries: 0,
      evaluation: EVALUATION,
    });

    expect(result.status).toBe("theory_submitted");
    expect(script.callCount).toBe(2);
    expect(result.experimentCount).toBe(1);
    expect(result.remainingBudget).toBe(4);
    expect(result.theoryId).toBe(1);
    expect(result.evaluation?.inRange.accuracy).toBe(1);
    expect(result.evaluation?.outOfRange.accuracy).toBe(1);
    expect(result.evaluation?.complexity.nodeCount).toBeGreaterThan(0);

    const privateCases = [
      ...generateInRangeEvaluationCases(EVALUATION.inRangeSeed, EVALUATION.caseCount),
      ...generateOutOfRangeEvaluationCases(EVALUATION.outOfRangeSeed, EVALUATION.caseCount),
    ];
    const shownToModel = JSON.stringify({
      transcript: result.transcript,
      requests: script.requests,
    });
    expect(shownToModel).not.toContain("424242");
    expect(shownToModel).not.toContain("737373");
    expect(shownToModel).not.toContain("correctPredictions");
    expect(shownToModel).not.toContain("inRange");
    expect(shownToModel).not.toContain("outOfRange");
    for (const testCase of privateCases) {
      if (testCase.inputs.a < 0 || testCase.inputs.a > 10) {
        expect(shownToModel).not.toContain(JSON.stringify(testCase.inputs));
      }
    }
    expect(result.transcript.some((entry) => entry.type === "submitted_theory")).toBe(true);
    expect(script.requests.every((request) => !JSON.stringify(request.messages).includes("accuracy"))).toBe(true);
  });

  it("does not score a session that never submits a theory", async () => {
    const script = createScriptedProvider([
      calls(EVALUATE_MEASUREMENT_TOOL, { expression: { var: "c" } }, "only-measurement"),
    ]);
    const result = await runDiscoverySession({
      provider: script.provider,
      budget: 4,
      maxModelTurns: 1,
      timeoutMs: 1_000,
      maxRetries: 0,
      evaluation: EVALUATION,
    });

    expect(result.status).toBe("turn_limit");
    expect(result.submittedTheory).toBeNull();
    expect(result.evaluation).toBeNull();
    expect(result.theoryId).toBeNull();
    expect(result.experimentCount).toBe(0);
    expect(result.remainingBudget).toBe(4);
    expect(JSON.stringify(script.requests)).not.toContain("424242");
  });

  it("keeps the session orchestrator separate from the world engine", () => {
    const source = readFileSync(new URL("../src/agents/discovery-session.ts", import.meta.url), "utf8");
    expect(source).toContain("evaluateTheory");
    expect(source).not.toMatch(/from\s+"[^"]*worlds/);
    expect(source.indexOf("await runDiscoveryAgent")).toBeLessThan(source.indexOf("scoreAfterDiscovery("));
    expect(source).not.toMatch(/HIDDEN_THRESHOLD|computeGlowOutcome/);
  });
});
