/**
 * Validation entry points. Every expression passes through the bounded
 * preflight first, then through the strict Zod schema.
 */
import { languageFailure, type LanguageFailure } from "./errors.js";
import { ExpressionSchema, MAX_EXPRESSION_JSON_LENGTH, type Expression } from "./expression.js";
import { preflightExpression } from "./preflight.js";

export type ValidationResult = { ok: true; expression: Expression } | LanguageFailure;

/** Validates an in-memory value. The returned expression is a fresh copy. */
export function validateExpression(input: unknown): ValidationResult {
  const preflight = preflightExpression(input);
  if (!preflight.ok) {
    return preflight;
  }
  const parsed = ExpressionSchema.safeParse(preflight.snapshot);
  if (!parsed.success) {
    return languageFailure("INVALID_EXPRESSION");
  }
  return { ok: true, expression: parsed.data };
}

/** Validates an expression supplied as JSON text, e.g. from an external source. */
export function parseExpressionJson(text: unknown): ValidationResult {
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
  return validateExpression(value);
}
