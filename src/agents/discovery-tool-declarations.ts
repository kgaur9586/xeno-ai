/**
 * Public tool declarations for the discovery agent.
 *
 * These descriptions and JSON Schemas are safe to show to a model. They
 * describe the measurement language and the three tools. They do not describe
 * the hidden world rule, evaluation cases, or seeds.
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

const MEASUREMENT_DESCRIPTION = [
  "A measurement is a JSON object, not JavaScript.",
  `Constant: {"const": <finite number>}.`,
  `Variable: {"var": ${VARIABLE_NAMES.map((name) => `"${name}"`).join(" | ")}}.`,
  `Operation: {"op": ${BINARY_OPERATORS.map((op) => `"${op}"`).join(" | ")}, "left": <measurement>, "right": <measurement>}.`,
  `Function: {"fn": ${FUNCTION_NAMES.map((fn) => `"${fn}"`).join(" | ")}, "args": [<measurement>, ...]}.`,
  "abs, sqrt, and log take exactly one argument. min and max take 2 to " +
    `${MAX_FUNCTION_ARGS} arguments. log is the natural logarithm.`,
  `Limits: depth ${MAX_DEPTH}, ${MAX_NODES} nodes, and ${MAX_EXPRESSION_JSON_LENGTH} characters of JSON text.`,
  "Each node has exactly the fields of one of these shapes.",
].join(" ");

export const RUN_EXPERIMENT_TOOL = "run_experiment";
export const EVALUATE_MEASUREMENT_TOOL = "evaluate_measurement";
export const SUBMIT_THEORY_TOOL = "submit_theory";

export const DISCOVERY_TOOL_DECLARATIONS: readonly LlmToolDeclaration[] = [
  {
    name: RUN_EXPERIMENT_TOOL,
    description:
      "Run one experiment. Provide attributes a, b, and c, each a finite number inside its public range, including the endpoints. Returns the observed outcome and the remaining experiment budget, or a fixed error. Invalid requests do not use budget.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        a: { type: "number", description: "Attribute a within its public range." },
        b: { type: "number", description: "Attribute b within its public range." },
        c: { type: "number", description: "Attribute c within its public range." },
      },
      required: ["a", "b", "c"],
    },
  },
  {
    name: EVALUATE_MEASUREMENT_TOOL,
    description:
      "Validate a measurement and calculate it for every observation already collected. Does not run a new experiment and does not return hidden cases. " +
      MEASUREMENT_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        expression: {
          type: "object",
          additionalProperties: true,
          description: MEASUREMENT_DESCRIPTION,
        },
      },
      required: ["expression"],
    },
  },
  {
    name: SUBMIT_THEORY_TOOL,
    description:
      "Submit one theory and end the investigation when the theory is valid. A theory predicts that the boolean outcome is true when its measurement compares to a finite threshold. This tool does not return a score. " +
      MEASUREMENT_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        measurement: {
          type: "object",
          additionalProperties: true,
          description: MEASUREMENT_DESCRIPTION,
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
  },
];

export const DISCOVERY_TOOL_NAMES = DISCOVERY_TOOL_DECLARATIONS.map((tool) => tool.name);
