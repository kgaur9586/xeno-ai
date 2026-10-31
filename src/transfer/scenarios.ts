/**
 * Hand-built transfer cases. Each pairs a base world, a variant of it, and a
 * hand-written source theory, with the outcome the case is meant to show.
 *
 * Operator-side only: the scenario names and theories describe hidden rules.
 * The variant ids are opaque so an agent shown a variant learns nothing from
 * its id.
 */
import { DRIFT_WORLD } from "../worlds/drift-world.js";
import { GLOW_WORLD } from "../worlds/glow-world.js";
import { RING_WORLD } from "../worlds/ring-world.js";
import { createVariantWorld, type VariantStep } from "../worlds/variants.js";
import type { World } from "../worlds/world.js";
import type { TransferTheory } from "./refit.js";

export type ExpectedTransfer = "unchanged" | "adapts" | "does-not-adapt";

export interface TransferScenario {
  name: string;
  source: World;
  target: World;
  theory: TransferTheory;
  expected: ExpectedTransfer;
}

const v = (name: string) => ({ var: name });
const k = (value: number) => ({ const: value });
const sub = (left: unknown, right: unknown) => ({ op: "sub", left, right });
const add = (left: unknown, right: unknown) => ({ op: "add", left, right });
const mul = (left: unknown, right: unknown) => ({ op: "mul", left, right });
const div = (left: unknown, right: unknown) => ({ op: "div", left, right });

/** Glow World's rule: the product is negative when exactly one of a, b is above the threshold. */
export function glowTheory(): TransferTheory {
  return { measurement: mul(sub(v("a"), k(5)), sub(v("b"), k(5))), operator: "lt", threshold: 0 };
}

export function ringTheory(): TransferTheory {
  return {
    measurement: add(mul(sub(v("p"), k(10)), sub(v("p"), k(10))), mul(sub(v("q"), k(5)), sub(v("q"), k(5)))),
    operator: "lt",
    threshold: 25,
  };
}

export function driftTheory(): TransferTheory {
  return { measurement: add(sub(mul(k(2), v("u")), mul(k(3), v("v"))), k(10)) };
}

function variant(base: World, steps: readonly VariantStep[], index: number): World {
  return createVariantWorld(base, steps, `transfer-target-${index}`);
}

export function buildTransferScenarios(): TransferScenario[] {
  const specs: Array<Omit<TransferScenario, "target"> & { steps: VariantStep[] }> = [
    {
      name: "Glow World, two distractors added",
      source: GLOW_WORLD,
      steps: [{ kind: "add-distractors", names: ["d", "e"] }],
      theory: glowTheory(),
      expected: "unchanged",
    },
    {
      name: "Glow World, threshold on a shifted by +2",
      source: GLOW_WORLD,
      steps: [{ kind: "shift", attribute: "a", offset: 2 }],
      theory: glowTheory(),
      expected: "adapts",
    },
    {
      name: "Glow World, a reported in units twice as small",
      source: GLOW_WORLD,
      steps: [{ kind: "rescale", attribute: "a", factor: 2 }],
      theory: glowTheory(),
      expected: "adapts",
    },
    {
      name: "Glow World, attributes renamed",
      source: GLOW_WORLD,
      steps: [
        { kind: "rename", from: "a", to: "m" },
        { kind: "rename", from: "b", to: "n" },
        { kind: "rename", from: "c", to: "o" },
      ],
      theory: glowTheory(),
      expected: "adapts",
    },
    {
      name: "Glow World, rule changed to a > b",
      source: GLOW_WORLD,
      steps: [{ kind: "change-rule", rule: { measurement: sub(v("a"), v("b")), operator: "gt", threshold: 0 } }],
      theory: glowTheory(),
      expected: "does-not-adapt",
    },
    {
      name: "Ring World, centre moved along q by +2",
      source: RING_WORLD,
      steps: [{ kind: "shift", attribute: "q", offset: 2 }],
      theory: ringTheory(),
      expected: "adapts",
    },
    {
      name: "Drift World, u shifted by +2",
      source: DRIFT_WORLD,
      steps: [{ kind: "shift", attribute: "u", offset: 2 }],
      theory: driftTheory(),
      expected: "adapts",
    },
    {
      name: "Drift World, rule changed to u * v / 2",
      source: DRIFT_WORLD,
      steps: [{ kind: "change-rule", rule: { measurement: div(mul(v("u"), v("v")), k(2)) } }],
      theory: driftTheory(),
      expected: "does-not-adapt",
    },
  ];
  return specs.map(({ steps, ...scenario }, index) => ({ ...scenario, target: variant(scenario.source, steps, index + 1) }));
}
