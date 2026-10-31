/**
 * The common contract for world engines.
 *
 * A world object is trusted. It is handed only to the generic experiment
 * tools and to the evaluator, never to an agent. `spec` is public. The rule,
 * the noise level, and the evaluation profile are private: tools must never
 * copy them into a response.
 */
import type { RandomSource } from "../shared/random.js";

export interface AttributeRange {
  readonly min: number;
  readonly max: number;
}

export type WorldInputs = Readonly<Record<string, number>>;

/** Facts that are safe to show to an agent. */
export interface WorldSpec {
  readonly worldId: string;
  /** Attribute names in their documented order. */
  readonly attributeNames: readonly string[];
  readonly attributes: Readonly<Record<string, AttributeRange>>;
  readonly outcomeName: string;
  readonly outcomeKind: "boolean" | "number";
  /** Whether observations are imprecise. The amount of noise stays private. */
  readonly noisy: boolean;
}

/**
 * Evaluator-only information about how to build extrapolation cases.
 * `outsideAttributes` are always drawn outside their public range;
 * `extendedAttributes` are drawn from one range-width beyond each side;
 * every other attribute stays in its public range.
 */
export interface ExtrapolationProfile {
  readonly outsideAttributes: readonly string[];
  readonly extendedAttributes: readonly string[];
}

export interface BooleanWorld {
  readonly kind: "boolean";
  readonly spec: WorldSpec;
  /** The noiseless outcome. Inputs are assumed valid. */
  trueOutcome(inputs: WorldInputs): boolean;
  /** One noisy observation. Consumes one value from `random` when the world is noisy, none otherwise. */
  observe(inputs: WorldInputs, random: RandomSource): boolean;
  /** Private. The probability that an observation reports the opposite outcome. */
  readonly flipRate: number;
  readonly extrapolation: ExtrapolationProfile;
}

export interface NumericWorld {
  readonly kind: "number";
  readonly spec: WorldSpec;
  /** The noiseless outcome. Inputs are assumed valid. */
  trueOutcome(inputs: WorldInputs): number;
  /** One noisy observation. Consumes two values from `random` when the world is noisy, none otherwise. */
  observe(inputs: WorldInputs, random: RandomSource): number;
  /** Private. Standard deviation of the additive Gaussian measurement noise. */
  readonly noiseStandardDeviation: number;
  readonly extrapolation: ExtrapolationProfile;
}

export type World = BooleanWorld | NumericWorld;

/** Builds a frozen public spec with every attribute sharing one range. */
export function uniformSpec(options: {
  worldId: string;
  attributeNames: readonly string[];
  range: AttributeRange;
  outcomeName: string;
  outcomeKind: "boolean" | "number";
  noisy: boolean;
}): WorldSpec {
  const attributes: Record<string, AttributeRange> = {};
  for (const name of options.attributeNames) {
    attributes[name] = Object.freeze({ min: options.range.min, max: options.range.max });
  }
  return Object.freeze({
    worldId: options.worldId,
    attributeNames: Object.freeze([...options.attributeNames]),
    attributes: Object.freeze(attributes),
    outcomeName: options.outcomeName,
    outcomeKind: options.outcomeKind,
    noisy: options.noisy,
  });
}
