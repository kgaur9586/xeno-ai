/**
 * A theory combines one validated measurement with a numeric comparison.
 *
 * The measurement remains an expression AST: theories do not introduce a
 * second expression language or execute generated JavaScript.
 */
import { z } from "zod";
import type { Expression } from "./expression.js";
import { validateExpression } from "./validate.js";

export const COMPARISON_OPERATORS = ["lt", "lte", "gt", "gte"] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

export interface Theory {
  measurement: Expression;
  operator: ComparisonOperator;
  threshold: number;
}

declare const validatedTheoryBrand: unique symbol;
export type ValidatedTheory = Readonly<Theory> & {
  readonly [validatedTheoryBrand]: true;
};

export interface TheoryComplexity {
  nodeCount: number;
  depth: number;
}

export const THEORY_ERROR = {
  code: "INVALID_THEORY",
  message: "Theory does not match the theory language.",
} as const;

export type TheoryValidationResult =
  | { ok: true; theory: ValidatedTheory }
  | { ok: false; error: typeof THEORY_ERROR };

// The outer object is strict. The existing expression validator performs the
// bounded preflight and strict recursive Zod validation of `measurement`.
const TheoryEnvelopeSchema = z.strictObject({
  measurement: z.unknown(),
  operator: z.enum(COMPARISON_OPERATORS),
  threshold: z.number(),
});
const validatedTheories = new WeakSet<object>();

/**
 * Validates unknown input and returns an immutable, fresh theory.
 *
 * A single fixed failure avoids echoing untrusted theory contents or detailed
 * parser information across a future agent boundary.
 */
export function validateTheory(input: unknown): TheoryValidationResult {
  try {
    const envelope = TheoryEnvelopeSchema.safeParse(input);
    if (!envelope.success) {
      return invalidTheory();
    }

    const measurement = validateExpression(envelope.data.measurement);
    if (!measurement.ok) {
      return invalidTheory();
    }

    const theory = Object.freeze({
      measurement: freezeExpression(measurement.expression),
      operator: envelope.data.operator,
      threshold: envelope.data.threshold,
    }) as ValidatedTheory;
    validatedTheories.add(theory);
    return { ok: true, theory };
  } catch {
    return invalidTheory();
  }
}

/** Runtime guard used by trusted consumers that must reject forged objects. */
export function isValidatedTheory(input: unknown): input is ValidatedTheory {
  return typeof input === "object" && input !== null && validatedTheories.has(input);
}

/** Counts expression AST nodes and its longest root-to-leaf path. */
export function measureTheoryComplexity(theory: ValidatedTheory): TheoryComplexity {
  let nodeCount = 0;
  let depth = 0;
  const pending: Array<{ node: Expression; depth: number }> = [
    { node: theory.measurement, depth: 1 },
  ];

  while (pending.length > 0) {
    const current = pending.pop()!;
    nodeCount++;
    depth = Math.max(depth, current.depth);

    if ("op" in current.node) {
      pending.push(
        { node: current.node.left, depth: current.depth + 1 },
        { node: current.node.right, depth: current.depth + 1 },
      );
    } else if ("fn" in current.node) {
      for (const argument of current.node.args) {
        pending.push({ node: argument, depth: current.depth + 1 });
      }
    }
  }

  return { nodeCount, depth };
}

function freezeExpression(expression: Expression): Expression {
  if ("op" in expression) {
    freezeExpression(expression.left);
    freezeExpression(expression.right);
  } else if ("fn" in expression) {
    for (const argument of expression.args) {
      freezeExpression(argument);
    }
    Object.freeze(expression.args);
  }
  return Object.freeze(expression);
}

function invalidTheory(): TheoryValidationResult {
  return { ok: false, error: { ...THEORY_ERROR } };
}
