import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FunctionCallingConfigMode } from "@google/genai";
import { DISCOVERY_TOOL_DECLARATIONS } from "../src/agents/discovery-tool-declarations.js";
import { DiscoverArgumentsError, parseDiscoverArgs } from "../src/cli/discover.js";
import { loadProjectEnv } from "../src/llm/env.js";
import {
  createGeminiProvider,
  createGeminiProviderFromEnv,
  mapSdkResponse,
  type GeminiGenerateClient,
  type GeminiGenerateRequest,
  type GeminiGenerateResponse,
} from "../src/llm/gemini-provider.js";
import {
  ProviderConfigError,
  ProviderRequestError,
  ProviderTimeoutError,
  PROVIDER_ERROR_MESSAGES,
  type LlmCompletionRequest,
} from "../src/llm/provider.js";

const API_KEY = "test-key-not-a-real-credential";
const MODEL = "gemini-test-model";

function completionRequest(overrides: Partial<LlmCompletionRequest> = {}): LlmCompletionRequest {
  return {
    systemInstruction: `Investigate the public world. ${API_KEY}`,
    messages: [{ role: "user", text: "Begin." }],
    tools: DISCOVERY_TOOL_DECLARATIONS,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("Gemini provider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends only the declared function tools and never the API key", async () => {
    globalThis.fetch = () => {
      throw new Error("network disabled");
    };
    const seen: GeminiGenerateRequest[] = [];
    const client: GeminiGenerateClient = {
      async generateContent(request) {
        seen.push(request);
        return {
          functionCalls: [{ id: "1", name: "run_experiment", args: { a: 1, b: 2, c: 3 } }],
          modelParts: [
            {
              thoughtSignature: "signature-1",
              functionCall: { id: "1", name: "run_experiment", args: { a: 1, b: 2, c: 3 } },
            },
          ],
        };
      },
    };
    let constructorKey = "";
    const provider = createGeminiProvider({
      apiKey: API_KEY,
      model: MODEL,
      createClient(apiKey) {
        constructorKey = apiKey;
        return client;
      },
    });

    const first = await provider.complete(completionRequest());
    expect(constructorKey).toBe(API_KEY);
    expect(first).toMatchObject({
      kind: "tool_calls",
      calls: [{ id: "1", name: "run_experiment", arguments: { a: 1, b: 2, c: 3 } }],
    });

    await provider.complete(
      completionRequest({
        messages: [
          { role: "user", text: "Begin." },
          {
            role: "model",
            toolCalls: [{ id: "1", name: "run_experiment", arguments: { a: 1, b: 2, c: 3 } }],
            echo: first.kind === "tool_calls" ? first.echo : undefined,
          },
          {
            role: "tool",
            results: [{ callId: "1", name: "run_experiment", output: { ok: true, observation: { step: 1 } } }],
          },
        ],
      }),
    );

    expect(seen).toHaveLength(2);
    const config = seen[0]!.config;
    expect(config.automaticFunctionCalling).toEqual({ disable: true });
    expect(config.toolConfig?.functionCallingConfig?.mode).toBe(FunctionCallingConfigMode.ANY);
    expect(config.toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual([
      "run_experiment",
      "evaluate_measurement",
      "submit_theory",
    ]);
    const declarations = seen[0]!.config.tools?.[0];
    expect(declarations && "functionDeclarations" in declarations ? declarations.functionDeclarations : []).toHaveLength(3);
    expect(JSON.stringify(seen)).not.toContain(API_KEY);
    expect(JSON.stringify(seen[0]!.config)).not.toContain("codeExecution");
    expect(JSON.stringify(seen[1]!.contents)).toContain("signature-1");
    expect(seen[0]!.model).toBe(MODEL);
  });

  it("turns unusable provider payloads into a malformed result and drops generated code", async () => {
    const responses: GeminiGenerateResponse[] = [
      { functionCalls: [{ id: "1", args: { a: 1 } }] },
      { functionCalls: [{ name: "run_experiment", args: ["not-an-object"] as unknown as Record<string, unknown> }] },
      { refusedExecutableCode: true, text: "console.log('do not run')" },
      {},
      { text: `hello ${API_KEY}` },
    ];
    const client: GeminiGenerateClient = {
      async generateContent() {
        const next = responses.shift();
        if (next === undefined) {
          throw new Error("missing fake response");
        }
        return next;
      },
    };
    const provider = createGeminiProvider({ apiKey: API_KEY, model: MODEL, client });

    await expect(provider.complete(completionRequest())).resolves.toEqual({ kind: "malformed" });
    await expect(provider.complete(completionRequest())).resolves.toEqual({ kind: "malformed" });
    const refused = await provider.complete(completionRequest());
    expect(refused).toEqual({ kind: "malformed" });
    expect(JSON.stringify(refused)).not.toContain("console.log");
    await expect(provider.complete(completionRequest())).resolves.toEqual({ kind: "malformed" });
    await expect(provider.complete(completionRequest())).resolves.toEqual({
      kind: "text",
      text: "hello [REDACTED]",
      echo: undefined,
    });
  });

  it("replaces provider exceptions with a fixed message that cannot contain the key", async () => {
    const client: GeminiGenerateClient = {
      async generateContent() {
        throw new Error(`request failed for ${API_KEY}`);
      },
    };
    const provider = createGeminiProvider({ apiKey: API_KEY, model: MODEL, client });
    await expect(provider.complete(completionRequest())).rejects.toBeInstanceOf(ProviderRequestError);
    await expect(provider.complete(completionRequest())).rejects.toThrow(PROVIDER_ERROR_MESSAGES.PROVIDER_FAILURE);
    try {
      await provider.complete(completionRequest());
    } catch (error) {
      expect(String(error)).not.toContain(API_KEY);
      expect(error instanceof ProviderRequestError ? error.stack : "").not.toContain(API_KEY);
    }
  });

  it("reports an aborted request as a timeout", async () => {
    const client: GeminiGenerateClient = {
      async generateContent() {
        const error = new Error(`aborted ${API_KEY}`);
        error.name = "AbortError";
        throw error;
      },
    };
    const provider = createGeminiProvider({ apiKey: API_KEY, model: MODEL, client });
    await expect(provider.complete(completionRequest())).rejects.toBeInstanceOf(ProviderTimeoutError);
    await expect(provider.complete(completionRequest())).rejects.toThrow(PROVIDER_ERROR_MESSAGES.TIMEOUT);
  });

  it("refuses to construct a client when configuration is missing", () => {
    let created = false;
    expect(() =>
      createGeminiProvider({
        apiKey: "",
        model: MODEL,
        createClient() {
          created = true;
          throw new Error("should not construct");
        },
      }),
    ).toThrow(ProviderConfigError);
    expect(created).toBe(false);
    expect(() => createGeminiProviderFromEnv({ GEMINI_API_KEY: API_KEY, GEMINI_MODEL: "  " })).toThrow(
      PROVIDER_ERROR_MESSAGES.MISSING_CONFIGURATION,
    );
    try {
      createGeminiProviderFromEnv({ GEMINI_API_KEY: API_KEY });
    } catch (error) {
      expect(String(error)).not.toContain(API_KEY);
    }
  });

  it("drops generated code when mapping an SDK response", () => {
    const mapped = mapSdkResponse({
      candidates: [
        {
          content: {
            parts: [
              {
                executableCode: { code: "process.exit(1)" },
                codeExecutionResult: { output: "should-not-leak" },
              },
            ],
          },
        },
      ],
    });
    expect(mapped.refusedExecutableCode).toBe(true);
    expect(JSON.stringify(mapped)).not.toContain("process.exit");
    expect(JSON.stringify(mapped)).not.toContain("should-not-leak");

    const withCall = mapSdkResponse({
      functionCalls: [
        { id: "same", name: "run_experiment", args: { a: 1, b: 1, c: 1 } },
        { id: "same", name: "evaluate_measurement", args: { expression: { const: 1 } } },
      ],
      candidates: [
        {
          content: {
            parts: [
              {
                thoughtSignature: "sig",
                functionCall: { id: "same", name: "run_experiment", args: { a: 1, b: 1, c: 1 } },
                executableCode: { code: "process.exit(1)" },
              },
            ],
          },
        },
      ],
    });
    expect(withCall.refusedExecutableCode).toBeUndefined();
    expect(JSON.stringify(withCall)).not.toContain("process.exit");
    expect(withCall.modelParts?.[0]?.thoughtSignature).toBe("sig");
  });

  it("can construct the official client without making a request", () => {
    globalThis.fetch = () => {
      throw new Error("network disabled");
    };
    const provider = createGeminiProvider({ apiKey: API_KEY, model: MODEL });
    expect(provider.name).toBe("gemini");
  });
});

describe("Gemini environment file", () => {
  it("loads only the two Gemini variables and does not override existing values", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "xeno-env-"));
    const file = path.join(directory, ".env");
    writeFileSync(
      file,
      [
        "# comment",
        "OTHER_SECRET=do-not-load-this",
        "export GEMINI_API_KEY=\"quoted-key-value\"",
        "GEMINI_MODEL=gemini-from-file",
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = { GEMINI_MODEL: "already-set" };
    loadProjectEnv(file, env);
    expect(env.GEMINI_API_KEY).toBe("quoted-key-value");
    expect(env.GEMINI_MODEL).toBe("already-set");
    expect(env.OTHER_SECRET).toBeUndefined();
    expect(() => loadProjectEnv(path.join(directory, "missing.env"), env)).not.toThrow();
  });

  it("keeps .env out of Git and publishes only empty placeholders", () => {
    const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toContain("!.env.example");
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    expect(example).toContain("GEMINI_API_KEY=");
    expect(example).toContain("GEMINI_MODEL=");
    expect(example).not.toMatch(/AIza/);
    expect(example).not.toContain("quoted-key-value");
  });
});

describe("discover command arguments", () => {
  it("uses documented defaults and rejects malformed flags without echoing them", () => {
    expect(parseDiscoverArgs([])).toEqual({
      budget: 30,
      maxModelTurns: 16,
      timeoutMs: 60_000,
      maxRetries: 2,
      inRangeSeed: 1,
      outOfRangeSeed: 2,
      caseCount: 200,
    });
    expect(parseDiscoverArgs(["--budget", "4", "--retries", "0", "--case-count", "20"])).toMatchObject({
      budget: 4,
      maxRetries: 0,
      caseCount: 20,
    });
    expect(() => parseDiscoverArgs(["--budget"])).toThrow(DiscoverArgumentsError);
    expect(() => parseDiscoverArgs(["--case-count", "3"])).toThrow(DiscoverArgumentsError);
    expect(() => parseDiscoverArgs(["--nope", "1"])).toThrow(DiscoverArgumentsError);
    try {
      parseDiscoverArgs(["--budget", API_KEY]);
    } catch (error) {
      expect(error).toBeInstanceOf(DiscoverArgumentsError);
      expect(String(error)).not.toContain(API_KEY);
    }
  });
});
