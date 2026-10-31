import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES } from "../src/tools/schemas.js";
import { createWorldSchemas } from "../src/tools/world-schemas.js";
import { createWorldTools } from "../src/tools/world-tools.js";
import { DRIFT_WORLD } from "../src/worlds/drift-world.js";
import { GLOW_WORLD } from "../src/worlds/glow-world.js";
import { WORLDS } from "../src/worlds/registry.js";
import { RING_WORLD } from "../src/worlds/ring-world.js";
import type { World } from "../src/worlds/world.js";

const worlds = WORLDS.map((world) => [world.spec.worldId, world] as const);

function validInputs(world: World, value = 3): Record<string, number> {
  return Object.fromEntries(world.spec.attributeNames.map((name) => [name, value]));
}

function keys(value: object): string[] {
  return Object.keys(value).sort();
}

describe("Generic experiment tools: public description", () => {
  it("describes Ring World exactly", () => {
    expect(createWorldTools(RING_WORLD, { budget: 12 }).describeWorld()).toStrictEqual({
      worldId: "ring-world",
      attributes: {
        p: { min: 0, max: 10 },
        q: { min: 0, max: 10 },
        r: { min: 0, max: 10 },
        s: { min: 0, max: 10 },
      },
      outcome: { lit: "boolean" },
      observationNoise: "present",
      experimentBudget: 12,
    });
  });

  it("describes Drift World exactly", () => {
    expect(createWorldTools(DRIFT_WORLD).describeWorld()).toStrictEqual({
      worldId: "drift-world",
      attributes: {
        u: { min: 0, max: 10 },
        v: { min: 0, max: 10 },
        w: { min: 0, max: 10 },
        x: { min: 0, max: 10 },
        y: { min: 0, max: 10 },
      },
      outcome: { level: "number" },
      observationNoise: "present",
      experimentBudget: 30,
    });
  });

  it.each(worlds)("%s: description matches its strict schema and carries no private configuration", (_id, world) => {
    const description = createWorldTools(world, { noiseSeed: 98765 }).describeWorld();
    expect(createWorldSchemas(world.spec).description.safeParse(description).success).toBe(true);
    expect(keys(description)).toEqual(["attributes", "experimentBudget", "observationNoise", "outcome", "worldId"]);
    const text = JSON.stringify(description);
    for (const marker of ["flip", "noiseStandard", "extrapolation", "outside", "extended", "98765", "trueOutcome"]) {
      expect(text).not.toContain(marker);
    }
  });
});

describe("Generic experiment tools: validation and budget", () => {
  it.each(worlds)("%s: accepts both range endpoints and rejects malformed requests", (_id, world) => {
    const tools = createWorldTools(world, { budget: 30 });
    expect(tools.runExperiment(validInputs(world, 0)).ok).toBe(true);
    expect(tools.runExperiment(validInputs(world, 10)).ok).toBe(true);
    const [first] = world.spec.attributeNames;
    const bad: unknown[] = [
      { ...validInputs(world), [first!]: -0.001 },
      { ...validInputs(world), [first!]: 10.001 },
      { ...validInputs(world), [first!]: "3" },
      { ...validInputs(world), [first!]: null },
      { ...validInputs(world), [first!]: Number.NaN },
      { ...validInputs(world), [first!]: Number.POSITIVE_INFINITY },
      { ...validInputs(world), extra: 1 },
      Object.fromEntries(world.spec.attributeNames.slice(1).map((name) => [name, 3])),
      null,
      "inputs",
      [],
    ];
    for (const request of bad) {
      expect(tools.runExperiment(request)).toStrictEqual({
        ok: false,
        error: { code: "INVALID_INPUT", message: ERROR_MESSAGES.INVALID_INPUT },
      });
    }
    expect(tools.getRemainingBudget()).toBe(28);
    expect(tools.getObservationLog()).toHaveLength(2);
  });

  it.each(worlds)("%s: counts the budget down and then refuses", (_id, world) => {
    const tools = createWorldTools(world, { budget: 3 });
    const remaining = [1, 2, 3].map(() => {
      const result = tools.runExperiment(validInputs(world));
      return result.ok ? result.observation.remainingBudget : -1;
    });
    expect(remaining).toEqual([2, 1, 0]);
    expect(tools.runExperiment(validInputs(world))).toStrictEqual({
      ok: false,
      error: { code: "BUDGET_EXHAUSTED", message: ERROR_MESSAGES.BUDGET_EXHAUSTED },
    });
    expect(tools.getObservationLog().map((observation) => observation.step)).toEqual([1, 2, 3]);
  });

  it("rejects an invalid budget", () => {
    expect(() => createWorldTools(RING_WORLD, { budget: 0 })).toThrow();
    expect(() => createWorldTools(RING_WORLD, { budget: 1.5 })).toThrow();
  });
});

describe("Generic experiment tools: responses", () => {
  it.each(worlds)("%s: success responses contain exactly the documented fields", (_id, world) => {
    const tools = createWorldTools(world);
    const result = tools.runExperiment(validInputs(world));
    expect(createWorldSchemas(world.spec).result.safeParse(result).success).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(keys(result)).toEqual(["observation", "ok"]);
    expect(keys(result.observation)).toEqual(["inputs", "outcome", "remainingBudget", "step"]);
    expect(Object.keys(result.observation.inputs)).toEqual(world.spec.attributeNames);
    expect(Object.keys(result.observation.outcome)).toEqual([world.spec.outcomeName]);
    expect(typeof result.observation.outcome[world.spec.outcomeName]).toBe(world.spec.outcomeKind);
  });

  it.each(worlds)("%s: changing returned data does not change the stored log", (_id, world) => {
    const tools = createWorldTools(world);
    const result = tools.runExperiment(validInputs(world));
    if (!result.ok) throw new Error("expected success");
    const before = tools.getObservationLog();
    result.observation.inputs[world.spec.attributeNames[0]!] = 99;
    result.observation.step = 42;
    const copy = tools.getObservationLog();
    copy[0]!.remainingBudget = 999;
    copy.push(copy[0]!);
    const description = tools.describeWorld();
    description.experimentBudget = 1;
    expect(tools.getObservationLog()).toStrictEqual(before);
    expect(tools.getRemainingBudget()).toBe(29);
  });
});

describe("Generic experiment tools: noise", () => {
  it.each(worlds)("%s: the same noise seed and requests reproduce the same observations", (_id, world) => {
    const run = (seed: number) => {
      const tools = createWorldTools(world, { noiseSeed: seed });
      for (let i = 0; i < 20; i++) {
        tools.runExperiment(validInputs(world, (i * 7) % 11));
      }
      return tools.getObservationLog();
    };
    expect(run(5)).toStrictEqual(run(5));
  });

  it("varies Drift World's repeated measurements, and the noise seed changes them", () => {
    const repeat = (seed: number) => {
      const tools = createWorldTools(DRIFT_WORLD, { noiseSeed: seed });
      return Array.from({ length: 5 }, () => {
        const result = tools.runExperiment(validInputs(DRIFT_WORLD, 5));
        return result.ok ? (result.observation.outcome.level as number) : Number.NaN;
      });
    };
    const first = repeat(1);
    expect(new Set(first).size).toBe(5);
    for (const value of first) {
      expect(Math.abs(value - 5)).toBeLessThan(3);
    }
    expect(repeat(2)).not.toEqual(first);
  });

  it("gives Glow World identical outcomes for every seed", () => {
    const outcomes = (seed: number) => {
      const tools = createWorldTools(GLOW_WORLD, { noiseSeed: seed });
      return [0, 2, 8, 10].map((a) => {
        const result = tools.runExperiment({ a, b: 2, c: 1 });
        return result.ok ? result.observation.outcome.glows : null;
      });
    };
    expect(outcomes(1)).toEqual([false, false, true, true]);
    expect(outcomes(777)).toEqual(outcomes(1));
  });

  it.each([RING_WORLD, DRIFT_WORLD].map((world) => [world.spec.worldId, world] as const))(
    "%s: rejected requests draw no noise",
    (_id, world) => {
      const withRejections = createWorldTools(world, { noiseSeed: 4 });
      const clean = createWorldTools(world, { noiseSeed: 4 });
      withRejections.runExperiment({ nope: true });
      withRejections.runExperiment(validInputs(world, 2));
      withRejections.runExperiment({ ...validInputs(world), extra: 1 });
      withRejections.runExperiment(validInputs(world, 8));
      clean.runExperiment(validInputs(world, 2));
      clean.runExperiment(validInputs(world, 8));
      expect(withRejections.getObservationLog()).toStrictEqual(clean.getObservationLog());
    },
  );

  it("never forwards private world fields", () => {
    const source = readFileSync(new URL("../src/tools/world-tools.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/flipRate|noiseStandardDeviation|extrapolation|trueOutcome/);
  });
});
