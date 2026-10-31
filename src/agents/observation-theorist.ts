/**
 * Chooses one theory from a fixed catalog using only public ranges and observations.
 *
 * Constants in the catalog are zero and each public range's midpoint. Held-out
 * cases are never an input, and this file does not import the world engine.
 */
import { evaluateExpression } from "../language/interpreter.js";
import {
  measureTheoryComplexity,
  validateTheory,
  type ComparisonOperator,
  type ValidatedTheory,
} from "../language/theory.js";

const ATTRIBUTE_NAMES = ["a", "b", "c"] as const;
const OPERATORS: readonly ComparisonOperator[] = ["lt", "lte", "gt", "gte"];
const PAIRS = [
  ["a", "b"],
  ["a", "c"],
  ["b", "c"],
] as const;

type AttributeName = (typeof ATTRIBUTE_NAMES)[number];

export interface AttributeBounds {
  min: number;
  max: number;
}

export interface PublicRanges {
  a: AttributeBounds;
  b: AttributeBounds;
  c: AttributeBounds;
}

export interface ObservedRow {
  inputs: { a: number; b: number; c: number };
  glows: boolean;
}

export interface FittedTheory {
  theory: ValidatedTheory;
  /** Null when there are no observations to score against. */
  inSampleAccuracy: number | null;
  candidateCount: number;
  observationCount: number;
}

interface RankedTheory {
  theory: ValidatedTheory;
  accuracy: number;
  nodes: number;
  depth: number;
  index: number;
}

/** Reads one successful experiment tool result. Returns null for anything else. */
export function readObservedRow(output: unknown): ObservedRow | null {
  if (typeof output !== "object" || output === null) {
    return null;
  }
  const record = output as Record<string, unknown>;
  if (record.ok !== true || typeof record.observation !== "object" || record.observation === null) {
    return null;
  }
  const observation = record.observation as Record<string, unknown>;
  if (typeof observation.inputs !== "object" || observation.inputs === null) {
    return null;
  }
  if (typeof observation.outcome !== "object" || observation.outcome === null) {
    return null;
  }
  const inputs = observation.inputs as Record<string, unknown>;
  const outcome = observation.outcome as Record<string, unknown>;
  const { a, b, c } = inputs;
  if (
    typeof a !== "number" ||
    typeof b !== "number" ||
    typeof c !== "number" ||
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    !Number.isFinite(c) ||
    typeof outcome.glows !== "boolean"
  ) {
    return null;
  }
  return { inputs: { a, b, c }, glows: outcome.glows };
}

/**
 * Scores a theory on observations the strategy already collected.
 * An expression error counts as a wrong prediction. Null means there was
 * nothing to score or the theory was not valid.
 */
export function scoreTheoryOnObservations(theory: unknown, rows: readonly ObservedRow[]): number | null {
  if (rows.length === 0) {
    return null;
  }
  const validated = validateTheory(theory);
  if (!validated.ok) {
    return null;
  }
  return accuracyOf(validated.theory, rows);
}

export function fitTheoryFromObservations(ranges: PublicRanges, rows: readonly ObservedRow[]): FittedTheory {
  const candidates = buildCandidates(ranges);
  let best: RankedTheory | null = null;

  for (let index = 0; index < candidates.length; index++) {
    const validated = validateTheory(candidates[index]);
    if (!validated.ok) {
      continue;
    }
    const accuracy = rows.length === 0 ? 0 : accuracyOf(validated.theory, rows);
    const complexity = measureTheoryComplexity(validated.theory);
    const ranked: RankedTheory = {
      theory: validated.theory,
      accuracy,
      nodes: complexity.nodeCount,
      depth: complexity.depth,
      index,
    };
    if (best === null || isBetter(ranked, best)) {
      best = ranked;
    }
  }

  if (best === null) {
    throw new Error("No theory could be fitted.");
  }

  return {
    theory: best.theory,
    inSampleAccuracy: rows.length === 0 ? null : best.accuracy,
    candidateCount: candidates.length,
    observationCount: rows.length,
  };
}

function buildCandidates(ranges: PublicRanges): unknown[] {
  const candidates: unknown[] = [
    theory({ const: 0 }, "gt", 0),
    theory({ const: 0 }, "lte", 0),
  ];
  const middles = {
    a: midpoint(ranges.a),
    b: midpoint(ranges.b),
    c: midpoint(ranges.c),
  };

  for (const name of ATTRIBUTE_NAMES) {
    const middle = middles[name];
    if (middle === null) {
      continue;
    }
    for (const operator of OPERATORS) {
      candidates.push(theory({ var: name }, operator, middle));
    }
  }

  for (const [left, right] of PAIRS) {
    const leftMiddle = middles[left];
    const rightMiddle = middles[right];
    if (leftMiddle === null || rightMiddle === null) {
      continue;
    }
    const measurement = {
      op: "mul",
      left: { op: "sub", left: { var: left }, right: { const: leftMiddle } },
      right: { op: "sub", left: { var: right }, right: { const: rightMiddle } },
    };
    for (const operator of OPERATORS) {
      candidates.push(theory(measurement, operator, 0));
    }
  }

  return candidates;
}

function theory(measurement: unknown, operator: ComparisonOperator, threshold: number): unknown {
  return { measurement, operator, threshold };
}

function midpoint(bounds: AttributeBounds): number | null {
  if (!Number.isFinite(bounds.min) || !Number.isFinite(bounds.max)) {
    return null;
  }
  const middle = (bounds.min + bounds.max) / 2;
  return Number.isFinite(middle) ? middle : null;
}

function accuracyOf(theory: ValidatedTheory, rows: readonly ObservedRow[]): number {
  let correct = 0;
  for (const row of rows) {
    const measured = evaluateExpression(theory.measurement, row.inputs);
    if (!measured.ok) {
      continue;
    }
    if (predictsTrue(measured.value, theory.operator, theory.threshold) === row.glows) {
      correct++;
    }
  }
  return correct / rows.length;
}

function predictsTrue(value: number, operator: ComparisonOperator, threshold: number): boolean {
  switch (operator) {
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
  }
}

function isBetter(next: RankedTheory, current: RankedTheory): boolean {
  if (next.accuracy !== current.accuracy) {
    return next.accuracy > current.accuracy;
  }
  if (next.nodes !== current.nodes) {
    return next.nodes < current.nodes;
  }
  if (next.depth !== current.depth) {
    return next.depth < current.depth;
  }
  return next.index < current.index;
}
