/**
 * Ring World: a boolean world with a curved boundary and noisy observations.
 *
 * Trusted code only. The rule constants are not exported. The noise level is
 * readable on the world object, which only the tools and the evaluator
 * receive. Agents reach this world only through the experiment tools.
 */
import type { RandomSource } from "../shared/random.js";
import { uniformSpec, type BooleanWorld, type WorldInputs } from "./world.js";

export const RING_WORLD_ID = "ring-world";

// Private rule configuration. Deliberately not exported.
const CENTER_P = 10;
const CENTER_Q = 5;
const RADIUS_SQUARED = 25;
const FLIP_RATE = 0.05;

/** Lit exactly when (p, q) is strictly inside the circle. `r` and `s` have no effect. */
function isLit(inputs: WorldInputs): boolean {
  const dp = inputs.p! - CENTER_P;
  const dq = inputs.q! - CENTER_Q;
  return dp * dp + dq * dq < RADIUS_SQUARED;
}

export const RING_WORLD: BooleanWorld = Object.freeze({
  kind: "boolean",
  spec: uniformSpec({
    worldId: RING_WORLD_ID,
    attributeNames: ["p", "q", "r", "s"],
    range: { min: 0, max: 10 },
    outcomeName: "lit",
    outcomeKind: "boolean",
    noisy: true,
  }),
  trueOutcome(inputs: WorldInputs): boolean {
    return isLit(inputs);
  },
  observe(inputs: WorldInputs, random: RandomSource): boolean {
    const lit = isLit(inputs);
    return random() < FLIP_RATE ? !lit : lit;
  },
  flipRate: FLIP_RATE,
  extrapolation: Object.freeze({
    outsideAttributes: Object.freeze(["p"]),
    extendedAttributes: Object.freeze(["q"]),
  }),
});
