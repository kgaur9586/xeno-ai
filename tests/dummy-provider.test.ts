import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDiscoveryPrompt } from "../src/agents/discovery-prompt.js";
import { planGrid } from "../src/agents/systematic-explorer.js";
import {
  DISCOVERY_TOOL_DECLARATIONS,
  RUN_EXPERIMENT_TOOL,
  SUBMIT_THEORY_TOOL,
} from "../src/agents/discovery-tool-declarations.js";
import { DUMMY_SESSION_NOTICE, resolveDiscoveryProvider } from "../src/cli/discover.js";
import { validateTheory } from "../src/language/theory.js";
import { createDummyProvider, DUMMY_PROVIDER_NAME } from "../src/llm/dummy-provider.js";
import { ProviderConfigError, type LlmToolCall } from "../src/llm/provider.js";
import { createExperimentTools } from "../src/tools/experiment-tools.js";

describe("Dummy provider", () => {
  it("does not import the world engine or the evaluator and does not call the network", () => {
    const source = readFileSync(new URL("../src/llm/dummy-provider.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[2]);
    expect(imports).toContain("../agents/observation-theorist.js");
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/worlds|evaluator|gemini/);
    }
    expect(source).not.toMatch(/\b5\b/);
    expect(source).not.toMatch(/HIDDEN_THRESHOLD|computeGlowOutcome|coincides|generateContent|fetch\s*\(/);
    expect(source).not.toMatch(/\beval\s*\(|\bnew\s+Function\b/);
  });

  it("spends the budget on the public grid, then submits one catalog theory", async () => {
    const tools = createExperimentTools({ budget: 4 });
    const description = tools.describeWorld();
    const prompt = buildDiscoveryPrompt(description);
    const dummy = createDummyProvider();
    const signal = new AbortController().signal;
    const first = await dummy.complete({
      systemInstruction: prompt.systemInstruction,
      messages: [{ role: "user", text: prompt.userMessage }],
      tools: DISCOVERY_TOOL_DECLARATIONS,
      signal,
    });

    expect(first.kind).toBe("tool_calls");
    if (first.kind !== "tool_calls") {
      return;
    }
    expect(first.calls.map((call) => call.name)).toEqual([
      RUN_EXPERIMENT_TOOL,
      RUN_EXPERIMENT_TOOL,
      RUN_EXPERIMENT_TOOL,
      RUN_EXPERIMENT_TOOL,
    ]);
    expect(first.calls.map((call) => call.id)).toEqual(["dummy-exp-1", "dummy-exp-2", "dummy-exp-3", "dummy-exp-4"]);
    expect(first.calls.map((call) => call.arguments)).toEqual(planGrid(description).slice(0, 4));

    const second = await dummy.complete({
      systemInstruction: prompt.systemInstruction,
      messages: [
        { role: "user", text: prompt.userMessage },
        { role: "model", toolCalls: first.calls },
        { role: "tool", results: first.calls.map((call) => toolResult(call, tools.runExperiment(call.arguments))) },
      ],
      tools: DISCOVERY_TOOL_DECLARATIONS,
      signal,
    });

    expect(second.kind).toBe("tool_calls");
    if (second.kind !== "tool_calls") {
      return;
    }
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.name).toBe(SUBMIT_THEORY_TOOL);
    expect(validateTheory(second.calls[0]?.arguments).ok).toBe(true);
  });

  it("submits a constant theory when the prompt has no public description", async () => {
    const result = await createDummyProvider().complete({
      systemInstruction: "no description",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("tool_calls");
    if (result.kind !== "tool_calls") {
      return;
    }
    expect(result.calls.map((call) => call.name)).toEqual([SUBMIT_THEORY_TOOL]);
    expect(validateTheory(result.calls[0]?.arguments).ok).toBe(true);
  });

  it("rejects an already aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createDummyProvider().complete({
        systemInstruction: "no description",
        messages: [],
        tools: [],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stays on the dummy provider unless a live run is requested", () => {
    const key = "AIzaDummySelectionKey";
    const dummy = resolveDiscoveryProvider({ GEMINI_API_KEY: key, GEMINI_MODEL: "test-model" }, false);
    expect(dummy.liveModel).toBe(false);
    expect(dummy.label).toBe(DUMMY_PROVIDER_NAME);
    expect(dummy.provider.name).toBe(DUMMY_PROVIDER_NAME);
    expect(dummy.label).not.toContain(key);
    expect(DUMMY_SESSION_NOTICE).toContain("dummy");
    expect(DUMMY_SESSION_NOTICE).not.toContain(key);
    expect(DUMMY_SESSION_NOTICE).not.toMatch(/HIDDEN_THRESHOLD|computeGlowOutcome/);

    expect(() => resolveDiscoveryProvider({ GEMINI_API_KEY: "", GEMINI_MODEL: "" }, true)).toThrow(ProviderConfigError);
    expect(() => resolveDiscoveryProvider({ GEMINI_API_KEY: key, GEMINI_MODEL: " " }, true)).toThrow(ProviderConfigError);

    const live = resolveDiscoveryProvider({ GEMINI_API_KEY: key, GEMINI_MODEL: "test-model" }, true);
    expect(live.liveModel).toBe(true);
    expect(live.provider.name).toBe("gemini");
    expect(live.label).toBe("gemini:test-model");
    expect(live.label).not.toContain(key);
  });
});

function toolResult(call: LlmToolCall, output: object) {
  return {
    callId: call.id,
    name: call.name,
    output: JSON.parse(JSON.stringify(output)) as Record<string, unknown>,
  };
}
