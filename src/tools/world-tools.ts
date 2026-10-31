/**
 * Generic agent-facing experiment tools for any world.
 *
 * Same contract as the Glow World tools: strict validation, a budget, an
 * observation log, fresh copies with only documented fields, and fixed
 * errors. Noise comes from a private seeded stream. A rejected request uses
 * no budget and draws no noise, so the same seed and the same accepted
 * requests always reproduce the same observations.
 */
import { createSeededRandom } from "../shared/random.js";
import { getWorld } from "../worlds/registry.js";
import type { World } from "../worlds/world.js";
import { ERROR_MESSAGES, type ErrorCode } from "./schemas.js";
import {
  createWorldSchemas,
  type WorldDescription,
  type WorldExperimentResult,
  type WorldObservation,
} from "./world-schemas.js";

export const DEFAULT_WORLD_BUDGET = 30;
export const DEFAULT_NOISE_SEED = 1;

export interface WorldToolsOptions {
  budget?: number;
  /** Private. Never returned by any tool. */
  noiseSeed?: number;
}

export interface WorldTools {
  describeWorld(): WorldDescription;
  runExperiment(request: unknown): WorldExperimentResult;
  getObservationLog(): WorldObservation[];
  getRemainingBudget(): number;
}

export function createWorldTools(world: World, options: WorldToolsOptions = {}): WorldTools {
  const budget = options.budget ?? DEFAULT_WORLD_BUDGET;
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error("Experiment budget must be a positive integer.");
  }
  const noise = createSeededRandom(options.noiseSeed ?? DEFAULT_NOISE_SEED);
  const spec = world.spec;
  const schemas = createWorldSchemas(spec);

  // Private state: reachable only through the functions below.
  const log: WorldObservation[] = [];

  function remainingBudget(): number {
    return budget - log.length;
  }

  return {
    describeWorld() {
      return buildDescription(world, budget);
    },

    runExperiment(request) {
      if (remainingBudget() === 0) {
        return errorResult("BUDGET_EXHAUSTED");
      }

      let parsed;
      try {
        parsed = schemas.input.safeParse(request);
      } catch {
        return errorResult("INVALID_INPUT");
      }
      if (!parsed.success) {
        return errorResult("INVALID_INPUT");
      }

      const inputs: Record<string, number> = {};
      for (const name of spec.attributeNames) {
        inputs[name] = parsed.data[name]!;
      }
      const value = world.observe(inputs, noise);
      const step = log.length + 1;
      const observation: WorldObservation = {
        step,
        inputs,
        outcome: { [spec.outcomeName]: value },
        remainingBudget: budget - step,
      };
      log.push(observation);

      return { ok: true, observation: copyObservation(observation, world) };
    },

    getObservationLog() {
      return log.map((observation) => copyObservation(observation, world));
    },

    getRemainingBudget() {
      return remainingBudget();
    },
  };
}

/** Opens tools for a registered world, so callers never handle the world object. */
export function createWorldToolsById(worldId: string, options: WorldToolsOptions = {}): WorldTools {
  const world = getWorld(worldId);
  if (world === undefined) {
    throw new Error("Unknown world.");
  }
  return createWorldTools(world, options);
}

function buildDescription(world: World, budget: number): WorldDescription {
  const spec = world.spec;
  const attributes: Record<string, { min: number; max: number }> = {};
  for (const name of spec.attributeNames) {
    const range = spec.attributes[name]!;
    attributes[name] = { min: range.min, max: range.max };
  }
  return {
    worldId: spec.worldId,
    attributes,
    outcome: { [spec.outcomeName]: spec.outcomeKind },
    observationNoise: spec.noisy ? "present" : "none",
    experimentBudget: budget,
  };
}

function copyObservation(observation: WorldObservation, world: World): WorldObservation {
  const inputs: Record<string, number> = {};
  for (const name of world.spec.attributeNames) {
    inputs[name] = observation.inputs[name]!;
  }
  const name = world.spec.outcomeName;
  return {
    step: observation.step,
    inputs,
    outcome: { [name]: observation.outcome[name]! },
    remainingBudget: observation.remainingBudget,
  };
}

function errorResult(code: ErrorCode): WorldExperimentResult {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code] } };
}
