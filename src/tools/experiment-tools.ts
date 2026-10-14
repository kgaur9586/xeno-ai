/**
 * Agent-facing experiment tools: the only door between the agent and the world.
 *
 * Responsibilities:
 * - validate every request with strict Zod schemas,
 * - enforce the experiment budget,
 * - record accepted experiments in the observation log,
 * - return fresh copies containing only the documented fields,
 * - report failures with fixed error codes and messages.
 */
import {
  ATTRIBUTE_MAX,
  ATTRIBUTE_MIN,
  GLOW_WORLD_ID,
  computeGlowOutcome,
} from "../worlds/glow-world.js";
import {
  ERROR_MESSAGES,
  ExperimentInputSchema,
  type ErrorCode,
  type ExperimentError,
  type ExperimentResult,
  type Observation,
  type PublicDescription,
} from "./schemas.js";

export const DEFAULT_EXPERIMENT_BUDGET = 30;

export interface ExperimentToolsOptions {
  budget?: number;
}

export interface ExperimentTools {
  describeWorld(): PublicDescription;
  runExperiment(request: unknown): ExperimentResult;
  getObservationLog(): Observation[];
  getRemainingBudget(): number;
}

export function createExperimentTools(options: ExperimentToolsOptions = {}): ExperimentTools {
  const budget = options.budget ?? DEFAULT_EXPERIMENT_BUDGET;
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error("Experiment budget must be a positive integer.");
  }

  // Private state: reachable only through the functions below.
  const log: Observation[] = [];

  function remainingBudget(): number {
    return budget - log.length;
  }

  return {
    describeWorld() {
      return buildPublicDescription(budget);
    },

    runExperiment(request) {
      if (remainingBudget() === 0) {
        return errorResult("BUDGET_EXHAUSTED");
      }

      let parsed;
      try {
        parsed = ExperimentInputSchema.safeParse(request);
      } catch {
        // e.g. a request object whose property getter throws.
        return errorResult("INVALID_INPUT");
      }
      if (!parsed.success) {
        return errorResult("INVALID_INPUT");
      }

      const inputs = { a: parsed.data.a, b: parsed.data.b, c: parsed.data.c };
      const outcome = computeGlowOutcome(inputs);
      const step = log.length + 1;
      const observation: Observation = {
        step,
        inputs,
        outcome: { glows: outcome.glows },
        remainingBudget: budget - step,
      };
      log.push(observation);

      return { ok: true, observation: copyObservation(observation) };
    },

    getObservationLog() {
      return log.map(copyObservation);
    },

    getRemainingBudget() {
      return remainingBudget();
    },
  };
}

function buildPublicDescription(budget: number): PublicDescription {
  return {
    worldId: GLOW_WORLD_ID,
    attributes: {
      a: { min: ATTRIBUTE_MIN, max: ATTRIBUTE_MAX },
      b: { min: ATTRIBUTE_MIN, max: ATTRIBUTE_MAX },
      c: { min: ATTRIBUTE_MIN, max: ATTRIBUTE_MAX },
    },
    outcome: { glows: "boolean" },
    experimentBudget: budget,
  };
}

function copyObservation(observation: Observation): Observation {
  return {
    step: observation.step,
    inputs: { a: observation.inputs.a, b: observation.inputs.b, c: observation.inputs.c },
    outcome: { glows: observation.outcome.glows },
    remainingBudget: observation.remainingBudget,
  };
}

function errorResult(code: ErrorCode): ExperimentError {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code] } };
}
