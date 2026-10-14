/**
 * Preflight: a bounded, non-recursive safety pass that runs BEFORE schema
 * validation or evaluation.
 *
 * Recursive code can crash with a stack overflow on a maliciously deep
 * input. This pass uses an explicit work list (a loop, not recursion) and
 * stops as soon as any limit is exceeded, so the recursive steps that follow
 * only ever see small, bounded trees.
 *
 * It also builds a fresh plain copy ("snapshot") of the input, reading each
 * property exactly once. Later steps work on the snapshot, so getters,
 * proxies, or later changes to the caller's object cannot affect them.
 */
import { languageFailure, type LanguageFailure } from "./errors.js";
import {
  BINARY_OPERATORS,
  FUNCTION_NAMES,
  MAX_DEPTH,
  MAX_FUNCTION_ARGS,
  MAX_NODES,
  NODE_FIELDS,
  VARIABLE_NAMES,
} from "./expression.js";

export type PreflightResult = { ok: true; snapshot: unknown } | LanguageFailure;

interface PendingValue {
  value: unknown;
  depth: number;
  place: (copy: unknown) => void;
}

const allowedFields: ReadonlySet<string> = new Set(NODE_FIELDS);
const allowedVariables: ReadonlySet<string> = new Set(VARIABLE_NAMES);
const allowedOperators: ReadonlySet<string> = new Set(BINARY_OPERATORS);
const allowedFunctions: ReadonlySet<string> = new Set(FUNCTION_NAMES);

export function preflightExpression(input: unknown): PreflightResult {
  try {
    return snapshot(input);
  } catch {
    // e.g. a property getter or proxy trap that throws.
    return languageFailure("INVALID_EXPRESSION");
  }
}

function snapshot(input: unknown): PreflightResult {
  let root: unknown;
  const pending: PendingValue[] = [{ value: input, depth: 1, place: (copy) => (root = copy) }];
  const seen = new WeakSet<object>();
  let nodeCount = 0;

  while (pending.length > 0) {
    const { value, depth, place } = pending.pop()!;

    // Primitives, null, and arrays in a node position are copied as-is;
    // schema validation rejects them without descending into them.
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      place(value);
      continue;
    }

    if (seen.has(value)) {
      return languageFailure("CYCLIC_EXPRESSION");
    }
    seen.add(value);
    if (depth > MAX_DEPTH) {
      return languageFailure("EXPRESSION_TOO_DEEP");
    }
    nodeCount++;
    if (nodeCount > MAX_NODES) {
      return languageFailure("EXPRESSION_TOO_LARGE");
    }

    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    place(copy);

    for (const field of Object.keys(source)) {
      if (!allowedFields.has(field)) {
        return languageFailure("UNEXPECTED_FIELD");
      }
      const child = source[field];

      if (field === "left" || field === "right") {
        pending.push({ value: child, depth: depth + 1, place: (childCopy) => (copy[field] = childCopy) });
      } else if (field === "args" && Array.isArray(child)) {
        if (seen.has(child)) {
          return languageFailure("CYCLIC_EXPRESSION");
        }
        seen.add(child);
        // Checked before reading any element, so huge arrays are never walked.
        if (child.length > MAX_FUNCTION_ARGS) {
          return languageFailure("TOO_MANY_ARGUMENTS");
        }
        const argsCopy: unknown[] = new Array(child.length);
        copy[field] = argsCopy;
        for (let i = 0; i < child.length; i++) {
          pending.push({ value: child[i], depth: depth + 1, place: (childCopy) => (argsCopy[i] = childCopy) });
        }
      } else {
        const unknownName = checkName(field, child);
        if (unknownName) {
          return unknownName;
        }
        copy[field] = child;
      }
    }
  }

  return { ok: true, snapshot: root };
}

/** Gives a specific error for an unknown name; other wrong types are left to the schema. */
function checkName(field: string, value: unknown): LanguageFailure | null {
  if (typeof value !== "string") {
    return null;
  }
  if (field === "var" && !allowedVariables.has(value)) {
    return languageFailure("UNKNOWN_VARIABLE");
  }
  if (field === "op" && !allowedOperators.has(value)) {
    return languageFailure("UNKNOWN_OPERATOR");
  }
  if (field === "fn" && !allowedFunctions.has(value)) {
    return languageFailure("UNKNOWN_FUNCTION");
  }
  return null;
}
