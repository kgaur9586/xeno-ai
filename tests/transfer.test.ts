import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSeededRandom } from "../src/shared/random.js";
import { createWorldTools } from "../src/tools/world-tools.js";
import { refitTheory, type TransferRow, type TransferTheory } from "../src/transfer/refit.js";
import { buildTransferScenarios, driftTheory, glowTheory } from "../src/transfer/scenarios.js";
import { passes, runTransfer } from "../src/transfer/transfer.js";
import { DRIFT_WORLD } from "../src/worlds/drift-world.js";
import { GLOW_WORLD } from "../src/worlds/glow-world.js";
import { RING_WORLD } from "../src/worlds/ring-world.js";
import { createVariantWorld } from "../src/worlds/variants.js";

const EVALUATION = { inRangeSeed: 31, outOfRangeSeed: 47, caseCount: 200 };

function rowsFrom(names: string[], count: number, seed: number, outcome: (x: Record<string, number>) => boolean | number): TransferRow[] {
  const random = createSeededRandom(seed);
  return Array.from({ length: count }, () => {
    const inputs = Object.fromEntries(names.map((name) => [name, random() * 10]));
    return { inputs, outcome: outcome(inputs) };
  });
}

function ranges(names: string[]) {
  return Object.fromEntries(names.map((name) => [name, { min: 0, max: 10 }]));
}

describe("Variant worlds", () => {
  it("shifts a boundary without changing the public range", () => {
    const world = createVariantWorld(GLOW_WORLD, [{ kind: "shift", attribute: "a", offset: 2 }], "target-x");
    expect(world.spec.attributes.a).toEqual({ min: 0, max: 10 });
    expect(GLOW_WORLD.trueOutcome({ a: 6, b: 2, c: 0 })).toBe(true);
    expect(world.trueOutcome({ a: 6, b: 2, c: 0 })).toBe(false);
    expect(world.trueOutcome({ a: 8, b: 2, c: 0 })).toBe(true);
  });

  it("rescales an attribute and its public range", () => {
    const world = createVariantWorld(GLOW_WORLD, [{ kind: "rescale", attribute: "a", factor: 2 }], "target-x");
    expect(world.spec.attributes.a).toEqual({ min: 0, max: 20 });
    expect(world.trueOutcome({ a: 12, b: 2, c: 0 })).toBe(true);
    expect(world.trueOutcome({ a: 8, b: 2, c: 0 })).toBe(false);
  });

  it("renames attributes, including in the extrapolation profile", () => {
    const world = createVariantWorld(
      GLOW_WORLD,
      [
        { kind: "rename", from: "a", to: "m" },
        { kind: "rename", from: "b", to: "n" },
      ],
      "target-x",
    );
    expect(world.spec.attributeNames).toEqual(["m", "n", "c"]);
    expect(world.extrapolation.outsideAttributes).toEqual(["m"]);
    expect(world.extrapolation.extendedAttributes).toEqual(["n"]);
    expect(world.trueOutcome({ m: 8, n: 2, c: 0 })).toBe(true);
  });

  it("adds distractors the outcome ignores", () => {
    const world = createVariantWorld(DRIFT_WORLD, [{ kind: "add-distractors", names: ["z1", "z2"] }], "target-x");
    expect(world.spec.attributeNames).toEqual(["u", "v", "w", "x", "y", "z1", "z2"]);
    const inputs = { u: 3, v: 1, w: 0, x: 0, y: 0 };
    expect(world.trueOutcome({ ...inputs, z1: 0, z2: 0 })).toBe(world.trueOutcome({ ...inputs, z1: 9, z2: 7 }));
    expect(world.trueOutcome({ ...inputs, z1: 0, z2: 0 })).toBe(DRIFT_WORLD.trueOutcome(inputs));
  });

  it("changes the rule but keeps the base noise level", () => {
    const rule = { measurement: { op: "sub", left: { var: "p" }, right: { var: "q" } }, operator: "gt", threshold: 0 };
    const world = createVariantWorld(RING_WORLD, [{ kind: "change-rule", rule }], "target-x");
    expect(world.kind).toBe("boolean");
    expect(world.trueOutcome({ p: 6, q: 2, r: 0, s: 0 })).toBe(true);
    expect(world.trueOutcome({ p: 2, q: 6, r: 0, s: 0 })).toBe(false);
    if (world.kind === "boolean") {
      expect(world.flipRate).toBe(RING_WORLD.flipRate);
    }
    const random = createSeededRandom(5);
    const flips = Array.from({ length: 2000 }, () => world.observe({ p: 6, q: 2, r: 0, s: 0 }, random)).filter((lit) => !lit);
    expect(flips.length / 2000).toBeGreaterThan(0.03);
    expect(flips.length / 2000).toBeLessThan(0.07);
  });

  it("observes through the base world with the same noise stream", () => {
    const world = createVariantWorld(RING_WORLD, [{ kind: "shift", attribute: "q", offset: 2 }], "target-x");
    const first = createSeededRandom(9);
    const second = createSeededRandom(9);
    for (let step = 0; step < 50; step++) {
      expect(world.observe({ p: 7, q: 6, r: 1, s: 1 }, first)).toBe(RING_WORLD.observe({ p: 7, q: 4, r: 1, s: 1 }, second));
    }
  });

  it("shows only the opaque id to the tools", () => {
    for (const scenario of buildTransferScenarios()) {
      const description = JSON.stringify(createWorldTools(scenario.target).describeWorld());
      expect(scenario.target.spec.worldId).toMatch(/^transfer-target-\d+$/);
      expect(description).not.toMatch(/shift|rescale|rename|distract|rule|offset|factor|glow-world|ring-world|drift-world/i);
    }
  });

  it("rejects invalid steps", () => {
    expect(() => createVariantWorld(GLOW_WORLD, [], "glow-world")).toThrow();
    expect(() => createVariantWorld(GLOW_WORLD, [], "Has Spaces")).toThrow();
    expect(() => createVariantWorld(GLOW_WORLD, [{ kind: "shift", attribute: "z", offset: 1 }], "t")).toThrow();
    expect(() => createVariantWorld(GLOW_WORLD, [{ kind: "rescale", attribute: "a", factor: 0 }], "t")).toThrow();
    expect(() => createVariantWorld(GLOW_WORLD, [{ kind: "rename", from: "a", to: "b" }], "t")).toThrow();
    expect(() => createVariantWorld(GLOW_WORLD, [{ kind: "add-distractors", names: ["c"] }], "t")).toThrow();
    expect(() => createVariantWorld(GLOW_WORLD, [{ kind: "change-rule", rule: driftTheory() }], "t")).toThrow();
    expect(() => createVariantWorld(DRIFT_WORLD, [{ kind: "change-rule", rule: glowTheory() }], "t")).toThrow();
  });
});

describe("Refit", () => {
  it("maps renamed variables onto the new attributes", () => {
    const rows = rowsFrom(["m", "n", "o"], 40, 1, (x) => (x.m! - 5) * (x.n! - 5) < 0);
    const result = refitTheory(glowTheory(), { attributeNames: ["m", "n", "o"], ranges: ranges(["m", "n", "o"]), outcomeKind: "boolean" }, rows);
    expect(result?.mapping).toEqual({ a: "m", b: "n" });
    expect(result?.inSample).toBe(1);
    expect(JSON.stringify(result?.theory.measurement)).not.toMatch(/"var":"[abc]"/);
  });

  it("swaps variables when the identity fits worse", () => {
    const theory: TransferTheory = { measurement: { op: "sub", left: { var: "a" }, right: { var: "b" } }, operator: "gt", threshold: 0 };
    const rows = rowsFrom(["a", "b"], 40, 2, (x) => x.b! - x.a! > 0);
    const result = refitTheory(theory, { attributeNames: ["a", "b"], ranges: ranges(["a", "b"]), outcomeKind: "boolean" }, rows);
    expect(result?.mapping).toEqual({ a: "b", b: "a" });
    expect(result?.inSample).toBe(1);
  });

  it("keeps the identity and the old constants when they already fit", () => {
    const rows = rowsFrom(["a", "b", "c"], 40, 3, (x) => (x.a! - 5) * (x.b! - 5) < 0);
    const theory = glowTheory();
    const before = structuredClone(theory);
    const result = refitTheory(theory, { attributeNames: ["a", "b", "c"], ranges: ranges(["a", "b", "c"]), outcomeKind: "boolean" }, rows);
    expect(result?.mapping).toEqual({ a: "a", b: "b" });
    expect(result?.theory).toEqual(glowTheory());
    expect(theory).toEqual(before);
  });

  it("recovers shifted numeric constants exactly from noiseless rows", () => {
    const names = ["u", "v", "w", "x", "y"];
    const rows = rowsFrom(names, 20, 4, (x) => 2 * (x.u! - 2) - 3 * x.v! + 10);
    const result = refitTheory(driftTheory(), { attributeNames: names, ranges: ranges(names), outcomeKind: "number" }, rows);
    expect(result?.inSample).toBeLessThan(1e-6);
    expect(result?.mapping).toEqual({ u: "u", v: "v" });
  });

  it("returns null for the wrong outcome kind or too few attributes", () => {
    const rows = rowsFrom(["a"], 5, 5, () => true);
    expect(refitTheory(driftTheory(), { attributeNames: ["u", "v"], ranges: ranges(["u", "v"]), outcomeKind: "boolean" }, rows)).toBeNull();
    expect(refitTheory(glowTheory(), { attributeNames: ["a"], ranges: ranges(["a"]), outcomeKind: "boolean" }, rows)).toBeNull();
    expect(refitTheory({ measurement: "not a tree" }, { attributeNames: ["a"], ranges: ranges(["a"]), outcomeKind: "number" }, [])).toBeNull();
  });

  it("returns the theory unchanged when there are no observations", () => {
    const result = refitTheory(glowTheory(), { attributeNames: ["a", "b", "c"], ranges: ranges(["a", "b", "c"]), outcomeKind: "boolean" }, []);
    expect(result?.theory).toEqual(glowTheory());
    expect(result?.inSample).toBeNull();
  });

  it("reads no world, tools, or evaluator", () => {
    const source = readFileSync(new URL("../src/transfer/refit.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    for (const specifier of imports) {
      expect(specifier).toMatch(/^\.\.\/language\//);
    }
  });
});

describe("Transfer metrics on hand-built cases", () => {
  const scenarios = buildTransferScenarios();

  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))("%s", (_name, scenario) => {
    const report = runTransfer(scenario.source, scenario.target, scenario.theory, { evaluation: EVALUATION });
    expect(report.sourcePassed).toBe(true);
    expect(report.targetWorldId).toBe(scenario.target.spec.worldId);
    const { batchSize, maxExperiments } = report.adaptationOptions;

    if (scenario.expected === "unchanged") {
      expect(report.transfersUnchanged).toBe(true);
      expect(report.experimentsToAdapt).toBe(0);
      expect(report.experimentsRun).toBe(0);
      expect(report.steps).toEqual([]);
      expect(report.adaptedTheory).toEqual(scenario.theory);
      return;
    }

    expect(report.transfersUnchanged).toBe(false);
    expect(passes(report.unchanged)).toBe(false);
    if (scenario.expected === "adapts") {
      expect(report.experimentsToAdapt).not.toBeNull();
      expect(report.experimentsToAdapt).toBeGreaterThan(0);
      expect(report.experimentsToAdapt! % batchSize).toBe(0);
      expect(report.experimentsToAdapt).toBeLessThanOrEqual(maxExperiments);
      expect(passes(report.adaptedReport)).toBe(true);
      const last = report.steps.at(-1)!;
      expect(last.experiments).toBe(report.experimentsToAdapt);
      expect(last.inRangePassed && last.outOfRangePassed).toBe(true);
      for (const step of report.steps.slice(0, -1)) {
        expect(step.inRangePassed && step.outOfRangePassed).toBe(false);
      }
    } else {
      expect(report.experimentsToAdapt).toBeNull();
      expect(report.adaptedTheory).toBeNull();
      expect(report.experimentsRun).toBe(maxExperiments);
      expect(report.steps).toHaveLength(maxExperiments / batchSize);
      expect(report.steps.every((step) => !(step.inRangePassed && step.outOfRangePassed))).toBe(true);
    }
  });

  it("marks a renamed world as not applicable unchanged and adapts through the mapping", () => {
    const renamed = scenarios.find((scenario) => scenario.name.includes("renamed"))!;
    const report = runTransfer(renamed.source, renamed.target, renamed.theory, { evaluation: EVALUATION });
    expect(report.unchanged).toBeNull();
    expect(report.unchangedReason).toBe("UNKNOWN_ATTRIBUTE");
    expect(report.adaptedMapping).toEqual({ a: "m", b: "n" });
  });

  it("does not adapt a theory with the wrong outcome kind and runs no experiments", () => {
    const report = runTransfer(DRIFT_WORLD, GLOW_WORLD, driftTheory(), { evaluation: EVALUATION });
    expect(report.unchangedReason).toBe("OUTCOME_KIND_MISMATCH");
    expect(report.experimentsToAdapt).toBeNull();
    expect(report.experimentsRun).toBe(0);
  });

  it("reports a source failure honestly", () => {
    const wrong: TransferTheory = { measurement: { var: "a" }, operator: "gt", threshold: 5 };
    const target = createVariantWorld(GLOW_WORLD, [{ kind: "add-distractors", names: ["d"] }], "target-x");
    const report = runTransfer(GLOW_WORLD, target, wrong, { evaluation: EVALUATION, adaptation: { maxExperiments: 20 } });
    expect(report.sourcePassed).toBe(false);
    expect(report.transfersUnchanged).toBe(false);
  });

  it("is reproducible and counts experiments in whole batches", () => {
    const shifted = scenarios.find((scenario) => scenario.name.includes("Drift World, u shifted"))!;
    const first = runTransfer(shifted.source, shifted.target, shifted.theory, { evaluation: EVALUATION });
    const second = runTransfer(shifted.source, shifted.target, shifted.theory, { evaluation: EVALUATION });
    expect(second).toEqual(first);
    const coarse = runTransfer(shifted.source, shifted.target, shifted.theory, {
      evaluation: EVALUATION,
      adaptation: { batchSize: 25 },
    });
    expect(coarse.experimentsToAdapt! % 25).toBe(0);
  });

  it("rejects invalid adaptation options", () => {
    expect(() => runTransfer(GLOW_WORLD, GLOW_WORLD, glowTheory(), { evaluation: EVALUATION, adaptation: { batchSize: 0 } })).toThrow();
    expect(() => runTransfer(GLOW_WORLD, GLOW_WORLD, glowTheory(), { evaluation: EVALUATION, adaptation: { maxExperiments: 1.5 } })).toThrow();
  });
});

describe("Transfer isolation", () => {
  it("no agent or provider module imports the transfer code or the variants", () => {
    for (const directory of ["../src/agents/", "../src/llm/"]) {
      for (const file of readdirSync(new URL(directory, import.meta.url))) {
        const source = readFileSync(new URL(`${directory}${file}`, import.meta.url), "utf8");
        expect(source).not.toMatch(/transfer\/|variants/);
      }
    }
  });
});
