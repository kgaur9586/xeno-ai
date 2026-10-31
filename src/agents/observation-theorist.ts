/**
 * Chooses one theory from a fixed catalog using only public ranges and observations.
 *
 * Boolean catalog: constants, each attribute against its public range
 * midpoint, and each attribute pair's midpoint-centered product against zero.
 * Numeric catalog: the observed mean, one least-squares line per attribute,
 * and one least-squares linear fit over all attributes.
 * Held-out cases are never an input, and this file does not import the world engine.
 */
import { createVariableSet, type VariableSet } from "../language/expression.js";
import { evaluateExpression } from "../language/interpreter.js";
import { validateNumericTheory, type ValidatedNumericTheory } from "../language/numeric-theory.js";
import {
  measureExpressionComplexity,
  measureTheoryComplexity,
  validateTheory,
  type ComparisonOperator,
  type ValidatedTheory,
} from "../language/theory.js";

const OPERATORS: readonly ComparisonOperator[] = ["lt", "lte", "gt", "gte"];

export interface AttributeBounds {
  min: number;
  max: number;
}

/** Public ranges keyed by attribute name, in the world's documented order. */
export type PublicRanges = Readonly<Record<string, AttributeBounds>>;

export interface ObservedRow {
  inputs: Readonly<Record<string, number>>;
  outcome: boolean | number;
}

export interface FittedTheory {
  theory: ValidatedTheory;
  /** Null when there are no observations to score against. */
  inSampleAccuracy: number | null;
  candidateCount: number;
  observationCount: number;
}

export interface FittedNumericTheory {
  theory: ValidatedNumericTheory;
  /** Root mean squared error on the observations. Null when there are none. */
  inSampleRmse: number | null;
  candidateCount: number;
  observationCount: number;
}

interface RankedTheory<T> {
  theory: T;
  /** Higher is better. */
  score: number;
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
  const inputs: Record<string, number> = {};
  for (const [name, value] of Object.entries(observation.inputs as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    inputs[name] = value;
  }
  const outcomes = Object.values(observation.outcome as Record<string, unknown>);
  if (outcomes.length !== 1) {
    return null;
  }
  const outcome = outcomes[0];
  if (typeof outcome === "boolean" || (typeof outcome === "number" && Number.isFinite(outcome))) {
    return { inputs, outcome };
  }
  return null;
}

/**
 * Scores a boolean theory on observations the strategy already collected.
 * An expression error counts as a wrong prediction. Null means there was
 * nothing to score or the theory was not valid.
 */
export function scoreTheoryOnObservations(
  theory: unknown,
  rows: readonly ObservedRow[],
  variables?: VariableSet,
): number | null {
  if (rows.length === 0) {
    return null;
  }
  const set = variables ?? variablesFromRows(rows);
  const validated = validateTheory(theory, set);
  if (!validated.ok) {
    return null;
  }
  return accuracyOf(validated.theory, rows, set);
}

/** Root mean squared error of a numeric theory on the observations. Null if none could be scored. */
export function scoreNumericTheoryOnObservations(
  theory: unknown,
  rows: readonly ObservedRow[],
  variables?: VariableSet,
): number | null {
  if (rows.length === 0) {
    return null;
  }
  const set = variables ?? variablesFromRows(rows);
  const validated = validateNumericTheory(theory, set);
  if (!validated.ok) {
    return null;
  }
  return rmseOf(validated.theory.measurement, rows, set);
}

export function fitTheoryFromObservations(ranges: PublicRanges, rows: readonly ObservedRow[]): FittedTheory {
  const variables = createVariableSet(Object.keys(ranges));
  const candidates = buildBooleanCandidates(ranges);
  let best: RankedTheory<ValidatedTheory> | null = null;

  for (let index = 0; index < candidates.length; index++) {
    const validated = validateTheory(candidates[index], variables);
    if (!validated.ok) {
      continue;
    }
    const complexity = measureTheoryComplexity(validated.theory);
    const ranked: RankedTheory<ValidatedTheory> = {
      theory: validated.theory,
      score: rows.length === 0 ? 0 : accuracyOf(validated.theory, rows, variables),
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
    inSampleAccuracy: rows.length === 0 ? null : best.score,
    candidateCount: candidates.length,
    observationCount: rows.length,
  };
}

export function fitNumericTheoryFromObservations(
  ranges: PublicRanges,
  rows: readonly ObservedRow[],
): FittedNumericTheory {
  const names = Object.keys(ranges);
  const variables = createVariableSet(names);
  const numericRows = rows.filter((row) => typeof row.outcome === "number");
  const candidates = buildNumericCandidates(names, numericRows);
  let best: RankedTheory<ValidatedNumericTheory> | null = null;

  for (let index = 0; index < candidates.length; index++) {
    const validated = validateNumericTheory(candidates[index], variables);
    if (!validated.ok) {
      continue;
    }
    const rmse = numericRows.length === 0 ? 0 : rmseOf(validated.theory.measurement, numericRows, variables);
    if (rmse === null) {
      continue;
    }
    const complexity = measureExpressionComplexity(validated.theory.measurement);
    const ranked: RankedTheory<ValidatedNumericTheory> = {
      theory: validated.theory,
      score: -rmse,
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
    inSampleRmse: numericRows.length === 0 ? null : -best.score,
    candidateCount: candidates.length,
    observationCount: numericRows.length,
  };
}

function buildBooleanCandidates(ranges: PublicRanges): unknown[] {
  const names = Object.keys(ranges);
  const candidates: unknown[] = [
    booleanTheory({ const: 0 }, "gt", 0),
    booleanTheory({ const: 0 }, "lte", 0),
  ];
  const middles = new Map<string, number>();
  for (const name of names) {
    const middle = midpoint(ranges[name]!);
    if (middle !== null) {
      middles.set(name, middle);
    }
  }

  for (const name of names) {
    const middle = middles.get(name);
    if (middle === undefined) {
      continue;
    }
    for (const operator of OPERATORS) {
      candidates.push(booleanTheory({ var: name }, operator, middle));
    }
  }

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const left = names[i]!;
      const right = names[j]!;
      const leftMiddle = middles.get(left);
      const rightMiddle = middles.get(right);
      if (leftMiddle === undefined || rightMiddle === undefined) {
        continue;
      }
      const measurement = {
        op: "mul",
        left: { op: "sub", left: { var: left }, right: { const: leftMiddle } },
        right: { op: "sub", left: { var: right }, right: { const: rightMiddle } },
      };
      for (const operator of OPERATORS) {
        candidates.push(booleanTheory(measurement, operator, 0));
      }
    }
  }

  return candidates;
}

function buildNumericCandidates(names: readonly string[], rows: readonly ObservedRow[]): unknown[] {
  if (rows.length === 0) {
    return [{ measurement: { const: 0 } }];
  }
  const ys = rows.map((row) => row.outcome as number);
  const candidates: unknown[] = [{ measurement: { const: mean(ys) } }];

  for (const name of names) {
    const coefficients = leastSquares(rows, [name]);
    if (coefficients !== null) {
      candidates.push({ measurement: linearExpression([name], coefficients) });
    }
  }
  if (names.length > 1) {
    const coefficients = leastSquares(rows, names);
    if (coefficients !== null) {
      candidates.push({ measurement: linearExpression(names, coefficients) });
    }
  }
  return candidates;
}

/** Intercept followed by one coefficient per name. Null when the system is singular or too small. */
function leastSquares(rows: readonly ObservedRow[], names: readonly string[]): number[] | null {
  const size = names.length + 1;
  if (rows.length < size) {
    return null;
  }
  const matrix: number[][] = Array.from({ length: size }, () => new Array<number>(size + 1).fill(0));
  for (const row of rows) {
    const features = [1, ...names.map((name) => row.inputs[name] ?? Number.NaN)];
    const y = row.outcome as number;
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        matrix[i]![j]! += features[i]! * features[j]!;
      }
      matrix[i]![size]! += features[i]! * y;
    }
  }
  return solve(matrix, size);
}

/** Gaussian elimination with partial pivoting on an augmented matrix. */
function solve(matrix: number[][], size: number): number[] | null {
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(matrix[row]![column]!) > Math.abs(matrix[pivot]![column]!)) {
        pivot = row;
      }
    }
    if (!(Math.abs(matrix[pivot]![column]!) > 1e-9)) {
      return null;
    }
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    for (let row = 0; row < size; row++) {
      if (row === column) {
        continue;
      }
      const factor = matrix[row]![column]! / matrix[column]![column]!;
      for (let k = column; k <= size; k++) {
        matrix[row]![k]! -= factor * matrix[column]![k]!;
      }
    }
  }
  const solution = Array.from({ length: size }, (_, i) => matrix[i]![size]! / matrix[i]![i]!);
  return solution.every(Number.isFinite) ? solution : null;
}

function linearExpression(names: readonly string[], coefficients: readonly number[]): unknown {
  let expression: unknown = { const: coefficients[0]! };
  names.forEach((name, index) => {
    expression = {
      op: "add",
      left: expression,
      right: { op: "mul", left: { const: coefficients[index + 1]! }, right: { var: name } },
    };
  });
  return expression;
}

function booleanTheory(measurement: unknown, operator: ComparisonOperator, threshold: number): unknown {
  return { measurement, operator, threshold };
}

function midpoint(bounds: AttributeBounds): number | null {
  if (!Number.isFinite(bounds.min) || !Number.isFinite(bounds.max)) {
    return null;
  }
  const middle = (bounds.min + bounds.max) / 2;
  return Number.isFinite(middle) ? middle : null;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function accuracyOf(theory: ValidatedTheory, rows: readonly ObservedRow[], variables: VariableSet): number {
  let correct = 0;
  for (const row of rows) {
    const measured = evaluateExpression(theory.measurement, row.inputs, variables);
    if (!measured.ok) {
      continue;
    }
    if (predictsTrue(measured.value, theory.operator, theory.threshold) === row.outcome) {
      correct++;
    }
  }
  return correct / rows.length;
}

function rmseOf(measurement: unknown, rows: readonly ObservedRow[], variables: VariableSet): number | null {
  let squared = 0;
  let scored = 0;
  for (const row of rows) {
    const measured = evaluateExpression(measurement, row.inputs, variables);
    if (!measured.ok || typeof row.outcome !== "number") {
      continue;
    }
    squared += (measured.value - row.outcome) ** 2;
    scored++;
  }
  return scored === 0 ? null : Math.sqrt(squared / scored);
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

function variablesFromRows(rows: readonly ObservedRow[]): VariableSet {
  return createVariableSet(Object.keys(rows[0]!.inputs));
}

function isBetter<T>(next: RankedTheory<T>, current: RankedTheory<T>): boolean {
  if (next.score !== current.score) {
    return next.score > current.score;
  }
  if (next.nodes !== current.nodes) {
    return next.nodes < current.nodes;
  }
  if (next.depth !== current.depth) {
    return next.depth < current.depth;
  }
  return next.index < current.index;
}
