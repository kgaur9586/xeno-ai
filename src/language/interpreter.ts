/**
 * Safe interpreter for the measurement language.
 *
 * It walks a validated expression tree and computes a number. Each allowed
 * operation is implemented explicitly below; nothing is ever turned into
 * JavaScript code. It reads only the expression and the variable values it is
 * given.
 */
import { languageFailure, type LanguageErrorCode, type LanguageFailure } from "./errors.js";
import { VariableValuesSchema, type Expression, type VariableValues } from "./expression.js";
import { validateExpression } from "./validate.js";

export type EvaluationResult = { ok: true; value: number } | LanguageFailure;

/**
 * Validates `expression` and `variables`, then computes the expression's value.
 * Never throws for bad input; failures are returned as fixed error codes.
 */
export function evaluateExpression(expression: unknown, variables: unknown): EvaluationResult {
  const validated = validateExpression(expression);
  if (!validated.ok) {
    return validated;
  }

  let values: VariableValues;
  try {
    const parsed = VariableValuesSchema.safeParse(variables);
    if (!parsed.success) {
      return languageFailure("INVALID_VARIABLES");
    }
    values = parsed.data;
  } catch {
    return languageFailure("INVALID_VARIABLES");
  }

  try {
    return { ok: true, value: evaluateNode(validated.expression, values) };
  } catch (error) {
    if (error instanceof EvaluationFailure) {
      return languageFailure(error.code);
    }
    throw error;
  }
}

class EvaluationFailure extends Error {
  constructor(readonly code: LanguageErrorCode) {
    super(code);
  }
}

// Recursion is safe here: preflight already limited the tree to MAX_DEPTH levels.
function evaluateNode(node: Expression, values: VariableValues): number {
  if ("const" in node) {
    return node.const;
  }
  if ("var" in node) {
    return values[node.var];
  }
  if ("op" in node) {
    const left = evaluateNode(node.left, values);
    const right = evaluateNode(node.right, values);
    switch (node.op) {
      case "add":
        return finite(left + right);
      case "sub":
        return finite(left - right);
      case "mul":
        return finite(left * right);
      case "div":
        if (right === 0) {
          throw new EvaluationFailure("DIVISION_BY_ZERO");
        }
        return finite(left / right);
    }
  }

  const args = node.args.map((arg) => evaluateNode(arg, values));
  switch (node.fn) {
    case "abs":
      return finite(Math.abs(args[0]!));
    case "sqrt":
      if (args[0]! < 0) {
        throw new EvaluationFailure("SQRT_OF_NEGATIVE");
      }
      return finite(Math.sqrt(args[0]!));
    case "log":
      if (args[0]! <= 0) {
        throw new EvaluationFailure("LOG_OF_NON_POSITIVE");
      }
      return finite(Math.log(args[0]!));
    case "min":
      return finite(Math.min(...args));
    case "max":
      return finite(Math.max(...args));
  }
}

function finite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new EvaluationFailure("NON_FINITE_RESULT");
  }
  return value;
}
