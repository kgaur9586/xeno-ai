/**
 * A numeric theory predicts a numeric outcome directly: the predicted value is
 * its measurement. It reuses the same validator and interpreter as boolean
 * theories, so there is still only one expression engine.
 */
import { z } from "zod";
import { DEFAULT_VARIABLE_SET, type Expression, type VariableSet } from "./expression.js";
import { THEORY_ERROR, freezeExpression } from "./theory.js";
import { validateExpression } from "./validate.js";

export interface NumericTheory {
  measurement: Expression;
}

declare const validatedNumericTheoryBrand: unique symbol;
export type ValidatedNumericTheory = Readonly<NumericTheory> & {
  readonly [validatedNumericTheoryBrand]: true;
};

export type NumericTheoryValidationResult =
  | { ok: true; theory: ValidatedNumericTheory }
  | { ok: false; error: typeof THEORY_ERROR };

const NumericTheoryEnvelopeSchema = z.strictObject({
  measurement: z.unknown(),
});
const validatedNumericTheories = new WeakSet<object>();

/** Validates unknown input and returns an immutable, fresh numeric theory. */
export function validateNumericTheory(
  input: unknown,
  variables: VariableSet = DEFAULT_VARIABLE_SET,
): NumericTheoryValidationResult {
  try {
    const envelope = NumericTheoryEnvelopeSchema.safeParse(input);
    if (!envelope.success) {
      return invalidNumericTheory();
    }
    const measurement = validateExpression(envelope.data.measurement, variables);
    if (!measurement.ok) {
      return invalidNumericTheory();
    }
    const theory = Object.freeze({
      measurement: freezeExpression(measurement.expression),
    }) as ValidatedNumericTheory;
    validatedNumericTheories.add(theory);
    return { ok: true, theory };
  } catch {
    return invalidNumericTheory();
  }
}

export function isValidatedNumericTheory(input: unknown): input is ValidatedNumericTheory {
  return typeof input === "object" && input !== null && validatedNumericTheories.has(input);
}

function invalidNumericTheory(): NumericTheoryValidationResult {
  return { ok: false, error: { ...THEORY_ERROR } };
}
