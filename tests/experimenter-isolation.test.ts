import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runBaseline } from "../src/agents/baseline-runner.js";
import type { Experimenter, ExperimenterContext } from "../src/agents/experimenter.js";
import { createRandomExplorer } from "../src/agents/random-explorer.js";
import { createSystematicExplorer, planGrid } from "../src/agents/systematic-explorer.js";
import type { ExperimentTools } from "../src/tools/experiment-tools.js";
import type { ErrorCode, ExperimentResult, Observation, PublicDescription } from "../src/tools/schemas.js";

const EXPERIMENTER_SOURCES = [
  "../src/agents/experimenter.ts",
  "../src/agents/random-explorer.ts",
  "../src/agents/systematic-explorer.ts",
];

const explorers: Array<[string, () => Experimenter]> = [
  ["random explorer", () => createRandomExplorer({ seed: 11 })],
  ["systematic explorer", () => createSystematicExplorer()],
];

const STUB_DESCRIPTION: PublicDescription = {
  worldId: "glow-world",
  attributes: { a: { min: 1, max: 3 }, b: { min: 1, max: 3 }, c: { min: 1, max: 3 } },
  outcome: { glows: "boolean" },
  experimentBudget: 12,
};

/**
 * Fake tools with an invented rule (glows when c > 2) and no world engine
 * behind them. Optionally refuses every request with a given error code.
 */
function createStubTools(budget: number, refuseWith?: ErrorCode) {
  const requests: unknown[] = [];
  const log: Observation[] = [];
  const tools: ExperimentTools = {
    describeWorld: () => structuredClone(STUB_DESCRIPTION),
    runExperiment(request): ExperimentResult {
      requests.push(request);
      if (refuseWith) {
        return { ok: false, error: { code: refuseWith, message: "stub refusal" } };
      }
      const inputs = request as { a: number; b: number; c: number };
      const observation: Observation = {
        step: log.length + 1,
        inputs: { a: inputs.a, b: inputs.b, c: inputs.c },
        outcome: { glows: inputs.c > 2 },
        remainingBudget: budget - (log.length + 1),
      };
      log.push(observation);
      return { ok: true, observation: structuredClone(observation) };
    },
    getObservationLog: () => structuredClone(log),
    // A refusing stub keeps claiming budget remains, to prove explorers still stop.
    getRemainingBudget: () => (refuseWith ? budget : budget - log.length),
  };
  return { tools, requests, log };
}

describe("Experimenters only depend on public types and shared utilities", () => {
  it.each(EXPERIMENTER_SOURCES)("%s never imports the world engine or the evaluator", (path) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => ({
      typeOnly: Boolean(match[1]),
      specifier: match[2]!,
    }));

    expect(imports.length).toBeGreaterThan(0);
    for (const { typeOnly, specifier } of imports) {
      expect(specifier).not.toMatch(/worlds|evaluator/);
      if (specifier.startsWith("../tools/")) {
        // Types vanish at runtime, so tool modules are never loaded by an experimenter.
        expect(typeOnly, `${specifier} must be a type-only import`).toBe(true);
      } else {
        expect(["./experimenter.js", "../shared/random.js"]).toContain(specifier);
      }
    }
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });
});

describe("The runner gives experimenters only public information", () => {
  it("passes a context with exactly a public description and the four tool methods", () => {
    let seen: ExperimenterContext | undefined;
    const spy: Experimenter = {
      name: "spy",
      run(context) {
        seen = context;
      },
    };
    runBaseline(spy);

    expect(seen).toBeDefined();
    expect(Object.keys(seen!).sort()).toEqual(["description", "tools"]);
    expect(Object.keys(seen!.tools).sort()).toEqual(
      ["describeWorld", "getObservationLog", "getRemainingBudget", "runExperiment"],
    );
    expect(seen!.description).toStrictEqual({
      worldId: "glow-world",
      attributes: { a: { min: 0, max: 10 }, b: { min: 0, max: 10 }, c: { min: 0, max: 10 } },
      outcome: { glows: "boolean" },
      experimentBudget: 30,
    });
  });
});

describe("Experimenters work through the tool contract alone", () => {
  it("the random explorer runs unchanged against stub tools with a different rule and ranges", () => {
    const { tools, requests, log } = createStubTools(12);
    createRandomExplorer({ seed: 11 }).run({ description: STUB_DESCRIPTION, tools });

    expect(requests).toHaveLength(12);
    for (const { inputs } of log) {
      for (const value of [inputs.a, inputs.b, inputs.c]) {
        expect(value).toBeGreaterThanOrEqual(1);
        expect(value).toBeLessThanOrEqual(3);
      }
    }
  });

  it("the systematic explorer runs its stub-derived grid against stub tools", () => {
    const { tools, requests } = createStubTools(30);
    createSystematicExplorer().run({ description: STUB_DESCRIPTION, tools });
    expect(requests).toEqual(planGrid(STUB_DESCRIPTION));
  });

  it.each(explorers)("the %s stops after one INVALID_INPUT refusal", (_label, create) => {
    const { tools, requests } = createStubTools(12, "INVALID_INPUT");
    create().run({ description: STUB_DESCRIPTION, tools });
    expect(requests).toHaveLength(1);
  });

  it.each(explorers)("the %s stops after one BUDGET_EXHAUSTED refusal", (_label, create) => {
    const { tools, requests } = createStubTools(12, "BUDGET_EXHAUSTED");
    create().run({ description: STUB_DESCRIPTION, tools });
    expect(requests).toHaveLength(1);
  });
});
