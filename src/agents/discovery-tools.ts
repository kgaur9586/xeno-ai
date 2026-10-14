/**
 * Executes the three discovery tools.
 *
 * Experiment requests go through the existing experiment tools. Measurements
 * are validated and calculated by the existing language. Theories are
 * validated by the existing theory schema. Nothing here evaluates a theory
 * on held-out cases, and nothing is executed as JavaScript.
 */
import { z } from "zod";
import { evaluateExpression } from "../language/interpreter.js";
import { THEORY_ERROR, validateTheory, type ValidatedTheory } from "../language/theory.js";
import { parseExpressionJson, validateExpression } from "../language/validate.js";
import type { ExperimentTools } from "../tools/experiment-tools.js";
import type { Observation } from "../tools/schemas.js";
import {
  EVALUATE_MEASUREMENT_TOOL,
  RUN_EXPERIMENT_TOOL,
  SUBMIT_THEORY_TOOL,
} from "./discovery-tool-declarations.js";

/** Larger than one maximum expression so a theory envelope still fits. */
const MAX_TOOL_ARGUMENT_TEXT = 8192;

export const DISCOVERY_TOOL_ERROR = {
  UNKNOWN_TOOL: "Unknown tool.",
  INVALID_TOOL_ARGUMENTS: "Tool arguments are invalid.",
  NOT_EXECUTED: "This tool call was not executed because a theory was already accepted.",
} as const;

export interface DiscoveryToolSuccess {
  output: Record<string, unknown>;
  acceptedTheory?: ValidatedTheory;
}

const MeasurementArgsSchema = z.strictObject({
  expression: z.unknown(),
});

export function executeDiscoveryTool(
  name: string,
  args: unknown,
  tools: ExperimentTools,
): DiscoveryToolSuccess {
  try {
    const decoded = decodeArguments(args);
    if (decoded === undefined) {
      return failure("INVALID_TOOL_ARGUMENTS");
    }
    switch (name) {
      case RUN_EXPERIMENT_TOOL:
        return { output: asRecord(tools.runExperiment(decoded)) };
      case EVALUATE_MEASUREMENT_TOOL:
        return evaluateMeasurement(decoded, tools);
      case SUBMIT_THEORY_TOOL:
        return submitTheory(decoded);
      default:
        return failure("UNKNOWN_TOOL");
    }
  } catch {
    return failure("INVALID_TOOL_ARGUMENTS");
  }
}

export function notExecutedResult(): Record<string, unknown> {
  return {
    ok: false,
    error: { code: "NOT_EXECUTED", message: DISCOVERY_TOOL_ERROR.NOT_EXECUTED },
  };
}

function evaluateMeasurement(args: unknown, tools: ExperimentTools): DiscoveryToolSuccess {
  const parsed = MeasurementArgsSchema.safeParse(args);
  if (!parsed.success) {
    return failure("INVALID_TOOL_ARGUMENTS");
  }

  const expression =
    typeof parsed.data.expression === "string"
      ? parseExpressionJson(parsed.data.expression)
      : validateExpression(parsed.data.expression);
  if (!expression.ok) {
    return { output: asRecord(expression) };
  }

  const rows = tools.getObservationLog().map((observation) =>
    measurementRow(observation, expression.expression),
  );
  return { output: { ok: true, rows } };
}

function measurementRow(observation: Observation, expression: unknown): Record<string, unknown> {
  const row: Record<string, unknown> = {
    step: observation.step,
    inputs: {
      a: observation.inputs.a,
      b: observation.inputs.b,
      c: observation.inputs.c,
    },
    outcome: { glows: observation.outcome.glows },
  };
  const value = evaluateExpression(expression, observation.inputs);
  if (!value.ok) {
    row.error = { code: value.error.code, message: value.error.message };
    return row;
  }
  row.value = value.value;
  return row;
}

function submitTheory(args: unknown): DiscoveryToolSuccess {
  const validated = validateTheory(args);
  if (!validated.ok) {
    return { output: { ok: false, error: { code: THEORY_ERROR.code, message: THEORY_ERROR.message } } };
  }
  return {
    output: { ok: true, accepted: true },
    acceptedTheory: validated.theory,
  };
}

function decodeArguments(args: unknown): unknown {
  if (typeof args !== "string") {
    return args;
  }
  if (args.length > MAX_TOOL_ARGUMENT_TEXT) {
    return undefined;
  }
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return undefined;
  }
}

function failure(code: keyof typeof DISCOVERY_TOOL_ERROR): DiscoveryToolSuccess {
  return { output: { ok: false, error: { code, message: DISCOVERY_TOOL_ERROR[code] } } };
}

function asRecord(value: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
