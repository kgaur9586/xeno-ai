import { describe, expect, it } from "vitest";
import * as glowWorld from "../src/worlds/glow-world.js";
import { computeGlowOutcome } from "../src/worlds/glow-world.js";

function glows(a: number, b: number, c = 1): boolean {
  return computeGlowOutcome({ a, b, c }).glows;
}

describe("[AT-1] Reproducibility of the world", () => {
  it("gives the same outcome for the same inputs every time", () => {
    const samples = [
      [8, 2, 1],
      [2, 2, 7],
      [5, 9, 0],
      [0.001, 9.999, 10],
    ] as const;
    for (const [a, b, c] of samples) {
      const first = glows(a, b, c);
      for (let i = 0; i < 100; i++) {
        expect(glows(a, b, c)).toBe(first);
      }
    }
  });
});

describe("[AT-2] Rule correctness", () => {
  it("glows when a and b are on opposite sides", () => {
    expect(glows(8, 2)).toBe(true);
    expect(glows(2, 8)).toBe(true);
    expect(glows(0, 10)).toBe(true);
    expect(glows(10, 0)).toBe(true);
  });

  it("does not glow when a and b are on the same side", () => {
    expect(glows(8, 8)).toBe(false);
    expect(glows(2, 2)).toBe(false);
    expect(glows(0, 0)).toBe(false);
    expect(glows(10, 10)).toBe(false);
  });

  it("is never affected by c", () => {
    const pairs = [
      [8, 2],
      [2, 8],
      [8, 8],
      [2, 2],
      [5, 2],
      [0, 10],
    ] as const;
    for (const [a, b] of pairs) {
      const reference = glows(a, b, 0);
      for (const c of [0, 0.5, 5, 7.25, 10]) {
        expect(glows(a, b, c)).toBe(reference);
      }
    }
  });
});

describe("[AT-3] Boundary at exactly 5", () => {
  it("never glows when a or b is exactly 5", () => {
    expect(glows(5, 2)).toBe(false);
    expect(glows(2, 5)).toBe(false);
    expect(glows(5, 8)).toBe(false);
    expect(glows(8, 5)).toBe(false);
    expect(glows(5, 5)).toBe(false);
  });

  it("treats values just off 5 as being on a side", () => {
    expect(glows(5.0001, 4.9999)).toBe(true);
    expect(glows(4.9999, 5.0001)).toBe(true);
    expect(glows(5.0001, 5.0001)).toBe(false);
    expect(glows(4.9999, 4.9999)).toBe(false);
  });
});

describe("World module surface", () => {
  it("exports only public facts and the outcome function, not the rule configuration", () => {
    expect(Object.keys(glowWorld).sort()).toEqual(
      ["ATTRIBUTE_MAX", "ATTRIBUTE_MIN", "GLOW_WORLD_ID", "computeGlowOutcome"].sort(),
    );
  });

  it("returns an outcome with exactly one field", () => {
    expect(Object.keys(computeGlowOutcome({ a: 8, b: 2, c: 1 }))).toEqual(["glows"]);
  });
});
