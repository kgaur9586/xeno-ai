import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createDiscoveryRun } from "../src/agents/discovery-agent.js";
import { createApiServer } from "../src/api/app.js";
import { MAX_BODY_BYTES } from "../src/api/schemas.js";
import { createSessionManager, type ProviderKind } from "../src/api/session-manager.js";
import { parseServeArgs, ServeArgumentsError } from "../src/cli/serve.js";
import { createDummyProvider } from "../src/llm/dummy-provider.js";
import type { LlmProvider } from "../src/llm/provider.js";
import { createWorldToolsById } from "../src/tools/world-tools.js";

const TOKEN = "operator-token-for-tests-0123456789";
const NOISE_SEED = 987_654_321;
const EVAL_SEEDS = { inRangeSeed: 135_791_113, outOfRangeSeed: 246_802_468, caseCount: 200 };

let closers: Array<() => Promise<void>> = [];
let publicBodies: string[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
  publicBodies = [];
});

async function start(options: {
  operatorToken?: string;
  providers?: Partial<Record<ProviderKind, () => LlmProvider>>;
  maxSessions?: number;
  secrets?: string[];
} = {}) {
  const sessions = createSessionManager({
    providers: options.providers ?? { dummy: createDummyProvider },
    maxSessions: options.maxSessions,
    secrets: options.secrets,
  });
  const server = createApiServer({ sessions, operatorToken: options.operatorToken });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] ??= "application/json";
    }
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    if (!path.startsWith("/evaluator/")) {
      publicBodies.push(text);
    }
    return { status: response.status, headers: response.headers, text, json: text === "" ? null : (JSON.parse(text) as any) };
  }
  const operator = (method: string, path: string, body?: unknown) =>
    call(method, path, body, { authorization: `Bearer ${TOKEN}` });
  return { call, operator };
}

async function finishedSession(api: Awaited<ReturnType<typeof start>>, worldId = "drift-world") {
  const created = await api.call("POST", "/sessions", { worldId, budget: 27, noiseSeed: NOISE_SEED });
  const id = created.json.session.sessionId as string;
  await api.call("POST", `/sessions/${id}/steps`, { turns: 5 });
  return id;
}

function hangingProvider() {
  let release: () => void = () => undefined;
  const provider: LlmProvider = {
    name: "hanging",
    complete: () =>
      new Promise((resolve) => {
        release = () => resolve({ kind: "text", text: "thinking" });
      }),
  };
  return { provider, release: () => release() };
}

describe("Stepwise discovery run", () => {
  it("advances one model turn per step and ignores steps after finishing", async () => {
    const tools = createWorldToolsById("drift-world", { budget: 27 });
    const run = createDiscoveryRun({ provider: createDummyProvider(), tools, maxRetries: 0 });
    expect(run.status()).toBeNull();
    await run.step();
    expect(run.snapshot().modelTurns).toBe(1);
    expect(tools.getObservationLog()).toHaveLength(27);
    expect(run.status()).toBeNull();
    await run.step();
    expect(run.status()).toBe("theory_submitted");
    const before = run.snapshot();
    await run.step();
    expect(run.snapshot()).toEqual(before);
  });
});

describe("Investigation routes", () => {
  it("reports health and lists public world descriptions", async () => {
    const api = await start();
    expect((await api.call("GET", "/health")).json).toEqual({ ok: true });
    const worlds = await api.call("GET", "/worlds");
    expect(worlds.status).toBe(200);
    expect(worlds.json.worlds.map((world: { worldId: string }) => world.worldId)).toEqual([
      "glow-world",
      "ring-world",
      "drift-world",
    ]);
    for (const world of worlds.json.worlds) {
      expect(Object.keys(world).sort()).toEqual(["attributes", "observationNoise", "outcome", "worldId"]);
    }
  });

  it("creates a session with defaults and returns its public view", async () => {
    const api = await start();
    const created = await api.call("POST", "/sessions", { worldId: "ring-world" });
    expect(created.status).toBe(201);
    const session = created.json.session;
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session).toMatchObject({
      worldId: "ring-world",
      provider: "dummy",
      status: "running",
      modelTurns: 0,
      maxModelTurns: 16,
      budget: 30,
      experimentCount: 0,
      remainingBudget: 30,
      submittedTheory: null,
    });
    expect((await api.call("GET", `/sessions/${session.sessionId}`)).json.session).toEqual(session);
    expect((await api.call("GET", "/sessions")).json.sessions).toEqual([session]);
  });

  it("runs steps, returns the new transcript entries, and stops after the theory", async () => {
    const api = await start();
    const id = (await api.call("POST", "/sessions", { worldId: "drift-world", budget: 27 })).json.session.sessionId;

    const first = await api.call("POST", `/sessions/${id}/steps`, {});
    expect(first.status).toBe(200);
    expect(first.json.turnsRun).toBe(1);
    expect(first.json.session).toMatchObject({ status: "running", modelTurns: 1, experimentCount: 27, remainingBudget: 0 });
    expect(first.json.entries[0].type).toBe("tool_calls");
    const transcript = await api.call("GET", `/sessions/${id}/transcript`);
    expect(transcript.json.entries.slice(0, 2).map((entry: { type: string }) => entry.type)).toEqual([
      "system_prompt",
      "user_message",
    ]);

    const second = await api.call("POST", `/sessions/${id}/steps`, { turns: 10 });
    expect(second.json.turnsRun).toBe(1);
    expect(second.json.session.status).toBe("theory_submitted");
    expect(second.json.session.submittedTheory.measurement).toBeDefined();
    expect(second.json.session.submittedTheory.operator).toBeUndefined();
    expect(second.json.entries.at(-1).type).toBe("submitted_theory");

    const third = await api.call("POST", `/sessions/${id}/steps`, {});
    expect(third.status).toBe(409);
    expect(third.json.error.code).toBe("SESSION_FINISHED");
  });

  it("serves the world description, observation log, and transcript pages", async () => {
    const api = await start();
    const id = await finishedSession(api);
    const world = await api.call("GET", `/sessions/${id}/world`);
    expect(world.json.world).toMatchObject({ worldId: "drift-world", experimentBudget: 27, observationNoise: "present" });

    const observations = await api.call("GET", `/sessions/${id}/observations`);
    expect(observations.json.observations).toHaveLength(27);
    expect(Object.keys(observations.json.observations[0]).sort()).toEqual(["inputs", "outcome", "remainingBudget", "step"]);

    const all = await api.call("GET", `/sessions/${id}/transcript`);
    const page = await api.call("GET", `/sessions/${id}/transcript?from=3`);
    expect(page.json.total).toBe(all.json.total);
    expect(page.json.entries).toEqual(all.json.entries.slice(3));
    expect(page.json.nextIndex).toBe(all.json.total);
  });

  it("deletes sessions and enforces the session limit", async () => {
    const api = await start({ maxSessions: 1 });
    const id = (await api.call("POST", "/sessions", { worldId: "glow-world" })).json.session.sessionId;
    const blocked = await api.call("POST", "/sessions", { worldId: "glow-world" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe("SESSION_LIMIT");
    const removed = await api.call("DELETE", `/sessions/${id}`);
    expect(removed.status).toBe(204);
    expect(removed.text).toBe("");
    expect((await api.call("GET", `/sessions/${id}`)).status).toBe(404);
    expect((await api.call("POST", "/sessions", { worldId: "glow-world" })).status).toBe(201);
  });

  it("refuses a second step while one is running", async () => {
    const hanging = hangingProvider();
    const api = await start({ providers: { dummy: () => hanging.provider } });
    const id = (await api.call("POST", "/sessions", { worldId: "glow-world" })).json.session.sessionId;
    const pending = api.call("POST", `/sessions/${id}/steps`, {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await api.call("POST", `/sessions/${id}/steps`, {});
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe("SESSION_BUSY");
    expect((await api.call("DELETE", `/sessions/${id}`)).json.error.code).toBe("SESSION_BUSY");
    hanging.release();
    expect((await pending).status).toBe(200);
  });

  it("offers Gemini only when the server enables it", async () => {
    const api = await start();
    const response = await api.call("POST", "/sessions", { worldId: "glow-world", provider: "gemini" });
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("scrubs configured secrets from transcripts", async () => {
    const secret = "AIza-fake-secret-for-tests";
    const leaky: LlmProvider = { name: "leaky", complete: async () => ({ kind: "text", text: `key ${secret}` }) };
    const api = await start({ providers: { dummy: () => leaky }, secrets: [secret] });
    const id = (await api.call("POST", "/sessions", { worldId: "glow-world", maxModelTurns: 2 })).json.session.sessionId;
    await api.call("POST", `/sessions/${id}/steps`, { turns: 2 });
    const transcript = await api.call("GET", `/sessions/${id}/transcript`);
    expect(transcript.text).toContain("key");
    expect(transcript.text).not.toContain(secret);
  });
});

describe("Request validation", () => {
  it.each([
    ["unknown field", { worldId: "glow-world", extra: 1 }, "INVALID_REQUEST"],
    ["missing world", {}, "INVALID_REQUEST"],
    ["unknown world", { worldId: "nowhere" }, "UNKNOWN_WORLD"],
    ["zero budget", { worldId: "glow-world", budget: 0 }, "INVALID_REQUEST"],
    ["fractional turns", { worldId: "glow-world", maxModelTurns: 1.5 }, "INVALID_REQUEST"],
    ["string seed", { worldId: "glow-world", noiseSeed: "1" }, "INVALID_REQUEST"],
    ["array body", [], "INVALID_REQUEST"],
  ])("rejects session creation with %s", async (_label, body, code) => {
    const api = await start();
    const response = await api.call("POST", "/sessions", body);
    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: { code, message: expect.any(String) } });
  });

  it("rejects malformed JSON, the wrong media type, and oversized bodies", async () => {
    const api = await start();
    expect((await api.call("POST", "/sessions", "{not json")).json.error.code).toBe("INVALID_JSON");
    const wrongType = await api.call("POST", "/sessions", "worldId=glow-world", { "content-type": "text/plain" });
    expect(wrongType.status).toBe(415);
    const huge = await api.call("POST", "/sessions", { worldId: "x".repeat(MAX_BODY_BYTES) });
    expect(huge.status).toBe(413);
  });

  it("validates step bodies and query strings", async () => {
    const api = await start();
    const id = (await api.call("POST", "/sessions", { worldId: "glow-world" })).json.session.sessionId;
    for (const body of [{ turns: 0 }, { turns: 33 }, { turns: "2" }, { steps: 1 }]) {
      expect((await api.call("POST", `/sessions/${id}/steps`, body)).status).toBe(400);
    }
    expect((await api.call("GET", `/sessions/${id}/transcript?from=-1`)).status).toBe(400);
    expect((await api.call("GET", `/sessions/${id}/transcript?from=1&from=2`)).status).toBe(400);
    expect((await api.call("GET", `/sessions/${id}?verbose=1`)).status).toBe(400);
    expect((await api.call("GET", "/worlds?all=1")).status).toBe(400);
  });

  it("returns 404 for unknown routes and sessions, and 405 with Allow for the wrong method", async () => {
    const api = await start();
    expect((await api.call("GET", "/nope")).status).toBe(404);
    expect((await api.call("GET", "/sessions/not-a-uuid")).status).toBe(404);
    expect((await api.call("GET", "/sessions/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const wrong = await api.call("PUT", "/sessions");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET, POST");
  });

  it("never echoes request content in errors", async () => {
    const api = await start();
    const marker = "ECHO-MARKER-7f3a";
    const responses = [
      await api.call("POST", "/sessions", { worldId: marker }),
      await api.call("POST", "/sessions", { [marker]: 1, worldId: "glow-world" }),
      await api.call("POST", "/sessions", `{"${marker}"`),
      await api.call("GET", `/${marker}`),
    ];
    for (const response of responses) {
      expect(response.text).not.toContain(marker);
    }
  });

  it("sets defensive headers on every response", async () => {
    const api = await start();
    const response = await api.call("GET", "/health");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });
});

describe("Evaluator-only routes", () => {
  it("are disabled without an operator token", async () => {
    const api = await start();
    const id = await finishedSession(api);
    const response = await api.call("POST", `/evaluator/sessions/${id}/evaluations`, {}, { authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(403);
    expect(response.json.error.code).toBe("EVALUATOR_DISABLED");
  });

  it("require the bearer token, before revealing whether a route or session exists", async () => {
    const api = await start({ operatorToken: TOKEN });
    const id = await finishedSession(api);
    const attempts: Array<Record<string, string>> = [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN }];
    for (const headers of attempts) {
      expect((await api.call("GET", `/evaluator/sessions/${id}`, undefined, headers)).status).toBe(401);
    }
    expect((await api.call("GET", "/evaluator/anything")).status).toBe(401);
    expect((await api.call("PUT", `/evaluator/sessions/${id}`)).status).toBe(401);
    expect((await api.operator("GET", "/evaluator/anything")).status).toBe(404);
  });

  it("refuse to evaluate before a theory exists", async () => {
    const api = await start({ operatorToken: TOKEN });
    const id = (await api.call("POST", "/sessions", { worldId: "glow-world" })).json.session.sessionId;
    const response = await api.operator("POST", `/evaluator/sessions/${id}/evaluations`, {});
    expect(response.status).toBe(409);
    expect(response.json.error.code).toBe("NO_THEORY");
  });

  it("score the submitted theory and keep scores and private settings on the evaluator side", async () => {
    const api = await start({ operatorToken: TOKEN });
    const id = await finishedSession(api);
    expect((await api.operator("POST", `/evaluator/sessions/${id}/evaluations`, { caseCount: 3 })).status).toBe(400);

    const evaluated = await api.operator("POST", `/evaluator/sessions/${id}/evaluations`, EVAL_SEEDS);
    expect(evaluated.status).toBe(201);
    expect(evaluated.json.evaluation).toMatchObject({ evaluationId: 1, options: EVAL_SEEDS });
    expect(evaluated.json.evaluation.report.kind).toBe("number");
    expect(typeof evaluated.json.evaluation.report.inRange.passed).toBe("boolean");

    const view = await api.operator("GET", `/evaluator/sessions/${id}`);
    expect(view.json.session).toMatchObject({ sessionId: id, worldId: "drift-world", noiseSeed: NOISE_SEED });
    expect(view.json.session.evaluations).toHaveLength(1);

    const publicView = await api.call("GET", `/sessions/${id}`);
    expect(publicView.text).not.toMatch(/evaluation|report|passed/i);
  });
});

describe("Leak checks", () => {
  it("no investigation route returns hidden-rule data, scores, or private settings", async () => {
    const api = await start({ operatorToken: TOKEN });
    await api.call("GET", "/worlds");
    for (const worldId of ["glow-world", "ring-world", "drift-world"]) {
      const id = await finishedSession(api, worldId);
      await api.operator("POST", `/evaluator/sessions/${id}/evaluations`, EVAL_SEEDS);
      await api.call("GET", `/sessions/${id}`);
      await api.call("GET", `/sessions/${id}/world`);
      await api.call("GET", `/sessions/${id}/observations`);
      await api.call("GET", `/sessions/${id}/transcript`);
    }
    await api.call("GET", "/sessions");

    expect(publicBodies.length).toBeGreaterThan(10);
    const everything = publicBodies.join("\n");
    expect(everything).not.toContain(String(NOISE_SEED));
    expect(everything).not.toContain(String(EVAL_SEEDS.inRangeSeed));
    expect(everything).not.toContain(String(EVAL_SEEDS.outOfRangeSeed));
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toMatch(
      /flipRate|noiseStandardDeviation|extrapolation|outsideAttributes|trueOutcome|HIDDEN_THRESHOLD|noiseSeed|accuracy|passThreshold|rootMeanSquaredError|noiseCeiling|evaluations/,
    );
  });

  it("the API's investigation code does not reach world engines except through the registry and tools", () => {
    for (const file of ["app.ts", "schemas.ts", "session-manager.ts"]) {
      const source = readFileSync(new URL(`../src/api/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/from\s+"\.\.\/worlds\/(glow|ring|drift)-world/);
      expect(source).not.toMatch(/console\.log|GEMINI_API_KEY/);
    }
  });
});

describe("serve arguments", () => {
  it("parses --port and --live", () => {
    expect(parseServeArgs([])).toEqual({ port: 3000, live: false });
    expect(parseServeArgs(["--port", "8080", "--live"])).toEqual({ port: 8080, live: true });
  });

  it.each([[["--port"]], [["--port", "0"]], [["--port", "70000"]], [["--port", "80a"]], [["--live", "--live"]], [["--host", "x"]]])(
    "rejects %j",
    (argv) => {
      expect(() => parseServeArgs(argv)).toThrow(ServeArgumentsError);
    },
  );
});
