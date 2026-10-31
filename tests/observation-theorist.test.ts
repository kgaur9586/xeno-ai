import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fitTheoryFromObservations,
  scoreTheoryOnObservations,
  type ObservedRow,
  type PublicRanges,
} from "../src/agents/observation-theorist.js";

const RANGES: PublicRanges = {
  a: { min: 0, max: 10 },
  b: { min: 0, max: 10 },
  c: { min: 0, max: 10 },
};

function row(a: number, b: number, c: number, glows: boolean): ObservedRow {
  return { inputs: { a, b, c }, outcome: glows };
}

describe("Observation theorist", () => {
  it("imports neither the world engine nor the evaluator, and hardcodes neither threshold", () => {
    const source = readFileSync(new URL("../src/agents/observation-theorist.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[2]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/worlds|evaluator/);
    }
    expect(source).not.toMatch(/\b5\b/);
    expect(source).not.toMatch(/HIDDEN_THRESHOLD|computeGlowOutcome|coincides/);
    expect(source).not.toMatch(/\beval\s*\(|\bnew\s+Function\b/);
  });

  it("follows the observations when a distractor attribute is the one that separates them", () => {
    const fitted = fitTheoryFromObservations(RANGES, [
      row(0, 10, 0, false),
      row(10, 0, 0, false),
      row(0, 0, 10, true),
      row(10, 10, 10, true),
      row(5, 5, 5, false),
      row(2, 8, 10, true),
      row(8, 2, 0, false),
    ]);

    expect(fitted.candidateCount).toBe(26);
    expect(fitted.inSampleAccuracy).toBe(1);
    expect(fitted.theory.operator).toBe("gt");
    expect(fitted.theory.threshold).toBe(5);
    expect(fitted.theory.measurement).toEqual({ var: "c" });
  });

  it("selects the centered product when that is the unique perfect fit", () => {
    const fitted = fitTheoryFromObservations(RANGES, [
      row(0, 10, 1, true),
      row(10, 0, 9, true),
      row(0, 0, 9, false),
      row(10, 10, 1, false),
      row(0, 5, 4, false),
      row(5, 10, 6, false),
      row(2, 8, 3, true),
      row(8, 2, 7, true),
      row(8, 8, 0, false),
      row(2, 2, 10, false),
      row(1, 9, 5, true),
      row(9, 1, 5, true),
    ]);

    expect(fitted.inSampleAccuracy).toBe(1);
    expect(fitted.theory.operator).toBe("lt");
    expect(fitted.theory.threshold).toBe(0);
    expect(fitted.theory.measurement).toEqual({
      op: "mul",
      left: { op: "sub", left: { var: "a" }, right: { const: 5 } },
      right: { op: "sub", left: { var: "b" }, right: { const: 5 } },
    });
  });

  it("returns a constant theory when there are no observations", () => {
    const fitted = fitTheoryFromObservations(RANGES, []);
    expect(fitted.observationCount).toBe(0);
    expect(fitted.inSampleAccuracy).toBeNull();
    expect(fitted.theory.measurement).toEqual({ const: 0 });
    expect(fitted.theory.operator).toBe("gt");
    expect(fitted.theory.threshold).toBe(0);
    expect(scoreTheoryOnObservations(fitted.theory, [])).toBeNull();
  });

  it("counts an expression error as a wrong prediction", () => {
    const accuracy = scoreTheoryOnObservations(
      {
        measurement: { op: "div", left: { var: "a" }, right: { const: 0 } },
        operator: "gt",
        threshold: 0,
      },
      [row(1, 1, 1, false)],
    );
    expect(accuracy).toBe(0);
    expect(scoreTheoryOnObservations({ nope: true }, [row(1, 1, 1, false)])).toBeNull();
  });

  it("keeps only the constant candidates when the public ranges are not finite", () => {
    const missing: PublicRanges = {
      a: { min: Number.NaN, max: Number.NaN },
      b: { min: Number.NaN, max: Number.NaN },
      c: { min: Number.NaN, max: Number.NaN },
    };
    const fitted = fitTheoryFromObservations(missing, [row(1, 2, 3, true)]);
    expect(fitted.candidateCount).toBe(2);
    expect(fitted.theory.measurement).toEqual({ const: 0 });
  });
});
