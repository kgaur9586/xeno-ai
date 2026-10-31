/**
 * Drift World: a numeric world with a linear rule and noisy measurements.
 *
 * Trusted code only. The rule constants are not exported. The noise level is
 * readable on the world object, which only the tools and the evaluator
 * receive. Agents reach this world only through the experiment tools.
 */
import { drawStandardNormal, type RandomSource } from "../shared/random.js";
import { uniformSpec, type NumericWorld, type WorldInputs } from "./world.js";

export const DRIFT_WORLD_ID = "drift-world";

// Private rule configuration. Deliberately not exported.
const U_WEIGHT = 2;
const V_WEIGHT = -3;
const OFFSET = 10;
const NOISE_STANDARD_DEVIATION = 0.5;

/** The noiseless level. `w`, `x`, and `y` have no effect. */
function trueLevel(inputs: WorldInputs): number {
  return U_WEIGHT * inputs.u! + V_WEIGHT * inputs.v! + OFFSET;
}

export const DRIFT_WORLD: NumericWorld = Object.freeze({
  kind: "number",
  spec: uniformSpec({
    worldId: DRIFT_WORLD_ID,
    attributeNames: ["u", "v", "w", "x", "y"],
    range: { min: 0, max: 10 },
    outcomeName: "level",
    outcomeKind: "number",
    noisy: true,
  }),
  trueOutcome(inputs: WorldInputs): number {
    return trueLevel(inputs);
  },
  observe(inputs: WorldInputs, random: RandomSource): number {
    return trueLevel(inputs) + NOISE_STANDARD_DEVIATION * drawStandardNormal(random);
  },
  noiseStandardDeviation: NOISE_STANDARD_DEVIATION,
  extrapolation: Object.freeze({
    outsideAttributes: Object.freeze(["u"]),
    extendedAttributes: Object.freeze(["v"]),
  }),
});
