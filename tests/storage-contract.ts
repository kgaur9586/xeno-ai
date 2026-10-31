/**
 * The behaviour every `SessionStore` backend must have. Each backend's test
 * file calls `describeSessionStoreContract` with a factory that returns an
 * empty store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDummyProvider } from "../src/llm/dummy-provider.js";
import { createSessionManager } from "../src/api/session-manager.js";
import {
  DuplicateSessionError,
  type SessionProgress,
  type SessionRecord,
  type SessionStore,
  type StoredEvaluation,
} from "../src/storage/session-store.js";

export function sampleRecord(sessionId: string, createdAt = "2026-10-31T10:00:00.000Z"): SessionRecord {
  return {
    sessionId,
    worldId: "ring-world",
    provider: "dummy",
    createdAt,
    updatedAt: createdAt,
    config: { budget: 30, maxModelTurns: 16, timeoutMs: 60_000, maxRetries: 2, noiseSeed: 41 },
    status: "running",
    modelTurns: 1,
    transcript: [
      { type: "system_prompt", text: "prompt" },
      { type: "tool_calls", calls: [{ id: "call-1", name: "run_experiment", arguments: { x: 1, y: -2 } }] },
    ],
    messages: [
      { role: "user", text: "begin" },
      { role: "model", toolCalls: [{ id: "call-1", name: "run_experiment", arguments: { x: 1, y: -2 } }], echo: { sig: "abc" } },
    ],
    observations: [{ step: 1, inputs: { x: 1, y: -2 }, outcome: { inside: true }, remainingBudget: 29 }],
    submittedTheory: null,
    providerDiagnostic: null,
    evaluations: [],
  };
}

/** Model-written content with keys MongoDB would otherwise treat specially. */
function hostileProgress(updatedAt: string): SessionProgress {
  const argumentsWithOddKeys = JSON.parse('{"$where":"1","a.b":2,"__proto__":{"polluted":true},"":null}') as unknown;
  return {
    status: "theory_submitted",
    modelTurns: 3,
    transcript: [
      { type: "model_text", text: "thinking ✓ — émoji 🔬" },
      { type: "tool_calls", calls: [{ id: "c", name: "submit_theory", arguments: argumentsWithOddKeys }] },
    ],
    messages: [{ role: "model", toolCalls: [{ id: "c", name: "submit_theory", arguments: argumentsWithOddKeys }] }],
    observations: [
      { step: 1, inputs: { x: 1, y: -2 }, outcome: { inside: true }, remainingBudget: 29 },
      { step: 2, inputs: { x: 0.125, y: 3 }, outcome: { inside: false }, remainingBudget: 28 },
    ],
    submittedTheory: { measurement: { op: "add", args: [{ attr: "x" }, { const: 1e-9 }], $odd: 1 }, operator: ">", threshold: 0 },
    providerDiagnostic: null,
    updatedAt,
  };
}

function sampleEvaluation(evaluationId: number): StoredEvaluation {
  return {
    evaluationId,
    evaluatedAt: "2026-10-31T11:00:00.000Z",
    options: { inRangeSeed: 3, outOfRangeSeed: 4, caseCount: 200 },
    report: { worldId: "ring-world" } as unknown as StoredEvaluation["report"],
  };
}

export function describeSessionStoreContract(name: string, makeStore: () => Promise<SessionStore>): void {
  describe(`SessionStore contract: ${name}`, () => {
    let store: SessionStore;

    beforeEach(async () => {
      store = await makeStore();
    });

    afterEach(async () => {
      await store.close();
    });

    it("starts empty", async () => {
      expect(await store.list()).toEqual([]);
      expect(await store.count()).toBe(0);
      expect(await store.get("missing")).toBeNull();
    });

    it("returns an inserted record unchanged", async () => {
      const record = sampleRecord("a");
      await store.insert(record);
      expect(await store.get("a")).toEqual(record);
      expect(await store.count()).toBe(1);
    });

    it("rejects a duplicate id and keeps the original", async () => {
      await store.insert(sampleRecord("a"));
      await expect(store.insert({ ...sampleRecord("a"), worldId: "drift-world" })).rejects.toBeInstanceOf(
        DuplicateSessionError,
      );
      expect((await store.get("a"))!.worldId).toBe("ring-world");
    });

    it("lists oldest first and breaks ties by id", async () => {
      await store.insert(sampleRecord("c", "2026-10-31T10:00:01.000Z"));
      await store.insert(sampleRecord("b", "2026-10-31T10:00:00.000Z"));
      await store.insert(sampleRecord("a", "2026-10-31T10:00:01.000Z"));
      expect((await store.list()).map((record) => record.sessionId)).toEqual(["b", "a", "c"]);
    });

    it("never shares objects with callers", async () => {
      const record = sampleRecord("a");
      await store.insert(record);
      record.observations.push({ step: 9, inputs: {}, outcome: {}, remainingBudget: 0 });
      record.config.budget = 1;
      const read = (await store.get("a"))!;
      expect(read.observations).toHaveLength(1);
      expect(read.config.budget).toBe(30);
      read.transcript.length = 0;
      expect((await store.get("a"))!.transcript).toHaveLength(2);
      (await store.list())[0]!.evaluations.push(sampleEvaluation(1));
      expect((await store.get("a"))!.evaluations).toEqual([]);
    });

    it("saves progress and keeps the fixed fields", async () => {
      await store.insert(sampleRecord("a"));
      const progress = hostileProgress("2026-10-31T10:05:00.000Z");
      expect(await store.saveProgress("a", progress)).toBe(true);
      const read = (await store.get("a"))!;
      expect(read).toEqual({ ...sampleRecord("a"), ...progress });
      expect(read.transcript).toEqual(progress.transcript);
      expect(Object.keys((read.messages[0] as { toolCalls: Array<{ arguments: object }> }).toolCalls[0]!.arguments)).toEqual([
        "$where",
        "a.b",
        "__proto__",
        "",
      ]);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("ignores stray fields passed with progress", async () => {
      await store.insert(sampleRecord("a"));
      const progress = { ...hostileProgress("2026-10-31T10:05:00.000Z"), worldId: "glow-world", evaluations: [sampleEvaluation(1)] };
      await store.saveProgress("a", progress);
      const read = (await store.get("a"))!;
      expect(read.worldId).toBe("ring-world");
      expect(read.evaluations).toEqual([]);
    });

    it("reports a missing session on every write", async () => {
      expect(await store.saveProgress("missing", hostileProgress("2026-10-31T10:05:00.000Z"))).toBe(false);
      expect(await store.appendEvaluation("missing", sampleEvaluation(1))).toBe(false);
      expect(await store.remove("missing")).toBe(false);
      expect(await store.count()).toBe(0);
    });

    it("appends evaluations in order, including concurrent ones", async () => {
      await store.insert(sampleRecord("a"));
      await Promise.all([1, 2, 3, 4].map((id) => store.appendEvaluation("a", sampleEvaluation(id))));
      const ids = (await store.get("a"))!.evaluations.map((evaluation) => evaluation.evaluationId);
      expect([...ids].sort()).toEqual([1, 2, 3, 4]);
      await store.appendEvaluation("a", sampleEvaluation(5));
      expect((await store.get("a"))!.evaluations.at(-1)).toEqual(sampleEvaluation(5));
    });

    it("keeps evaluations when progress is saved", async () => {
      await store.insert(sampleRecord("a"));
      await store.appendEvaluation("a", sampleEvaluation(1));
      await store.saveProgress("a", hostileProgress("2026-10-31T10:05:00.000Z"));
      expect((await store.get("a"))!.evaluations).toEqual([sampleEvaluation(1)]);
    });

    it("removes only the named session", async () => {
      await store.insert(sampleRecord("a"));
      await store.insert(sampleRecord("b"));
      expect(await store.remove("a")).toBe(true);
      expect(await store.get("a")).toBeNull();
      expect((await store.list()).map((record) => record.sessionId)).toEqual(["b"]);
      expect(await store.remove("a")).toBe(false);
    });

    it("lets a new session manager continue a session another manager started", async () => {
      const providers = { dummy: createDummyProvider };
      const first = createSessionManager({ providers, store });
      const created = await first.create({
        worldId: "drift-world",
        provider: "dummy",
        budget: 30,
        maxModelTurns: 16,
        timeoutMs: 60_000,
        maxRetries: 0,
        noiseSeed: 5,
      });
      const firstStep = await first.step(created.sessionId, 1);
      expect(firstStep.session.experimentCount).toBeGreaterThan(0);

      const restarted = createSessionManager({ providers, store });
      expect(await restarted.observations(created.sessionId)).toEqual(await first.observations(created.sessionId));
      const finished = await restarted.step(created.sessionId, 32);
      expect(finished.session.status).toBe("theory_submitted");
      expect(finished.session.submittedTheory).not.toBeNull();

      const uninterrupted = createSessionManager({ providers });
      const reference = await uninterrupted.create({
        worldId: "drift-world",
        provider: "dummy",
        budget: 30,
        maxModelTurns: 16,
        timeoutMs: 60_000,
        maxRetries: 0,
        noiseSeed: 5,
      });
      const referenceRun = await uninterrupted.step(reference.sessionId, 32);
      expect(await restarted.observations(created.sessionId)).toEqual(await uninterrupted.observations(reference.sessionId));
      expect(finished.session.submittedTheory).toEqual(referenceRun.session.submittedTheory);
      expect((await restarted.transcript(created.sessionId, 0)).entries).toEqual(
        (await uninterrupted.transcript(reference.sessionId, 0)).entries,
      );

      const evaluation = await restarted.evaluate(created.sessionId, { inRangeSeed: 1, outOfRangeSeed: 2, caseCount: 100 });
      expect((await first.operatorView(created.sessionId)).evaluations).toEqual([evaluation]);
    });

    it("refuses to resume a session whose stored experiments do not replay", async () => {
      const providers = { dummy: createDummyProvider };
      const first = createSessionManager({ providers, store });
      const created = await first.create({
        worldId: "drift-world",
        provider: "dummy",
        budget: 30,
        maxModelTurns: 16,
        timeoutMs: 60_000,
        maxRetries: 0,
        noiseSeed: 5,
      });
      await first.step(created.sessionId, 1);
      const record = (await store.get(created.sessionId))!;
      const tampered = structuredClone(record.observations);
      const outcome = tampered[0]!.outcome as Record<string, number>;
      const key = Object.keys(outcome)[0]!;
      outcome[key] = outcome[key]! + 1;
      await store.saveProgress(created.sessionId, { ...record, observations: tampered });

      const restarted = createSessionManager({ providers, store });
      await expect(restarted.step(created.sessionId, 1)).rejects.toMatchObject({ code: "SESSION_CORRUPT" });
    });
  });
}
