/**
 * Executes the three discovery tools.
 *
 * Experiment requests go through the existing experiment tools. Measurements
 * are validated and calculated by the existing language. Theories are
 * validated by the existing theory schemas: boolean for a boolean outcome,
 * numeric for a numeric one. Nothing here evaluates a theory on held-out
 * cases, and nothing is executed as JavaScript.
 */
import { z } from "zod";
import type { VariableSet } from "../language/expression.js";
import { evaluateExpression } from "../language/interpreter.js";
import { validateNumericTheory, type ValidatedNumericTheory } from "../language/numeric-theory.js";
import { THEORY_ERROR, validateTheory, type ValidatedTheory } from "../language/theory.js";
import { parseExpressionJson, validateExpression } from "../language/validate.js";
import type { AnyExperimentTools, AnyObservation } from "../tools/public-types.js";
import {
  EVALUATE_MEASUREMENT_TOOL,
  RUN_EXPERIMENT_TOOL,
  SUBMIT_THEORY_TOOL,
} from "./discovery-tool-declarations.js";
import { discoveryShapeOf, type DiscoveryWorldShape } from "./discovery-world.js";

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
  acceptedNumericTheory?: ValidatedNumericTheory;
}

const MeasurementArgsSchema = z.strictObject({
  expression: z.unknown(),
});

export function executeDiscoveryTool(
  name: string,
  args: unknown,
  tools: AnyExperimentTools,
): DiscoveryToolSuccess {
  try {
    const decoded = decodeArguments(args);
    if (decoded === undefined) {
      return failure("INVALID_TOOL_ARGUMENTS");
    }
    const shape = discoveryShapeOf(tools.describeWorld());
    switch (name) {
      case RUN_EXPERIMENT_TOOL:
        return { output: asRecord(tools.runExperiment(decoded)) };
      case EVALUATE_MEASUREMENT_TOOL:
        return evaluateMeasurement(decoded, tools, shape);
      case SUBMIT_THEORY_TOOL:
        return submitTheory(decoded, shape);
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

function evaluateMeasurement(
  args: unknown,
  tools: AnyExperimentTools,
  shape: DiscoveryWorldShape,
): DiscoveryToolSuccess {
  const parsed = MeasurementArgsSchema.safeParse(args);
  if (!parsed.success) {
    return failure("INVALID_TOOL_ARGUMENTS");
  }

  const expression =
    typeof parsed.data.expression === "string"
      ? parseExpressionJson(parsed.data.expression, shape.variables)
      : validateExpression(parsed.data.expression, shape.variables);
  if (!expression.ok) {
    return { output: asRecord(expression) };
  }

  const rows = tools
    .getObservationLog()
    .map((observation) => measurementRow(observation, expression.expression, shape));
  return { output: { ok: true, rows } };
}

function measurementRow(
  observation: AnyObservation,
  expression: unknown,
  shape: DiscoveryWorldShape,
): Record<string, unknown> {
  const inputs: Record<string, number> = {};
  for (const name of shape.variableNames) {
    inputs[name] = observation.inputs[name]!;
  }
  const row: Record<string, unknown> = {
    step: observation.step,
    inputs,
    outcome: { [shape.outcomeName]: observation.outcome[shape.outcomeName] },
  };
  const value = evaluateExpression(expression, inputs, shape.variables);
  if (!value.ok) {
    row.error = { code: value.error.code, message: value.error.message };
    return row;
  }
  row.value = value.value;
  return row;
}

function submitTheory(args: unknown, shape: DiscoveryWorldShape): DiscoveryToolSuccess {
  const invalid = { output: { ok: false, error: { code: THEORY_ERROR.code, message: THEORY_ERROR.message } } };
  if (shape.outcomeKind === "number") {
    const validated = validateNumericTheory(args, shape.variables);
    return validated.ok ? { output: { ok: true, accepted: true }, acceptedNumericTheory: validated.theory } : invalid;
  }
  const validated = validateTheory(args, shape.variables);
  return validated.ok ? { output: { ok: true, accepted: true }, acceptedTheory: validated.theory } : invalid;
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
