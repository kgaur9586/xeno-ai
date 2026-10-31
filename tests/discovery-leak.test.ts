import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDiscoveryPrompt } from "../src/agents/discovery-prompt.js";
import { runDiscoverySession } from "../src/agents/discovery-session.js";
import {
  EVALUATE_MEASUREMENT_TOOL,
  RUN_EXPERIMENT_TOOL,
  SUBMIT_THEORY_TOOL,
} from "../src/agents/discovery-tool-declarations.js";
import type { TranscriptEntry } from "../src/agents/discovery-agent.js";
import { createDummyProvider } from "../src/llm/dummy-provider.js";
import type { LlmMessage, LlmProvider } from "../src/llm/provider.js";
import { ERROR_MESSAGES, ExperimentResultSchema } from "../src/tools/schemas.js";
import { createExperimentTools } from "../src/tools/experiment-tools.js";
import { calls, createScriptedProvider } from "./helpers/scripted-provider.js";

const EVALUATION = { inRangeSeed: 424242, outOfRangeSeed: 737373, caseCount: 20 };

const PRIVATE_MARKERS = [
  "HIDDEN_THRESHOLD",
  "computeGlowOutcome",
  "opposite sides",
  "PROJECT_PLAN",
  "ARCHITECTURE",
  "correctPredictions",
  "inRange",
  "outOfRange",
  "evaluationErrors",
];

describe("Discovery leak checks", () => {
  it("keeps the dummy session prompt and transcript free of private rule data", async () => {
    const tools = createExperimentTools({ budget: 4 });
    const description = tools.describeWorld();
    const recorded = recordProvider(createDummyProvider());
    const result = await runDiscoverySession({
      provider: recorded.provider,
      budget: 4,
      maxModelTurns: 4,
      timeoutMs: 1_000,
      maxRetries: 0,
      evaluation: EVALUATION,
    });

    expect(result.status).toBe("theory_submitted");
    expect(result.modelTurns).toBe(2);
    expect(result.experimentCount).toBe(4);
    expect(result.evaluation?.inRange.accuracy).toBe(0.5);
    expect(result.evaluation?.outOfRange.accuracy).toBe(0.5);
    expect(recorded.requests[0]?.systemInstruction).toBe(buildDiscoveryPrompt(description).systemInstruction);

    const embedded = recorded.requests[0]?.systemInstruction.split("Public world description:\n")[1]?.split("\n\n")[0];
    expect(JSON.parse(embedded ?? "null")).toEqual(description);
    expect(Object.keys(description).sort()).toEqual(["attributes", "experimentBudget", "outcome", "worldId"]);

    const shown = JSON.stringify({ transcript: result.transcript, requests: recorded.requests });
    for (const marker of PRIVATE_MARKERS) {
      expect(shown).not.toContain(marker);
    }
    expect(shown).not.toContain("424242");
    expect(shown).not.toContain("737373");
    expect(result.transcript.some((entry) => entry.type === "submitted_theory")).toBe(true);

    const experiments = toolResults(result.transcript, RUN_EXPERIMENT_TOOL);
    expect(experiments).toHaveLength(4);
    expect(experiments[1]?.observation && observationInputs(experiments[1]).c).toBe(5);
    for (const output of experiments) {
      expect(ExperimentResultSchema.safeParse(output).success).toBe(true);
      expect(Object.keys(output).sort()).toEqual(["observation", "ok"]);
      const observation = output.observation as Record<string, unknown>;
      expect(Object.keys(observation).sort()).toEqual(["inputs", "outcome", "remainingBudget", "step"]);
      expect(Object.keys(observation.inputs as object).sort()).toEqual(["a", "b", "c"]);
      expect(Object.keys(observation.outcome as object).sort()).toEqual(["glows"]);
    }

    expect(toolResults(result.transcript, SUBMIT_THEORY_TOOL)).toEqual([{ ok: true, accepted: true }]);
    expect(JSON.stringify(result.transcript)).not.toContain("correctPredictions");
    expect(result.evaluation?.inRange.correctPredictions).toBe(10);
  });

  it("returns fixed fields for an invalid experiment, a measurement, and a theory", async () => {
    const script = createScriptedProvider([
      calls(RUN_EXPERIMENT_TOOL, { a: "no", b: 1, c: 1 }, "bad"),
      calls(RUN_EXPERIMENT_TOOL, { a: 1, b: 2, c: 3 }, "good"),
      calls(EVALUATE_MEASUREMENT_TOOL, { expression: { var: "a" } }, "measure"),
      calls(SUBMIT_THEORY_TOOL, { measurement: { var: "c" }, operator: "gt", threshold: 0 }, "theory"),
    ]);
    const result = await runDiscoverySession({
      provider: script.provider,
      budget: 4,
      maxModelTurns: 4,
      timeoutMs: 1_000,
      maxRetries: 0,
      evaluation: EVALUATION,
    });

    const [invalid, valid] = toolResults(result.transcript, RUN_EXPERIMENT_TOOL);
    expect(invalid).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: ERROR_MESSAGES.INVALID_INPUT },
    });
    expect(ExperimentResultSchema.safeParse(valid).success).toBe(true);
    expect(Object.keys(valid ?? {}).sort()).toEqual(["observation", "ok"]);

    const [measurement] = toolResults(result.transcript, EVALUATE_MEASUREMENT_TOOL);
    expect(Object.keys(measurement ?? {}).sort()).toEqual(["ok", "rows"]);
    const rows = (measurement?.rows ?? []) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["inputs", "outcome", "step", "value"]);

    expect(toolResults(result.transcript, SUBMIT_THEORY_TOOL)).toEqual([{ ok: true, accepted: true }]);
    const shown = JSON.stringify({ transcript: result.transcript, requests: script.requests });
    for (const marker of PRIVATE_MARKERS) {
      expect(shown).not.toContain(marker);
    }
    expect(shown).not.toContain("424242");
  });
});

function recordProvider(inner: LlmProvider) {
  const requests: Array<{ systemInstruction: string; messages: LlmMessage[] }> = [];
  const provider: LlmProvider = {
    name: inner.name,
    complete(request) {
      requests.push(
        structuredClone({
          systemInstruction: request.systemInstruction,
          messages: request.messages,
        }),
      );
      return inner.complete(request);
    },
  };
  return { provider, requests };
}

function toolResults(transcript: readonly TranscriptEntry[], name: string): Array<Record<string, unknown>> {
  return transcript
    .filter((entry) => entry.type === "tool_result" && entry.name === name)
    .map((entry) => (entry.type === "tool_result" ? entry.output : {}));
}

function observationInputs(output: Record<string, unknown>): { a: number; b: number; c: number } {
  const observation = output.observation as { inputs: { a: number; b: number; c: number } };
  return observation.inputs;
}
