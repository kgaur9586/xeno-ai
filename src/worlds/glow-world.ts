/**
 * Glow World: the world engine for XENO's first hidden-rule simulation.
 *
 * This is the ONLY module that knows the hidden rule. It is trusted code and
 * must never be handed to the agent. The agent interacts with this world only
 * through the experiment tools in `src/tools/`.
 */

/** Public facts about the world. These are safe to show to the agent. */
export const GLOW_WORLD_ID = "glow-world";
export const ATTRIBUTE_MIN = 0;
export const ATTRIBUTE_MAX = 10;

export interface GlowInputs {
  a: number;
  b: number;
  c: number;
}

export interface GlowOutcome {
  glows: boolean;
}

// Private rule configuration. Deliberately not exported.
const HIDDEN_THRESHOLD = 5;

/**
 * Computes the outcome of one experiment.
 *
 * Trusted callers only: inputs are assumed to be validated already (the
 * experiment tools validate agent input; the evaluator generates valid input).
 * The result depends only on the inputs, so the same inputs always produce
 * the same outcome.
 */
export function computeGlowOutcome(inputs: GlowInputs): GlowOutcome {
  const aAbove = inputs.a > HIDDEN_THRESHOLD;
  const aBelow = inputs.a < HIDDEN_THRESHOLD;
  const bAbove = inputs.b > HIDDEN_THRESHOLD;
  const bBelow = inputs.b < HIDDEN_THRESHOLD;

  // A value exactly at the threshold is neither above nor below, so it never glows.
  const glows = (aAbove && bBelow) || (aBelow && bAbove);
  return { glows };
}
