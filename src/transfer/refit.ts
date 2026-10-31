/**
 * Adapts an old theory to new observations while keeping its form.
 *
 * Adapting may (1) map the theory's variables onto the new attribute names
 * and (2) retune its numeric constants and, for a boolean theory, its
 * threshold. It never adds, removes, or rearranges nodes, and the operator
 * stays the same. A rule whose form changed therefore cannot be adapted
 * this way.
 *
 * Pure: it reads only the theory, the public attribute ranges, and the
 * observations it is given.
 */
import { createVariableSet, type Expression, type VariableSet } from "../language/expression.js";
import { validateNumericTheory } from "../language/numeric-theory.js";
import { validateTheory, type ComparisonOperator } from "../language/theory.js";

export interface TransferTheory {
  measurement: unknown;
  operator?: ComparisonOperator;
  threshold?: number;
}

export interface RefitTarget {
  attributeNames: readonly string[];
  ranges: Readonly<Record<string, { min: number; max: number }>>;
  outcomeKind: "boolean" | "number";
}

export interface TransferRow {
  inputs: Readonly<Record<string, number>>;
  outcome: boolean | number;
}

export interface RefitResult {
  theory: TransferTheory;
  /** Old variable name to new attribute name, for every variable the theory uses. */
  mapping: Record<string, string>;
  /** Accuracy for boolean outcomes, root mean squared error for numeric ones. Null without rows. */
  inSample: number | null;
  mappingCount: number;
}

/** Mappings that are retuned besides the identity. The rest are ranked by their untuned fit only. */
export const TUNED_MAPPINGS = 2;
export const MAX_MAPPINGS = 5040;
const BOOLEAN_SWEEPS = 4;
const GRID_STEPS = 120;
const MAX_LM_ITERATIONS = 60;

type Compiled = (values: readonly number[], params: readonly number[]) => number;

interface ParsedTheory {
  measurement: Expression;
  operator: ComparisonOperator | undefined;
  threshold: number | undefined;
  variables: string[];
  constants: number[];
}

interface Candidate {
  mapping: Record<string, string>;
  identity: boolean;
  compiled: Compiled;
  params: number[];
  threshold: number | undefined;
  score: number;
}

/** Null when the theory is invalid, has the wrong outcome kind, or uses more variables than the target has. */
export function refitTheory(
  theory: TransferTheory,
  target: RefitTarget,
  rows: readonly TransferRow[],
): RefitResult | null {
  const parsed = parseTheory(theory, target.outcomeKind);
  if (parsed === null || parsed.variables.length > target.attributeNames.length) {
    return null;
  }
  const matrix = rows.map((row) => target.attributeNames.map((name) => row.inputs[name]!));
  const outcomes = rows.map((row) => row.outcome);
  const numeric = target.outcomeKind === "number";
  const score = (compiled: Compiled, params: readonly number[], threshold: number | undefined) =>
    numeric
      ? rmse(compiled, params, matrix, outcomes as number[])
      : accuracy(compiled, params, parsed.operator!, threshold!, matrix, outcomes as boolean[]);

  const mappings = enumerateMappings(parsed.variables, target.attributeNames);
  const candidates: Candidate[] = mappings.map((mapping) => {
    const compiled = compile(parsed.measurement, indexOf(mapping, target.attributeNames));
    return {
      mapping,
      identity: parsed.variables.every((name) => mapping[name] === name),
      compiled,
      params: [...parsed.constants],
      threshold: parsed.threshold,
      score: rows.length === 0 ? 0 : score(compiled, parsed.constants, parsed.threshold),
    };
  });
  if (candidates.length === 0) {
    return null;
  }

  if (rows.length > 0) {
    const better = (x: number, y: number) => (numeric ? x < y : x > y);
    const ranked = [...candidates].sort((x, y) => (better(x.score, y.score) ? -1 : better(y.score, x.score) ? 1 : 0));
    const toTune = new Set<Candidate>(candidates.filter((candidate) => candidate.identity));
    for (const candidate of ranked) {
      if ([...toTune].filter((entry) => !entry.identity).length >= TUNED_MAPPINGS) {
        break;
      }
      if (!candidate.identity) {
        toTune.add(candidate);
      }
    }
    for (const candidate of toTune) {
      if (numeric) {
        tuneNumeric(candidate, matrix, outcomes as number[]);
      } else {
        tuneBoolean(candidate, parsed, target, matrix, outcomes as boolean[]);
      }
    }
  }

  let best = candidates[0]!;
  for (const candidate of candidates) {
    const improves = numeric ? candidate.score < best.score : candidate.score > best.score;
    if (improves || (candidate.score === best.score && candidate.identity && !best.identity)) {
      best = candidate;
    }
  }

  const measurement = rebuild(parsed.measurement, best.mapping, best.params, { next: 0 });
  const variables = createVariableSet(target.attributeNames);
  const adapted: TransferTheory = numeric
    ? { measurement }
    : { measurement, operator: parsed.operator!, threshold: best.threshold! };
  const valid = numeric ? validateNumericTheory(adapted, variables).ok : validateTheory(adapted, variables).ok;
  if (!valid) {
    return null;
  }
  return {
    theory: adapted,
    mapping: { ...best.mapping },
    inSample: rows.length === 0 ? null : best.score,
    mappingCount: candidates.length,
  };
}

function parseTheory(theory: TransferTheory, outcomeKind: "boolean" | "number"): ParsedTheory | null {
  const variables = collectVariables(theory.measurement);
  if (variables === null || variables.length === 0) {
    return null;
  }
  let set: VariableSet;
  try {
    set = createVariableSet(variables);
  } catch {
    return null;
  }
  if (outcomeKind === "number") {
    const validated = validateNumericTheory(theory, set);
    if (!validated.ok) {
      return null;
    }
    const measurement = validated.theory.measurement;
    return { measurement, operator: undefined, threshold: undefined, variables, constants: collectConstants(measurement) };
  }
  const validated = validateTheory(theory, set);
  if (!validated.ok) {
    return null;
  }
  const measurement = validated.theory.measurement;
  return {
    measurement,
    operator: validated.theory.operator,
    threshold: validated.theory.threshold,
    variables,
    constants: collectConstants(measurement),
  };
}

/** Variable names in order of first appearance. Null if the tree is not shaped like an expression. */
function collectVariables(node: unknown): string[] | null {
  const names: string[] = [];
  const pending: unknown[] = [node];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || ++visited > 256) {
      return null;
    }
    const record = current as Record<string, unknown>;
    if (typeof record.var === "string") {
      if (!names.includes(record.var)) {
        names.push(record.var);
      }
    } else if ("left" in record || "right" in record) {
      pending.push(record.left, record.right);
    } else if (Array.isArray(record.args)) {
      pending.push(...record.args);
    }
  }
  return names;
}

function collectConstants(node: Expression, into: number[] = []): number[] {
  if ("const" in node) {
    into.push(node.const);
  } else if ("op" in node) {
    collectConstants(node.left, into);
    collectConstants(node.right, into);
  } else if ("fn" in node) {
    for (const arg of node.args) {
      collectConstants(arg, into);
    }
  }
  return into;
}

/** Injective maps from the theory's variables to target names. The identity comes first when it exists. */
function enumerateMappings(variables: readonly string[], targetNames: readonly string[]): Array<Record<string, string>> {
  const mappings: Array<Record<string, string>> = [];
  const used = new Set<string>();
  const current: string[] = [];
  const walk = () => {
    if (mappings.length >= MAX_MAPPINGS) {
      return;
    }
    if (current.length === variables.length) {
      mappings.push(Object.fromEntries(variables.map((name, index) => [name, current[index]!])));
      return;
    }
    for (const name of targetNames) {
      if (!used.has(name)) {
        used.add(name);
        current.push(name);
        walk();
        current.pop();
        used.delete(name);
      }
    }
  };
  walk();
  const identity = mappings.findIndex((mapping) => variables.every((name) => mapping[name] === name));
  if (identity > 0) {
    mappings.unshift(...mappings.splice(identity, 1));
  }
  return mappings;
}

function indexOf(mapping: Record<string, string>, targetNames: readonly string[]): Map<string, number> {
  return new Map(Object.entries(mapping).map(([from, to]) => [from, targetNames.indexOf(to)]));
}

/** Compiles once into closures. Constants read from `params` in tree order. Invalid steps give NaN. */
function compile(node: Expression, variableIndex: Map<string, number>, counter = { next: 0 }): Compiled {
  if ("const" in node) {
    const index = counter.next++;
    return (_values, params) => params[index]!;
  }
  if ("var" in node) {
    const index = variableIndex.get(node.var)!;
    return (values) => values[index]!;
  }
  if ("op" in node) {
    const left = compile(node.left, variableIndex, counter);
    const right = compile(node.right, variableIndex, counter);
    switch (node.op) {
      case "add":
        return (values, params) => left(values, params) + right(values, params);
      case "sub":
        return (values, params) => left(values, params) - right(values, params);
      case "mul":
        return (values, params) => left(values, params) * right(values, params);
      case "div":
        return (values, params) => {
          const divisor = right(values, params);
          return divisor === 0 ? Number.NaN : left(values, params) / divisor;
        };
    }
  }
  const args = node.args.map((arg) => compile(arg, variableIndex, counter));
  switch (node.fn) {
    case "abs":
      return (values, params) => Math.abs(args[0]!(values, params));
    case "sqrt":
      return (values, params) => {
        const value = args[0]!(values, params);
        return value < 0 ? Number.NaN : Math.sqrt(value);
      };
    case "log":
      return (values, params) => {
        const value = args[0]!(values, params);
        return value <= 0 ? Number.NaN : Math.log(value);
      };
    case "min":
      return (values, params) => Math.min(...args.map((arg) => arg(values, params)));
    case "max":
      return (values, params) => Math.max(...args.map((arg) => arg(values, params)));
  }
}

function rebuild(
  node: Expression,
  mapping: Record<string, string>,
  params: readonly number[],
  counter: { next: number },
): Expression {
  if ("const" in node) {
    return { const: params[counter.next++]! };
  }
  if ("var" in node) {
    return { var: mapping[node.var]! };
  }
  if ("op" in node) {
    const left = rebuild(node.left, mapping, params, counter);
    const right = rebuild(node.right, mapping, params, counter);
    return { op: node.op, left, right };
  }
  return { fn: node.fn, args: node.args.map((arg) => rebuild(arg, mapping, params, counter)) } as Expression;
}

function compare(value: number, operator: ComparisonOperator, threshold: number): boolean {
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

function accuracy(
  compiled: Compiled,
  params: readonly number[],
  operator: ComparisonOperator,
  threshold: number,
  matrix: readonly number[][],
  outcomes: readonly boolean[],
): number {
  let correct = 0;
  for (let index = 0; index < matrix.length; index++) {
    const value = compiled(matrix[index]!, params);
    if (Number.isFinite(value) && compare(value, operator, threshold) === outcomes[index]) {
      correct++;
    }
  }
  return correct / matrix.length;
}

function residuals(compiled: Compiled, params: readonly number[], matrix: readonly number[][], outcomes: readonly number[]): number[] | null {
  const result: number[] = [];
  for (let index = 0; index < matrix.length; index++) {
    const value = compiled(matrix[index]!, params);
    if (!Number.isFinite(value)) {
      return null;
    }
    result.push(value - outcomes[index]!);
  }
  return result;
}

function rmse(compiled: Compiled, params: readonly number[], matrix: readonly number[][], outcomes: readonly number[]): number {
  const errors = residuals(compiled, params, matrix, outcomes);
  if (errors === null) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length);
}

/**
 * Coordinate search on accuracy. Each coordinate is a group of equal
 * constants, a single constant, or the threshold. Among values that tie for
 * the best accuracy, the current value is kept when it is one of them;
 * otherwise the centre of the tied run nearest the current value is used.
 */
function tuneBoolean(
  candidate: Candidate,
  parsed: ParsedTheory,
  target: RefitTarget,
  matrix: readonly number[][],
  outcomes: readonly boolean[],
): void {
  const operator = parsed.operator!;
  const coordinates: number[][] = [];
  const byValue = new Map<number, number[]>();
  candidate.params.forEach((value, index) => byValue.set(value, [...(byValue.get(value) ?? []), index]));
  for (const group of byValue.values()) {
    if (group.length > 1) {
      coordinates.push(group);
    }
  }
  candidate.params.forEach((_value, index) => coordinates.push([index]));

  const constantGrid = constantCandidates(target, matrix);
  const scoreWith = (params: readonly number[], threshold: number) =>
    accuracy(candidate.compiled, params, operator, threshold, matrix, outcomes);

  for (let sweep = 0; sweep < BOOLEAN_SWEEPS; sweep++) {
    let changed = false;
    for (const group of coordinates) {
      const current = candidate.params[group[0]!]!;
      const values = sortedUnique([current, ...constantGrid]);
      const withValue = (value: number) => {
        const params = [...candidate.params];
        for (const index of group) {
          params[index] = value;
        }
        return params;
      };
      const chosen = chooseValue(values, current, (value) => scoreWith(withValue(value), candidate.threshold!));
      if (chosen.value !== current && chosen.score > candidate.score) {
        candidate.params = withValue(chosen.value);
        candidate.score = chosen.score;
        changed = true;
      }
    }

    const measured = matrix.map((row) => candidate.compiled(row, candidate.params)).filter(Number.isFinite);
    const thresholds = sortedUnique([candidate.threshold!, ...midpoints(measured)]);
    const chosen = chooseValue(thresholds, candidate.threshold!, (value) => scoreWith(candidate.params, value));
    if (chosen.value !== candidate.threshold && chosen.score > candidate.score) {
      candidate.threshold = chosen.value;
      candidate.score = chosen.score;
      changed = true;
    }
    if (!changed) {
      return;
    }
  }
}

function chooseValue(
  values: readonly number[],
  current: number,
  score: (value: number) => number,
): { value: number; score: number } {
  const scores = values.map(score);
  const best = Math.max(...scores);
  const currentIndex = values.indexOf(current);
  if (scores[currentIndex] === best) {
    return { value: current, score: best };
  }
  let chosenRun: [number, number] | null = null;
  let chosenDistance = Number.POSITIVE_INFINITY;
  for (let start = 0; start < values.length; start++) {
    if (scores[start] !== best) {
      continue;
    }
    let end = start;
    while (end + 1 < values.length && scores[end + 1] === best) {
      end++;
    }
    const centre = (values[start]! + values[end]!) / 2;
    const distance = Math.abs(centre - current);
    if (distance < chosenDistance) {
      chosenRun = [start, end];
      chosenDistance = distance;
    }
    start = end;
  }
  const [start, end] = chosenRun!;
  const centre = (values[start]! + values[end]!) / 2;
  const centreScore = score(centre);
  if (centreScore === best) {
    return { value: centre, score: best };
  }
  const middle = values[Math.floor((start + end) / 2)]!;
  return { value: middle, score: best };
}

/** Midpoints between observed values of every attribute, plus an even grid one range-width beyond the public ranges. */
function constantCandidates(target: RefitTarget, matrix: readonly number[][]): number[] {
  const values: number[] = [];
  target.attributeNames.forEach((_name, column) => {
    values.push(...midpoints(matrix.map((row) => row[column]!)));
  });
  const ranges = Object.values(target.ranges);
  const low = Math.min(...ranges.map((range) => range.min));
  const high = Math.max(...ranges.map((range) => range.max));
  const width = high - low;
  for (let step = 0; step <= GRID_STEPS; step++) {
    values.push(low - width + (3 * width * step) / GRID_STEPS);
  }
  return values;
}

function midpoints(values: readonly number[]): number[] {
  const sorted = sortedUnique(values);
  const result: number[] = [];
  for (let index = 1; index < sorted.length; index++) {
    result.push((sorted[index - 1]! + sorted[index]!) / 2);
  }
  return result;
}

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values.filter(Number.isFinite))].sort((x, y) => x - y);
}

/** Damped Gauss-Newton (Levenberg-Marquardt) on squared error, with a finite-difference Jacobian. */
function tuneNumeric(candidate: Candidate, matrix: readonly number[][], outcomes: readonly number[]): void {
  const count = candidate.params.length;
  if (count === 0) {
    return;
  }
  let params = [...candidate.params];
  let errors = residuals(candidate.compiled, params, matrix, outcomes);
  if (errors === null) {
    return;
  }
  let cost = sumOfSquares(errors);
  let damping = 1e-3;

  for (let iteration = 0; iteration < MAX_LM_ITERATIONS && damping < 1e12; iteration++) {
    const jacobian: number[][] = [];
    let usable = true;
    for (let column = 0; column < count; column++) {
      const step = 1e-6 * Math.max(1, Math.abs(params[column]!));
      const nudged = [...params];
      nudged[column] = params[column]! + step;
      const shifted = residuals(candidate.compiled, nudged, matrix, outcomes);
      if (shifted === null) {
        usable = false;
        break;
      }
      jacobian.push(shifted.map((value, row) => (value - errors![row]!) / step));
    }
    if (!usable) {
      return;
    }

    const normal = Array.from({ length: count }, (_, i) =>
      Array.from({ length: count }, (_, j) => dot(jacobian[i]!, jacobian[j]!)),
    );
    const gradient = jacobian.map((column) => -dot(column, errors!));
    let improved = false;
    while (damping < 1e12) {
      const damped = normal.map((row, i) => row.map((value, j) => (i === j ? value * (1 + damping) + 1e-12 : value)));
      const delta = solve(damped, gradient);
      if (delta !== null) {
        const trial = params.map((value, index) => value + delta[index]!);
        const trialErrors = residuals(candidate.compiled, trial, matrix, outcomes);
        const trialCost = trialErrors === null ? Number.POSITIVE_INFINITY : sumOfSquares(trialErrors);
        if (trialCost < cost) {
          const relative = (cost - trialCost) / Math.max(cost, 1e-300);
          params = trial;
          errors = trialErrors!;
          cost = trialCost;
          damping = Math.max(damping / 10, 1e-12);
          improved = relative > 1e-12;
          break;
        }
      }
      damping *= 10;
    }
    if (!improved) {
      break;
    }
  }
  candidate.params = params;
  candidate.score = Math.sqrt(cost / matrix.length);
}

function sumOfSquares(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value * value, 0);
}

function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index++) {
    sum += left[index]! * right[index]!;
  }
  return sum;
}

/** Gaussian elimination with partial pivoting. Null when the system is singular. */
function solve(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length;
  const rows = matrix.map((row, index) => [...row, vector[index]!]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) {
        pivot = row;
      }
    }
    if (Math.abs(rows[pivot]![column]!) < 1e-14) {
      return null;
    }
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    for (let row = column + 1; row < size; row++) {
      const factor = rows[row]![column]! / rows[column]![column]!;
      for (let k = column; k <= size; k++) {
        rows[row]![k] = rows[row]![k]! - factor * rows[column]![k]!;
      }
    }
  }
  const solution = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row--) {
    let sum = rows[row]![size]!;
    for (let k = row + 1; k < size; k++) {
      sum -= rows[row]![k]! * solution[k]!;
    }
    solution[row] = sum / rows[row]![row]!;
  }
  return solution;
}
