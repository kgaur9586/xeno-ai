import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as driftModule from "../src/worlds/drift-world.js";
import * as ringModule from "../src/worlds/ring-world.js";
import { DRIFT_WORLD } from "../src/worlds/drift-world.js";
import { computeGlowOutcome, GLOW_WORLD } from "../src/worlds/glow-world.js";
import { getWorld, WORLD_IDS, WORLDS } from "../src/worlds/registry.js";
import { RING_WORLD } from "../src/worlds/ring-world.js";
import { createSeededRandom, drawStandardNormal } from "../src/shared/random.js";

/** A random source that replays fixed values and counts how many were used. */
function replay(values: number[]) {
  let used = 0;
  const random = () => {
    const value = values[used];
    used++;
    if (value === undefined) {
      throw new Error("replay exhausted");
    }
    return value;
  };
  return {
    random,
    get used() {
      return used;
    },
  };
}

function ring(p: number, q: number, r = 0, s = 0) {
  return { p, q, r, s };
}

function drift(u: number, v: number, w = 0, x = 0, y = 0) {
  return { u, v, w, x, y };
}

describe("World registry", () => {
  it("lists three worlds with distinct ids and attribute names", () => {
    expect(WORLD_IDS).toEqual(["glow-world", "ring-world", "drift-world"]);
    expect(getWorld("ring-world")).toBe(RING_WORLD);
    expect(getWorld("nope")).toBeUndefined();
    for (const world of WORLDS) {
      expect(Object.isFrozen(world)).toBe(true);
      expect(Object.isFrozen(world.spec)).toBe(true);
      expect(Object.keys(world.spec.attributes)).toEqual(world.spec.attributeNames);
    }
  });

  it("uses two or more distractor attributes in each new world", () => {
    expect(RING_WORLD.spec.attributeNames).toEqual(["p", "q", "r", "s"]);
    expect(DRIFT_WORLD.spec.attributeNames).toEqual(["u", "v", "w", "x", "y"]);
  });
});

describe("Glow World adapter", () => {
  it("matches computeGlowOutcome and never draws noise", () => {
    const source = replay([]);
    for (const inputs of [
      { a: 8, b: 2, c: 1 },
      { a: 5, b: 2, c: 1 },
      { a: 2, b: 2, c: 10 },
      { a: 0, b: 10, c: 5 },
    ]) {
      expect(GLOW_WORLD.trueOutcome(inputs)).toBe(computeGlowOutcome(inputs).glows);
      expect(GLOW_WORLD.observe(inputs, source.random)).toBe(computeGlowOutcome(inputs).glows);
    }
    expect(source.used).toBe(0);
    expect(GLOW_WORLD.spec.noisy).toBe(false);
  });
});

describe("Ring World", () => {
  it("is lit exactly inside its circle, and the boundary is not lit", () => {
    expect(RING_WORLD.trueOutcome(ring(10, 5))).toBe(true);
    expect(RING_WORLD.trueOutcome(ring(6, 5))).toBe(true);
    expect(RING_WORLD.trueOutcome(ring(10, 9))).toBe(true);
    expect(RING_WORLD.trueOutcome(ring(8, 2))).toBe(true);
    expect(RING_WORLD.trueOutcome(ring(5, 5))).toBe(false);
    expect(RING_WORLD.trueOutcome(ring(10, 0))).toBe(false);
    expect(RING_WORLD.trueOutcome(ring(10, 10))).toBe(false);
    expect(RING_WORLD.trueOutcome(ring(0, 0))).toBe(false);
    expect(RING_WORLD.trueOutcome(ring(2, 5))).toBe(false);
  });

  it("ignores both distractors", () => {
    for (const [p, q] of [
      [10, 5],
      [5, 5],
      [8, 2],
      [1, 9],
    ] as const) {
      const expected = RING_WORLD.trueOutcome(ring(p, q));
      for (const r of [0, 5, 10]) {
        for (const s of [0, 5, 10]) {
          expect(RING_WORLD.trueOutcome(ring(p, q, r, s))).toBe(expected);
        }
      }
    }
  });

  it("is deterministic without noise and flips an observation only on a low draw", () => {
    expect(RING_WORLD.trueOutcome(ring(8, 2))).toBe(RING_WORLD.trueOutcome(ring(8, 2)));
    const keep = replay([0.5]);
    expect(RING_WORLD.observe(ring(8, 2), keep.random)).toBe(true);
    expect(keep.used).toBe(1);
    const flip = replay([0.01]);
    expect(RING_WORLD.observe(ring(8, 2), flip.random)).toBe(false);
    expect(flip.used).toBe(1);
  });

  it("flips about one observation in twenty, reproducibly for a fixed seed", () => {
    const observeMany = (seed: number) => {
      const random = createSeededRandom(seed);
      return Array.from({ length: 10_000 }, () => RING_WORLD.observe(ring(8, 2), random));
    };
    const first = observeMany(3);
    expect(observeMany(3)).toEqual(first);
    const flips = first.filter((lit) => !lit).length / first.length;
    expect(flips).toBeGreaterThan(0.04);
    expect(flips).toBeLessThan(0.06);
  });

  it("exports only the world object and its public id", () => {
    expect(Object.keys(ringModule).sort()).toEqual(["RING_WORLD", "RING_WORLD_ID"]);
  });
});

describe("Drift World", () => {
  it("computes a numeric level from u and v", () => {
    expect(DRIFT_WORLD.trueOutcome(drift(0, 0))).toBe(10);
    expect(DRIFT_WORLD.trueOutcome(drift(10, 0))).toBe(30);
    expect(DRIFT_WORLD.trueOutcome(drift(0, 10))).toBe(-20);
    expect(DRIFT_WORLD.trueOutcome(drift(5, 5))).toBe(5);
  });

  it("ignores all three distractors", () => {
    const expected = DRIFT_WORLD.trueOutcome(drift(3, 7));
    for (const w of [0, 10]) {
      for (const x of [0, 10]) {
        for (const y of [0, 10]) {
          expect(DRIFT_WORLD.trueOutcome(drift(3, 7, w, x, y))).toBe(expected);
        }
      }
    }
  });

  it("adds Gaussian noise using exactly two draws per observation", () => {
    const source = replay([0.5, 0.25]);
    expect(DRIFT_WORLD.observe(drift(5, 5), source.random)).toBeCloseTo(5, 12);
    expect(source.used).toBe(2);
  });

  it("has noise with mean near 0 and standard deviation near 0.5, reproducibly", () => {
    const observeMany = (seed: number) => {
      const random = createSeededRandom(seed);
      return Array.from({ length: 10_000 }, () => DRIFT_WORLD.observe(drift(5, 5), random) - 5);
    };
    const errors = observeMany(9);
    expect(observeMany(9)).toEqual(errors);
    const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length;
    const sd = Math.sqrt(errors.reduce((sum, value) => sum + (value - mean) ** 2, 0) / errors.length);
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(sd).toBeGreaterThan(0.48);
    expect(sd).toBeLessThan(0.52);
  });

  it("exports only the world object and its public id", () => {
    expect(Object.keys(driftModule).sort()).toEqual(["DRIFT_WORLD", "DRIFT_WORLD_ID"]);
  });
});

describe("World isolation", () => {
  it("no agent or provider file imports a world module", () => {
    for (const directory of ["../src/agents/", "../src/llm/"]) {
      const url = new URL(directory, import.meta.url);
      for (const file of readdirSync(url).filter((name) => name.endsWith(".ts"))) {
        const source = readFileSync(new URL(file, url), "utf8");
        expect(source, `${directory}${file}`).not.toMatch(/from\s+"[^"]*worlds\//);
        expect(source, `${directory}${file}`).not.toMatch(/RING_WORLD|DRIFT_WORLD|GLOW_WORLD\b/);
      }
    }
  });
});

describe("Standard normal draws", () => {
  it("are finite even when the first draw is zero", () => {
    expect(Number.isFinite(drawStandardNormal(replay([0, 0.5]).random))).toBe(true);
  });
});
