/**
 * Every failure in the measurement language is reported with one of these
 * fixed codes and its fixed message. Messages never echo user input, stack
 * traces, or internal values.
 */
export const LANGUAGE_ERROR_MESSAGES = {
  // Raw text input
  INPUT_TOO_LONG: "Expression text exceeds the maximum length.",
  INVALID_JSON: "Expression text is not valid JSON.",
  // Structure
  EXPRESSION_TOO_DEEP: "Expression exceeds the maximum depth.",
  EXPRESSION_TOO_LARGE: "Expression exceeds the maximum number of nodes.",
  TOO_MANY_ARGUMENTS: "A function call has too many arguments.",
  CYCLIC_EXPRESSION: "Expression contains a cycle or a reused node.",
  UNEXPECTED_FIELD: "Expression contains an unexpected field.",
  UNKNOWN_OPERATOR: "Expression uses an unknown operator.",
  UNKNOWN_FUNCTION: "Expression uses an unknown function.",
  UNKNOWN_VARIABLE: "Expression uses an unknown variable.",
  INVALID_EXPRESSION: "Expression does not match the measurement language.",
  // Evaluation
  INVALID_VARIABLES: "Variable values are invalid.",
  DIVISION_BY_ZERO: "Division by zero.",
  SQRT_OF_NEGATIVE: "Square root of a negative number.",
  LOG_OF_NON_POSITIVE: "Logarithm of zero or a negative number.",
  NON_FINITE_RESULT: "A calculation produced a non-finite result.",
} as const;

export type LanguageErrorCode = keyof typeof LANGUAGE_ERROR_MESSAGES;

export interface LanguageError {
  code: LanguageErrorCode;
  message: string;
}

export interface LanguageFailure {
  ok: false;
  error: LanguageError;
}

export function languageFailure(code: LanguageErrorCode): LanguageFailure {
  return { ok: false, error: { code, message: LANGUAGE_ERROR_MESSAGES[code] } };
}
