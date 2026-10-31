/**
 * Public tool declarations for the discovery agent.
 *
 * These descriptions and JSON Schemas are safe to show to a model. They
 * describe the measurement language and the three tools for one world's
 * public attribute names and outcome kind. They do not describe the hidden
 * world rule, evaluation cases, seeds, or noise level.
 */
import {
  BINARY_OPERATORS,
  FUNCTION_NAMES,
  MAX_DEPTH,
  MAX_EXPRESSION_JSON_LENGTH,
  MAX_FUNCTION_ARGS,
  MAX_NODES,
  VARIABLE_NAMES,
} from "../language/expression.js";
import { COMPARISON_OPERATORS } from "../language/theory.js";
import type { LlmToolDeclaration } from "../llm/provider.js";

export const RUN_EXPERIMENT_TOOL = "run_experiment";
export const EVALUATE_MEASUREMENT_TOOL = "evaluate_measurement";
export const SUBMIT_THEORY_TOOL = "submit_theory";

export interface DiscoveryToolShape {
  variableNames: readonly string[];
  outcomeKind: "boolean" | "number";
}

export function buildDiscoveryToolDeclarations(shape: DiscoveryToolShape): readonly LlmToolDeclaration[] {
  const measurementDescription = describeMeasurement(shape.variableNames);
  const attributeProperties: Record<string, unknown> = {};
  for (const name of shape.variableNames) {
    attributeProperties[name] = { type: "number", description: `Attribute ${name} within its public range.` };
  }

  return [
    {
      name: RUN_EXPERIMENT_TOOL,
      description:
        `Run one experiment. Provide attributes ${listNames(shape.variableNames)}, each a finite number inside its public range, including the endpoints. Returns the observed outcome and the remaining experiment budget, or a fixed error. Invalid requests do not use budget.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: attributeProperties,
        required: [...shape.variableNames],
      },
    },
    {
      name: EVALUATE_MEASUREMENT_TOOL,
      description:
        "Validate a measurement and calculate it for every observation already collected. Does not run a new experiment and does not return hidden cases. " +
        measurementDescription,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          expression: {
            type: "object",
            additionalProperties: true,
            description: measurementDescription,
          },
        },
        required: ["expression"],
      },
    },
    shape.outcomeKind === "boolean" ? booleanTheoryTool(measurementDescription) : numericTheoryTool(measurementDescription),
  ];
}

/** Glow World's declarations. */
export const DISCOVERY_TOOL_DECLARATIONS: readonly LlmToolDeclaration[] = buildDiscoveryToolDeclarations({
  variableNames: VARIABLE_NAMES,
  outcomeKind: "boolean",
});

export const DISCOVERY_TOOL_NAMES = DISCOVERY_TOOL_DECLARATIONS.map((tool) => tool.name);

function booleanTheoryTool(measurementDescription: string): LlmToolDeclaration {
  return {
    name: SUBMIT_THEORY_TOOL,
    description:
      "Submit one theory and end the investigation when the theory is valid. A theory predicts that the boolean outcome is true when its measurement compares to a finite threshold. This tool does not return a score. " +
      measurementDescription,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        measurement: {
          type: "object",
          additionalProperties: true,
          description: measurementDescription,
        },
        operator: {
          type: "string",
          enum: [...COMPARISON_OPERATORS],
          description: "Comparison of the measurement to the threshold.",
        },
        threshold: { type: "number", description: "Finite number the measurement is compared with." },
      },
      required: ["measurement", "operator", "threshold"],
    },
  };
}

function numericTheoryTool(measurementDescription: string): LlmToolDeclaration {
  return {
    name: SUBMIT_THEORY_TOOL,
    description:
      "Submit one theory and end the investigation when the theory is valid. A numeric theory predicts the numeric outcome as the value of its measurement. This tool does not return a score. " +
      measurementDescription,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        measurement: {
          type: "object",
          additionalProperties: true,
          description: measurementDescription,
        },
      },
      required: ["measurement"],
    },
  };
}

function describeMeasurement(variableNames: readonly string[]): string {
  return [
    "A measurement is a JSON object, not JavaScript.",
    `Constant: {"const": <finite number>}.`,
    `Variable: {"var": ${variableNames.map((name) => `"${name}"`).join(" | ")}}.`,
    `Operation: {"op": ${BINARY_OPERATORS.map((op) => `"${op}"`).join(" | ")}, "left": <measurement>, "right": <measurement>}.`,
    `Function: {"fn": ${FUNCTION_NAMES.map((fn) => `"${fn}"`).join(" | ")}, "args": [<measurement>, ...]}.`,
    "abs, sqrt, and log take exactly one argument. min and max take 2 to " +
      `${MAX_FUNCTION_ARGS} arguments. log is the natural logarithm.`,
    `Limits: depth ${MAX_DEPTH}, ${MAX_NODES} nodes, and ${MAX_EXPRESSION_JSON_LENGTH} characters of JSON text.`,
    "Each node has exactly the fields of one of these shapes.",
  ].join(" ");
}

function listNames(names: readonly string[]): string {
  if (names.length === 1) {
    return names[0]!;
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}
