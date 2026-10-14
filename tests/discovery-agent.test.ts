import { readFileSync } from "node:fs";
import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_RETRY_BASE_MS,
  PROVIDER_RETRY_MAX_MS,
  providerRetryDelayMs,
  runDiscoveryAgent,
} from "../src/agents/discovery-agent.js";
import { buildDiscoveryPrompt } from "../src/agents/discovery-prompt.js";
import {
  DISCOVERY_TOOL_DECLARATIONS,
  EVALUATE_MEASUREMENT_TOOL,
  RUN_EXPERIMENT_TOOL,
  SUBMIT_THEORY_TOOL,
} from "../src/agents/discovery-tool-declarations.js";
import { DISCOVERY_TOOL_ERROR } from "../src/agents/discovery-tools.js";
import { LANGUAGE_ERROR_MESSAGES } from "../src/language/errors.js";
import { THEORY_ERROR } from "../src/language/theory.js";
import { createGeminiProvider, type GeminiGenerateResponse } from "../src/llm/gemini-provider.js";
import { ProviderRequestError, PROVIDER_ERROR_MESSAGES } from "../src/llm/provider.js";
import { createExperimentTools } from "../src/tools/experiment-tools.js";
import { ExperimentResultSchema } from "../src/tools/schemas.js";
import { calls, createScriptedProvider } from "./helpers/scripted-provider.js";

const AGENT_CONTEXT_SOURCES = [
  "../src/agents/discovery-prompt.ts",
  "../src/agents/discovery-tool-declarations.ts",
  "../src/agents/discovery-tools.ts",
  "../src/agents/discovery-agent.ts",
  "../src/llm/provider.ts",
  "../src/llm/gemini-provider.ts",
  "../src/llm/env.ts",
];

const FAST = { timeoutMs: 1_000, maxRetries: 0 };

function difference() {
  return { op: "sub", left: { var: "a" }, right: { var: "b" } };
}

describe("Discovery agent context", () => {
  it.each(AGENT_CONTEXT_SOURCES)("%s does not import the world, the evaluator, or an executor", (path) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[2]);
    if (path.endsWith("/provider.ts")) {
      expect(imports).toEqual([]);
    } else {
      expect(imports.length).toBeGreaterThan(0);
    }
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/worlds|evaluator/);
    }
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
    expect(source).not.toMatch(/\beval\s*\(|\bnew\s+Function\b|node:vm|codeExecution\s*:/);
    expect(source).not.toMatch(/HIDDEN_THRESHOLD|computeGlowOutcome|PROJECT_PLAN|ARCHITECTURE/);
  });

  it("declares exactly the three investigation tools", () => {
    expect(DISCOVERY_TOOL_DECLARATIONS.map((tool) => tool.name)).toEqual([
      RUN_EXPERIMENT_TOOL,
      EVALUATE_MEASUREMENT_TOOL,
      SUBMIT_THEORY_TOOL,
    ]);
  });
});

describe("Discovery agent loop", () => {
  it("runs experiments and measurements in order, including several calls in one turn", async () => {
    const tools = createExperimentTools({ budget: 5 });
    const script = createScriptedProvider([
      {
        result: {
          kind: "tool_calls",
          echo: { marker: "provider-echo-not-for-the-transcript" },
          calls: [
            { id: "exp", name: RUN_EXPERIMENT_TOOL, arguments: { a: 8, b: 2, c: 1 } },
            { id: "measure", name: EVALUATE_MEASUREMENT_TOOL, arguments: { expression: difference() } },
          ],
        },
      },
      calls(RUN_EXPERIMENT_TOOL, { a: 4, b: 7, c: 0 }, "exp-2"),
      calls(EVALUATE_MEASUREMENT_TOOL, { expression: { var: "a" } }, "measure-2"),
    ]);

    const result = await runDiscoveryAgent({
      provider: script.provider,
      tools,
      maxModelTurns: 3,
      ...FAST,
    });

    expect(result.status).toBe("turn_limit");
    expect(script.callCount).toBe(3);
    expect(tools.getObservationLog()).toHaveLength(2);
    expect(tools.getRemainingBudget()).toBe(3);

    const firstResults = result.transcript.filter((entry) => entry.type === "tool_result");
    expect(firstResults[0]).toMatchObject({ callId: "exp", name: RUN_EXPERIMENT_TOOL });
    expect(firstResults[1]).toMatchObject({
      callId: "measure",
      output: {
        ok: true,
        rows: [{ step: 1, inputs: { a: 8, b: 2, c: 1 }, value: 6 }],
      },
    });
    const measurement = firstResults[1];
    if (measurement?.type !== "tool_result") {
      throw new Error("expected a measurement result");
    }
    const row = (measurement.output.rows as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(row).sort()).toEqual(["inputs", "outcome", "step", "value"]);
    expect(Object.keys(row.inputs as object).sort()).toEqual(["a", "b", "c"]);
    expect(Object.keys(row.outcome as object)).toEqual(["glows"]);
    expect(row.outcome).toEqual(tools.getObservationLog()[0]?.outcome);

    const secondMeasurement = result.transcript.filter((entry) => entry.type === "tool_result").at(-1);
    expect(secondMeasurement).toMatchObject({
      output: { ok: true, rows: [{ step: 1, value: 8 }, { step: 2, value: 4 }] },
    });
    expect(JSON.stringify(result.transcript)).not.toContain("provider-echo-not-for-the-transcript");
    expect(JSON.stringify(script.requests[1])).toContain("provider-echo-not-for-the-transcript");
    expect(script.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      RUN_EXPERIMENT_TOOL,
      EVALUATE_MEASUREMENT_TOOL,
      SUBMIT_THEORY_TOOL,
    ]);
    expect(script.requests[0]?.systemInstruction).toBe(buildDiscoveryPrompt(tools.describeWorld()).systemInstruction);
  });

  it("reports invalid tool arguments without spending budget and continues", async () => {
    const tools = createExperimentTools({ budget: 2 });
    const script = createScriptedProvider([
      calls(RUN_EXPERIMENT_TOOL, { a: 11, b: 0, c: 0 }, "high"),
      calls(RUN_EXPERIMENT_TOOL, { a: 1, b: 2 }, "missing"),
      calls(RUN_EXPERIMENT_TOOL, { a: 1, b: 2, c: 3, extra: true }, "extra"),
      calls("read_source", {}, "unknown"),
      calls(EVALUATE_MEASUREMENT_TOOL, { expression: "process.exit(1)" }, "javascript"),
      calls(EVALUATE_MEASUREMENT_TOOL, { expression: { fn: "eval", args: [{ const: 1 }] } }, "eval-fn"),
      calls(RUN_EXPERIMENT_TOOL, "(() => { throw new Error('executed'); })()", "raw-javascript"),
      calls(RUN_EXPERIMENT_TOOL, { a: 1, b: 1, c: 1 }, "valid"),
    ]);

    const result = await runDiscoveryAgent({
      provider: script.provider,
      tools,
      maxModelTurns: 8,
      ...FAST,
    });

    expect(result.status).toBe("turn_limit");
    expect(tools.getObservationLog()).toHaveLength(1);
    expect(tools.getRemainingBudget()).toBe(1);
    const outputs = result.transcript
      .filter((entry) => entry.type === "tool_result")
      .map((entry) => (entry.type === "tool_result" ? entry.output : undefined));
    expect(outputs[0]).toEqual({ ok: false, error: { code: "INVALID_INPUT", message: "Experiment inputs are invalid." } });
    expect(outputs[1]).toEqual(outputs[0]);
    expect(outputs[2]).toEqual(outputs[0]);
    expect(outputs[3]).toEqual({
      ok: false,
      error: { code: "UNKNOWN_TOOL", message: DISCOVERY_TOOL_ERROR.UNKNOWN_TOOL },
    });
    expect(outputs[4]).toEqual({
      ok: false,
      error: { code: "INVALID_JSON", message: LANGUAGE_ERROR_MESSAGES.INVALID_JSON },
    });
    expect(outputs[5]).toEqual({
      ok: false,
      error: { code: "UNKNOWN_FUNCTION", message: LANGUAGE_ERROR_MESSAGES.UNKNOWN_FUNCTION },
    });
    expect(outputs[6]).toEqual({
      ok: false,
      error: { code: "INVALID_TOOL_ARGUMENTS", message: DISCOVERY_TOOL_ERROR.INVALID_TOOL_ARGUMENTS },
    });
    expect(ExperimentResultSchema.safeParse(outputs[7]).success).toBe(true);
    expect(script.requests[1]?.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("returns a fixed error for a malformed provider response and then accepts a tool call", async () => {
    const tools = createExperimentTools({ budget: 2 });
    const script = createScriptedProvider([
      { result: { kind: "malformed" } },
      { result: { kind: "text", text: "I will guess without a tool." } },
      { result: { kind: "tool_calls", calls: [] } },
      calls(RUN_EXPERIMENT_TOOL, { a: 0, b: 10, c: 0 }, "after"),
    ]);

    const result = await runDiscoveryAgent({
      provider: script.provider,
      tools,
      maxModelTurns: 4,
      ...FAST,
    });

    expect(result.modelTurns).toBe(4);
    expect(tools.getObservationLog()).toHaveLength(1);
    const notices = result.transcript.filter((entry) => entry.type === "provider_notice");
    expect(notices).toHaveLength(2);
    expect(JSON.stringify(script.requests[1])).toContain("not a usable tool call");
    expect(JSON.stringify(script.requests[2])).toContain("text reply does not investigate");
    expect(result.transcript.some((entry) => entry.type === "model_text" && entry.text.includes("guess"))).toBe(true);
  });

  it("stops when the experiment budget is exhausted and still allows a later theory", async () => {
    const tools = createExperimentTools({ budget: 1 });
    const script = createScriptedProvider([
      calls(RUN_EXPERIMENT_TOOL, { a: 1, b: 2, c: 3 }),
      calls(RUN_EXPERIMENT_TOOL, { a: 0, b: 0, c: 0 }),
    ]);

    const result = await runDiscoveryAgent({
      provider: script.provider,
      tools,
      maxModelTurns: 2,
      ...FAST,
    });

    expect(tools.getObservationLog()).toHaveLength(1);
    expect(tools.getRemainingBudget()).toBe(0);
    const second = result.transcript.filter((entry) => entry.type === "tool_result")[1];
    expect(second).toMatchObject({
      output: { ok: false, error: { code: "BUDGET_EXHAUSTED", message: "No experiments remain in the budget." } },
    });
  });

  it("stops at the model-turn limit without calling the provider again", async () => {
    const tools = createExperimentTools({ budget: 10 });
    const script = createScriptedProvider([
      calls(RUN_EXPERIMENT_TOOL, { a: 1, b: 1, c: 1 }, "1"),
      calls(RUN_EXPERIMENT_TOOL, { a: 2, b: 2, c: 2 }, "2"),
      calls(RUN_EXPERIMENT_TOOL, { a: 3, b: 3, c: 3 }, "3"),
    ]);

    const result = await runDiscoveryAgent({
      provider: script.provider,
      tools,
      maxModelTurns: 2,
      ...FAST,
    });

    expect(result.status).toBe("turn_limit");
    expect(result.modelTurns).toBe(2);
    expect(result.submittedTheory).toBeNull();
    expect(script.callCount).toBe(2);
    expect(tools.getObservationLog()).toHaveLength(2);
  });

  it("times out a hanging provider, aborts the request, and retries only up to the limit", async () => {
    const tools = createExperimentTools({ budget: 2 });
    let aborts = 0;
    const provider = {
      name: "hang",
      complete(request: { signal: AbortSignal }) {
        aborts += request.signal.aborted ? 1 : 0;
        request.signal.addEventListener("abort", () => {
          aborts += 1;
        });
        return new Promise<never>(() => undefined);
      },
    };

    const result = await runDiscoveryAgent({
      provider,
      tools,
      maxModelTurns: 4,
      timeoutMs: 30,
      maxRetries: 1,
      sleep: async () => undefined,
    });

    expect(result.status).toBe("timeout");
    expect(result.modelTurns).toBe(0);
    expect(result.submittedTheory).toBeNull();
    expect(tools.getObservationLog()).toHaveLength(0);
    expect(aborts).toBe(2);
    const notices = result.transcript.filter((entry) => entry.type === "provider_notice");
    expect(notices.map((entry) => (entry.type === "provider_notice" ? entry.retried : undefined))).toEqual([
      true,
      false,
    ]);
    expect(JSON.stringify(result.transcript)).toContain(PROVIDER_ERROR_MESSAGES.TIMEOUT);
  });

  it("retries a provider failure a bounded number of times and scrubs the thrown message", async () => {
    const secret = "super-secret-provider-key";
    const tools = createExperimentTools({ budget: 2 });
    const exhausted = createScriptedProvider([
      { error: new Error(`connect failed ${secret}`) },
      { error: new Error(`connect failed ${secret}`) },
    ]);

    const failed = await runDiscoveryAgent({
      provider: exhausted.provider,
      tools,
      maxModelTurns: 3,
      timeoutMs: 1_000,
      maxRetries: 1,
      secrets: [secret],
      sleep: async () => undefined,
    });

    expect(failed.status).toBe("provider_failure");
    expect(exhausted.callCount).toBe(2);
    expect(failed.submittedTheory).toBeNull();
    expect(JSON.stringify(failed.transcript)).not.toContain(secret);
    expect(JSON.stringify(failed.transcript)).toContain(PROVIDER_ERROR_MESSAGES.PROVIDER_FAILURE);

    const recovered = createScriptedProvider([
      { error: new ProviderRequestError() },
      { error: new Error(secret) },
      calls(RUN_EXPERIMENT_TOOL, { a: 1, b: 0, c: 0 }, "recovered"),
    ]);
    const success = await runDiscoveryAgent({
      provider: recovered.provider,
      tools: createExperimentTools({ budget: 2 }),
      maxModelTurns: 1,
      timeoutMs: 1_000,
      maxRetries: 2,
      secrets: [secret],
      sleep: async () => undefined,
    });
    expect(success.status).toBe("turn_limit");
    expect(recovered.callCount).toBe(3);
    expect(success.transcript.some((entry) => entry.type === "tool_result")).toBe(true);
    expect(JSON.stringify(success.transcript)).not.toContain(secret);
  });

  it("rejects an invalid theory, then stops on a valid one and does not run later calls", async () => {
    const tools = createExperimentTools({ budget: 3 });
    const script = createScriptedProvider([
      calls(SUBMIT_THEORY_TOOL, { measurement: { var: "nope" }, operator: "lt", threshold: 0 }, "bad"),
      {
        result: {
          kind: "tool_calls",
          calls: [
            {
              id: "good",
              name: SUBMIT_THEORY_TOOL,
              arguments: { measurement: difference(), operator: "gt", threshold: 1 },
            },
            { id: "late", name: RUN_EXPERIMENT_TOOL, arguments: { a: 9, b: 1, c: 1 } },
          ],
        },
      },
      calls(RUN_EXPERIMENT_TOOL, { a: 0, b: 0, c: 0 }, "should-not-run"),
    ]);

    const result = await runDiscoveryAgent({
      provider: script.provider,
      tools,
      maxModelTurns: 5,
      ...FAST,
    });

    expect(result.status).toBe("theory_submitted");
    expect(script.callCount).toBe(2);
    expect(tools.getObservationLog()).toHaveLength(0);
    expect(tools.getRemainingBudget()).toBe(3);
    expect(result.submittedTheory?.operator).toBe("gt");
    expect(result.submittedTheory?.threshold).toBe(1);
    const outputs = result.transcript.filter((entry) => entry.type === "tool_result");
    expect(outputs[0]).toMatchObject({
      output: { ok: false, error: { code: THEORY_ERROR.code, message: THEORY_ERROR.message } },
    });
    expect(outputs[1]).toMatchObject({ output: { ok: true, accepted: true } });
    expect(outputs[2]).toMatchObject({
      output: { ok: false, error: { code: "NOT_EXECUTED", message: DISCOVERY_TOOL_ERROR.NOT_EXECUTED } },
    });
    expect(result.transcript.some((entry) => entry.type === "submitted_theory")).toBe(true);
    expect(JSON.stringify(outputs[1])).not.toContain("accuracy");
  });

  it("calculates a measurement only on collected observations, including a per-row arithmetic error", async () => {
    const tools = createExperimentTools({ budget: 2 });
    const script = createScriptedProvider([
      calls(EVALUATE_MEASUREMENT_TOOL, { expression: { var: "a" } }, "empty"),
      calls(RUN_EXPERIMENT_TOOL, { a: 4, b: 1, c: 2 }, "exp"),
      calls(
        EVALUATE_MEASUREMENT_TOOL,
        { expression: { op: "div", left: { var: "a" }, right: { const: 0 } } },
        "divide",
      ),
    ]);

    const result = await runDiscoveryAgent({
      provider: script.provider,
      tools,
      maxModelTurns: 3,
      ...FAST,
    });

    const outputs = result.transcript.filter((entry) => entry.type === "tool_result");
    expect(outputs[0]).toMatchObject({ output: { ok: true, rows: [] } });
    expect(outputs[2]).toMatchObject({
      output: {
        ok: true,
        rows: [
          {
            step: 1,
            error: { code: "DIVISION_BY_ZERO", message: LANGUAGE_ERROR_MESSAGES.DIVISION_BY_ZERO },
          },
        ],
      },
    });
    expect(tools.getObservationLog()).toHaveLength(1);
    const logged = tools.getObservationLog()[0]!;
    logged.inputs.a = 999;
    expect(tools.getObservationLog()[0]?.inputs.a).toBe(4);
  });

  it("redacts a known secret from model text before it is stored or sent back", async () => {
    const secret = "token-secret-value";
    const tools = createExperimentTools({ budget: 1 });
    const script = createScriptedProvider([
      { result: { kind: "text", text: `the key is ${secret}` } },
      calls(RUN_EXPERIMENT_TOOL, { a: 1, b: 1, c: 1 }, "done"),
    ]);

    const result = await runDiscoveryAgent({
      provider: script.provider,
      tools,
      maxModelTurns: 2,
      ...FAST,
      secrets: [secret],
    });

    expect(JSON.stringify(result.transcript)).not.toContain(secret);
    expect(JSON.stringify(result.transcript)).toContain("[REDACTED]");
    expect(JSON.stringify(script.requests[1])).not.toContain(secret);
  });

  it("rejects invalid loop limits before calling the provider", async () => {
    const script = createScriptedProvider([]);
    const tools = createExperimentTools({ budget: 1 });
    await expect(
      runDiscoveryAgent({ provider: script.provider, tools, maxModelTurns: 0, ...FAST }),
    ).rejects.toThrow(/Model turn limit/);
    await expect(
      runDiscoveryAgent({ provider: script.provider, tools, timeoutMs: 0, maxRetries: 0 }),
    ).rejects.toThrow(/Provider timeout/);
    await expect(
      runDiscoveryAgent({ provider: script.provider, tools, maxRetries: -1, timeoutMs: 10 }),
    ).rejects.toThrow(/Provider retries/);
    expect(script.callCount).toBe(0);
  });

  it("backs off with a bounded delay before retrying a transient provider failure", () => {
    expect(providerRetryDelayMs(0, 0)).toBe(PROVIDER_RETRY_BASE_MS / 2);
    expect(providerRetryDelayMs(0, 1)).toBe(PROVIDER_RETRY_BASE_MS);
    expect(providerRetryDelayMs(1, 1)).toBe(PROVIDER_RETRY_BASE_MS * 2);
    expect(providerRetryDelayMs(2, 1)).toBe(PROVIDER_RETRY_BASE_MS * 4);
    expect(providerRetryDelayMs(30, 1)).toBe(PROVIDER_RETRY_MAX_MS);
    expect(providerRetryDelayMs(0, Number.NaN)).toBe(PROVIDER_RETRY_BASE_MS / 2);
    expect(providerRetryDelayMs(0, 0)).toBeGreaterThan(0);
  });

  it("does not retry a permanent HTTP 400 and keeps the diagnostic out of the model context", async () => {
    const secret = "AIzaSyPermanentFailureKey";
    const seen: string[] = [];
    let calls = 0;
    const provider = createGeminiProvider({
      apiKey: "test-key-not-a-real-credential",
      model: "gemini-test-model",
      client: {
        async generateContent(request) {
          calls += 1;
          seen.push(JSON.stringify(request));
          throw new ApiError({
            status: 400,
            message: `invalid tool request ${secret}`,
          });
        },
      },
    });
    const delays: number[] = [];
    const result = await runDiscoveryAgent({
      provider,
      tools: createExperimentTools({ budget: 2 }),
      maxModelTurns: 4,
      timeoutMs: 1_000,
      maxRetries: 3,
      secrets: [secret],
      random: () => 1,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(result.status).toBe("provider_failure");
    expect(result.providerDiagnostic).toEqual({ category: "bad_request", httpStatus: 400 });
    expect(result.modelTurns).toBe(0);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(JSON.stringify(result.transcript)).toContain(PROVIDER_ERROR_MESSAGES.PROVIDER_FAILURE);
    expect(JSON.stringify({ transcript: result.transcript, requests: seen })).not.toContain(secret);
    expect(JSON.stringify({ transcript: result.transcript, requests: seen })).not.toContain("bad_request");
  });

  it("retries HTTP 429 and 503 with backoff, and retries a network failure", async () => {
    const secret = "AIzaSyTransientFailureKey";
    const rateLimited = scriptedStatuses([429, 429], secret);
    const rateDelays: number[] = [];
    const rateResult = await runDiscoveryAgent({
      provider: rateLimited.provider,
      tools: createExperimentTools({ budget: 2 }),
      maxModelTurns: 1,
      timeoutMs: 1_000,
      maxRetries: 2,
      secrets: [secret],
      random: () => 0,
      sleep: async (milliseconds) => {
        rateDelays.push(milliseconds);
      },
    });
    expect(rateResult.status).toBe("turn_limit");
    expect(rateResult.providerDiagnostic).toBeNull();
    expect(rateLimited.calls).toBe(3);
    expect(rateDelays).toEqual([providerRetryDelayMs(0, 0), providerRetryDelayMs(1, 0)]);
    expect(JSON.stringify(rateLimited.seen)).not.toContain(secret);
    expect(JSON.stringify(rateLimited.seen)).not.toContain("rate_limit");

    const unavailable = scriptedStatuses([503, 503, 503], secret);
    const unavailableDelays: number[] = [];
    const unavailableResult = await runDiscoveryAgent({
      provider: unavailable.provider,
      tools: createExperimentTools({ budget: 2 }),
      maxModelTurns: 2,
      timeoutMs: 1_000,
      maxRetries: 2,
      secrets: [secret],
      random: () => 1,
      sleep: async (milliseconds) => {
        unavailableDelays.push(milliseconds);
      },
    });
    expect(unavailableResult.status).toBe("provider_failure");
    expect(unavailableResult.providerDiagnostic).toEqual({ category: "server_error", httpStatus: 503 });
    expect(unavailable.calls).toBe(3);
    expect(unavailableDelays).toEqual([
      providerRetryDelayMs(0, 1),
      providerRetryDelayMs(1, 1),
    ]);
    expect(JSON.stringify(unavailableResult.transcript)).not.toContain(secret);
    expect(JSON.stringify(unavailable.seen)).not.toContain("server_error");

    const network = scriptedNetwork(secret);
    const networkDelays: number[] = [];
    const networkResult = await runDiscoveryAgent({
      provider: network.provider,
      tools: createExperimentTools({ budget: 1 }),
      maxModelTurns: 1,
      timeoutMs: 1_000,
      maxRetries: 1,
      secrets: [secret],
      random: () => 1,
      sleep: async (milliseconds) => {
        networkDelays.push(milliseconds);
      },
    });
    expect(networkResult.status).toBe("provider_failure");
    expect(networkResult.providerDiagnostic).toEqual({ category: "network", httpStatus: null });
    expect(network.calls).toBe(2);
    expect(networkDelays).toEqual([providerRetryDelayMs(0, 1)]);
    expect(JSON.stringify(networkResult.transcript)).not.toContain(secret);
    expect(JSON.stringify(network.seen)).not.toContain(secret);
  });

  it("retries a provider timeout with backoff and still aborts each attempt", async () => {
    const secret = "AIzaSyTimeoutFailureKey";
    let calls = 0;
    let aborts = 0;
    const provider = createGeminiProvider({
      apiKey: "test-key-not-a-real-credential",
      model: "gemini-test-model",
      client: {
        generateContent(request) {
          calls += 1;
          return new Promise<GeminiGenerateResponse>((_resolve, reject) => {
            if (request.config.abortSignal?.aborted) {
              aborts += 1;
              const error = new Error(`aborted ${secret}`);
              error.name = "AbortError";
              reject(error);
              return;
            }
            request.config.abortSignal?.addEventListener("abort", () => {
              aborts += 1;
              const error = new Error(`aborted ${secret}`);
              error.name = "AbortError";
              reject(error);
            });
          });
        },
      },
    });
    const delays: number[] = [];
    const result = await runDiscoveryAgent({
      provider,
      tools: createExperimentTools({ budget: 1 }),
      maxModelTurns: 2,
      timeoutMs: 20,
      maxRetries: 1,
      secrets: [secret],
      random: () => 1,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(result.status).toBe("timeout");
    expect(result.providerDiagnostic).toEqual({ category: "timeout", httpStatus: null });
    expect(result.modelTurns).toBe(0);
    expect(calls).toBe(2);
    expect(aborts).toBe(2);
    expect(delays).toEqual([providerRetryDelayMs(0, 1)]);
    expect(JSON.stringify(result.transcript)).toContain(PROVIDER_ERROR_MESSAGES.TIMEOUT);
    expect(JSON.stringify(result.transcript)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

function scriptedStatuses(statuses: readonly number[], secret: string) {
  const seen: string[] = [];
  let calls = 0;
  const provider = createGeminiProvider({
    apiKey: "test-key-not-a-real-credential",
    model: "gemini-test-model",
    client: {
      async generateContent(request) {
        const status = statuses[calls];
        calls += 1;
        seen.push(JSON.stringify(request));
        if (status !== undefined) {
          throw new ApiError({ status, message: `provider body ${secret}` });
        }
        return {
          functionCalls: [{ id: "after-retry", name: RUN_EXPERIMENT_TOOL, args: { a: 1, b: 1, c: 1 } }],
        };
      },
    },
  });
  return {
    provider,
    seen,
    get calls() {
      return calls;
    },
  };
}

function scriptedNetwork(secret: string) {
  const seen: string[] = [];
  let calls = 0;
  const provider = createGeminiProvider({
    apiKey: "test-key-not-a-real-credential",
    model: "gemini-test-model",
    client: {
      async generateContent(request) {
        calls += 1;
        seen.push(JSON.stringify(request));
        const error = new TypeError(`fetch failed: ${secret}`);
        (error as { cause?: unknown }).cause = { code: "ENOTFOUND", message: secret };
        throw error;
      },
    },
  });
  return {
    provider,
    seen,
    get calls() {
      return calls;
    },
  };
}
