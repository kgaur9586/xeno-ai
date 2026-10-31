import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runDiscoverySession } from "../src/agents/discovery-session.js";
import { RUN_EXPERIMENT_TOOL, SUBMIT_THEORY_TOOL } from "../src/agents/discovery-tool-declarations.js";
import { formatWorldComparison, runWorldComparison } from "../src/agents/world-comparison.js";
import { CompareArgumentsError, parseCompareArgs } from "../src/cli/compare.js";
import { THEORY_ERROR } from "../src/language/theory.js";
import { createDummyProvider, DUMMY_DESIGN_SEED, dummyDesign } from "../src/llm/dummy-provider.js";
import type { LlmCompletionRequest, LlmProvider } from "../src/llm/provider.js";
import { createWorldToolsById } from "../src/tools/world-tools.js";
import { BASELINE_COMPARISON_SEED } from "../src/agents/baseline-comparison.js";
import { calls, createScriptedProvider } from "./helpers/scripted-provider.js";

const EVALUATION = { inRangeSeed: 11, outOfRangeSeed: 22, caseCount: 200 };

function recording(inner: LlmProvider): { provider: LlmProvider; requests: LlmCompletionRequest[] } {
  const requests: LlmCompletionRequest[] = [];
  return {
    requests,
    provider: {
      name: inner.name,
      complete(request) {
        requests.push(structuredClone({ ...request, signal: undefined }) as unknown as LlmCompletionRequest);
        return inner.complete(request);
      },
    },
  };
}

function trueDriftTheory() {
  return {
    measurement: {
      op: "add",
      left: {
        op: "sub",
        left: { op: "mul", left: { const: 2 }, right: { var: "u" } },
        right: { op: "mul", left: { const: 3 }, right: { var: "v" } },
      },
      right: { const: 10 },
    },
  };
}

describe("Dummy provider design", () => {
  it("uses the public grid for three attributes and a seeded random design for more", () => {
    const glow = createWorldToolsById("glow-world", { budget: 27 }).describeWorld();
    expect(dummyDesign(glow)).toHaveLength(27);

    const ring = createWorldToolsById("ring-world", { budget: 20 }).describeWorld();
    const design = dummyDesign(ring);
    expect(design).toHaveLength(20);
    expect(dummyDesign(ring)).toEqual(design);
    for (const point of design) {
      expect(Object.keys(point)).toEqual(["p", "q", "r", "s"]);
      for (const [name, value] of Object.entries(point)) {
        expect(value).toBeGreaterThanOrEqual(ring.attributes[name]!.min);
        expect(value).toBeLessThanOrEqual(ring.attributes[name]!.max);
      }
    }
    expect(DUMMY_DESIGN_SEED).not.toBe(BASELINE_COMPARISON_SEED);
  });
});

describe("Discovery session on other worlds", () => {
  it("submits a boolean theory on Ring World and scores it with the noise-aware evaluator", async () => {
    const result = await runDiscoverySession({
      provider: createDummyProvider(),
      worldId: "ring-world",
      noiseSeed: 3,
      budget: 27,
      maxModelTurns: 6,
      maxRetries: 0,
      evaluation: EVALUATION,
    });
    expect(result.status).toBe("theory_submitted");
    expect(result.worldId).toBe("ring-world");
    expect(result.experimentCount).toBe(27);
    expect(result.submittedTheory).not.toBeNull();
    expect(result.submittedNumericTheory).toBeNull();
    expect(result.worldEvaluation?.kind).toBe("boolean");
    expect(result.evaluation).toBeNull();
    expect(result.theoryId).toBeNull();
  });

  it("submits a numeric theory on Drift World", async () => {
    const result = await runDiscoverySession({
      provider: createDummyProvider(),
      worldId: "drift-world",
      noiseSeed: 3,
      budget: 27,
      maxModelTurns: 6,
      maxRetries: 0,
      evaluation: EVALUATION,
    });
    expect(result.status).toBe("theory_submitted");
    expect(result.submittedTheory).toBeNull();
    expect(result.submittedNumericTheory).not.toBeNull();
    const report = result.worldEvaluation;
    expect(report?.kind).toBe("number");
    if (report?.kind === "number") {
      expect(report.inRange.rootMeanSquaredError).toBeLessThan(1);
    }
  });

  it("accepts a measurement-only theory on Drift World and rejects a boolean one", async () => {
    const accepted = createScriptedProvider([calls(SUBMIT_THEORY_TOOL, trueDriftTheory())]);
    const good = await runDiscoverySession({
      provider: accepted.provider,
      worldId: "drift-world",
      maxRetries: 0,
      evaluation: EVALUATION,
    });
    expect(good.status).toBe("theory_submitted");
    expect(good.worldEvaluation?.inRange.passed).toBe(true);
    expect(good.worldEvaluation?.outOfRange.passed).toBe(true);

    const rejected = createScriptedProvider([
      calls(SUBMIT_THEORY_TOOL, { ...trueDriftTheory(), operator: "gt", threshold: 0 }),
      { result: { kind: "text", text: "done" } },
    ]);
    const bad = await runDiscoverySession({
      provider: rejected.provider,
      worldId: "drift-world",
      maxModelTurns: 2,
      maxRetries: 0,
      evaluation: EVALUATION,
    });
    expect(bad.submittedNumericTheory).toBeNull();
    expect(JSON.stringify(bad.transcript)).toContain(THEORY_ERROR.code);
  });

  it("tells the agent noise is present without revealing its size, seed, rule, or held-out cases", async () => {
    for (const worldId of ["ring-world", "drift-world"]) {
      const { provider, requests } = recording(createDummyProvider());
      await runDiscoverySession({
        provider,
        worldId,
        noiseSeed: 987654,
        budget: 27,
        maxModelTurns: 6,
        maxRetries: 0,
        evaluation: { inRangeSeed: 135791, outOfRangeSeed: 246802, caseCount: 200 },
      });
      const seen = JSON.stringify(requests);
      expect(requests[0]!.systemInstruction).toContain("Observations are imprecise");
      expect(seen).not.toMatch(/987654|135791|246802/);
      expect(seen).not.toMatch(/flip|standard deviation|standardDeviation|extrapolation|outsideAttributes/i);
      expect(seen).not.toMatch(/RING_WORLD|DRIFT_WORLD|\(p - 10\)|2u|- 3v/);
      const toolNames = requests[0]!.tools.map((tool) => tool.name);
      expect(toolNames).toContain(RUN_EXPERIMENT_TOOL);
    }
  });

  it("the world comparison module does not import a world engine", () => {
    const source = readFileSync(new URL("../src/agents/world-comparison.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+"[^"]*worlds\//);
  });
});

describe("World comparison", () => {
  it("scores the dummy and both baselines on Drift World at an equal budget", async () => {
    const report = await runWorldComparison({ worldId: "drift-world", budget: 27, noiseSeed: 5, evaluation: EVALUATION });
    expect(report.outcomeKind).toBe("number");
    expect(report.liveModel).toBe(false);
    expect(report.agent.experimentCount).toBe(27);
    expect(report.baselines.map((strategy) => strategy.experimentCount)).toEqual([27, 27]);
    expect(report.agent.theory?.operator).toBeUndefined();
    expect(report.agent.evaluation?.kind).toBe("number");
    const text = formatWorldComparison(report);
    expect(text).toContain("NOT A LIVE MODEL");
    expect(text).toContain("In-range RMSE");
  });

  it("scores boolean worlds by accuracy", async () => {
    const report = await runWorldComparison({ worldId: "ring-world", budget: 27, noiseSeed: 5, evaluation: EVALUATION });
    expect(report.outcomeKind).toBe("boolean");
    expect(report.agent.inSample).toBeGreaterThanOrEqual(0);
    expect(report.agent.inSample).toBeLessThanOrEqual(1);
    expect(report.agent.evaluation?.kind).toBe("boolean");
    expect(formatWorldComparison(report)).toContain("ring-world");
  });

  it("is reproducible for the same seeds", async () => {
    const first = await runWorldComparison({ worldId: "ring-world", noiseSeed: 9, evaluation: EVALUATION });
    const second = await runWorldComparison({ worldId: "ring-world", noiseSeed: 9, evaluation: EVALUATION });
    expect(second).toEqual(first);
  });
});

describe("Compare arguments", () => {
  it("parses --world and --noise-seed", () => {
    expect(parseCompareArgs([])).toEqual({ worldId: undefined, noiseSeed: undefined });
    expect(parseCompareArgs(["--world", "ring-world", "--noise-seed", "-4"])).toEqual({
      worldId: "ring-world",
      noiseSeed: -4,
    });
  });

  it.each([
    [["--world"]],
    [["--world", "nowhere"]],
    [["--noise-seed", "3"]],
    [["--world", "ring-world", "--noise-seed", "1.5"]],
    [["--world", "ring-world", "--world", "drift-world"]],
    [["--budget", "3"]],
  ])("rejects %j", (argv) => {
    expect(() => parseCompareArgs(argv)).toThrow(CompareArgumentsError);
  });
});
