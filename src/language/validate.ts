/**
 * Validation entry points. Every expression passes through the bounded
 * preflight first, then through the strict Zod schema.
 */
import { languageFailure, type LanguageFailure } from "./errors.js";
import {
  DEFAULT_VARIABLE_SET,
  MAX_EXPRESSION_JSON_LENGTH,
  expressionSchemaFor,
  type Expression,
  type VariableSet,
} from "./expression.js";
import { preflightExpression } from "./preflight.js";

export type ValidationResult = { ok: true; expression: Expression } | LanguageFailure;

/**
 * Validates an in-memory value. The returned expression is a fresh copy.
 * `variables` defaults to Glow World's `a`, `b`, `c`.
 */
export function validateExpression(
  input: unknown,
  variables: VariableSet = DEFAULT_VARIABLE_SET,
): ValidationResult {
  const preflight = preflightExpression(input, variables);
  if (!preflight.ok) {
    return preflight;
  }
  const parsed = expressionSchemaFor(variables).safeParse(preflight.snapshot);
  if (!parsed.success) {
    return languageFailure("INVALID_EXPRESSION");
  }
  return { ok: true, expression: parsed.data };
}

/** Validates an expression supplied as JSON text, e.g. from an external source. */
export function parseExpressionJson(
  text: unknown,
  variables: VariableSet = DEFAULT_VARIABLE_SET,
): ValidationResult {
  if (typeof text !== "string") {
    return languageFailure("INVALID_JSON");
  }
  if (text.length > MAX_EXPRESSION_JSON_LENGTH) {
    return languageFailure("INPUT_TOO_LONG");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return languageFailure("INVALID_JSON");
  }
  return validateExpression(value, variables);
}
