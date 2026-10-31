/**
 * Generic evaluator for any world.
 *
 * Held-out cases are drawn from a private seed and labelled by the world
 * engine directly, never through the experiment tools. Labels carry the same
 * noise an observation would, so a perfect theory cannot score 100% on a noisy
 * world. Pass thresholds are derived from the world's noise level and the case
 * count. Reports contain aggregate metrics only: no cases, labels, or seeds.
 */
import type { LanguageErrorCode } from "../language/errors.js";
import { createVariableSet, type VariableSet } from "../language/expression.js";
import { evaluateExpression } from "../language/interpreter.js";
import { validateNumericTheory } from "../language/numeric-theory.js";
import {
  THEORY_ERROR,
  measureExpressionComplexity,
  validateTheory,
  type ComparisonOperator,
  type TheoryComplexity,
} from "../language/theory.js";
import { createSeededRandom, type RandomSource } from "../shared/random.js";
import { getWorld } from "../worlds/registry.js";
import type { BooleanWorld, NumericWorld, World } from "../worlds/world.js";

/** Standard errors subtracted from the expected accuracy to get a pass threshold. */
export const PASS_STANDARD_ERRORS = 3;
/** Smallest error rate used for the margin, so a noiseless world still allows a few boundary misses. */
export const MIN_MARGIN_ERROR_RATE = 0.005;
/** Numeric tolerance in noise standard deviations. */
export const TOLERANCE_STANDARD_DEVIATIONS = 3;
/** Fraction of a normal distribution within three standard deviations. */
export const GAUSSIAN_WITHIN_THREE_SD = 0.9973;
/** Tolerance for a numeric world with no noise. */
export const NOISELESS_TOLERANCE = 1e-9;
/** Guard against an unreachable class in rejection sampling. */
export const MAX_DRAWS_PER_CASE = 10_000;

export type EvaluationRegion = "in-range" | "out-of-range";

export interface WorldCase<T extends boolean | number = boolean | number> {
  inputs: Record<string, number>;
  outcome: T;
}

export interface WorldEvaluationOptions {
  inRangeSeed: number;
  outOfRangeSeed: number;
  caseCount: number;
}

export interface BooleanDatasetReport {
  totalCases: number;
  correctPredictions: number;
  incorrectPredictions: number;
  accuracy: number;
  evaluationErrors: Partial<Record<LanguageErrorCode, number>>;
  passThreshold: number;
  passed: boolean;
}

export interface BooleanWorldReport {
  kind: "boolean";
  /** The best expected accuracy given label noise: 1 minus the flip rate. */
  noiseCeiling: number;
  inRange: BooleanDatasetReport;
  outOfRange: BooleanDatasetReport;
  complexity: TheoryComplexity;
}

export interface NumericDatasetReport {
  totalCases: number;
  /** Cases where the measurement produced a number. */
  scoredCases: number;
  /** Null when no case could be scored. */
  meanAbsoluteError: number | null;
  rootMeanSquaredError: number | null;
  withinTolerance: number;
  withinToleranceRate: number;
  evaluationErrors: Partial<Record<LanguageErrorCode, number>>;
  passThreshold: number;
  passed: boolean;
}

export interface NumericWorldReport {
  kind: "number";
  noiseStandardDeviation: number;
  tolerance: number;
  inRange: NumericDatasetReport;
  outOfRange: NumericDatasetReport;
  complexity: TheoryComplexity;
}

export type WorldEvaluationResult<R> = { ok: true; report: R } | { ok: false; error: typeof THEORY_ERROR };

/**
 * Generates `caseCount` reproducible cases. For a boolean world the noiseless
 * classes are exactly balanced; label noise is applied afterwards.
 */
export function generateWorldCases(
  world: World,
  seed: number,
  caseCount: number,
  region: EvaluationRegion,
): WorldCase[] {
  validateCaseCount(world, caseCount);
  const random = createSeededRandom(seed);
  if (world.kind === "number") {
    const cases: WorldCase<number>[] = [];
    for (let i = 0; i < caseCount; i++) {
      const inputs = drawInputs(world, random, region);
      cases.push({ inputs, outcome: world.observe(inputs, random) });
    }
    return cases;
  }

  const perClass = caseCount / 2;
  const cases: WorldCase<boolean>[] = [];
  let positives = 0;
  let negatives = 0;
  let draws = 0;
  while (positives < perClass || negatives < perClass) {
    if (++draws > caseCount * MAX_DRAWS_PER_CASE) {
      throw new Error("Could not build a balanced evaluation set.");
    }
    const inputs = drawInputs(world, random, region);
    const truth = world.trueOutcome(inputs);
    if (truth ? positives >= perClass : negatives >= perClass) {
      continue;
    }
    if (truth) {
      positives++;
    } else {
      negatives++;
    }
    cases.push({ inputs, outcome: world.observe(inputs, random) });
  }
  return cases;
}

/** Accuracy a theory must reach on a noisy boolean dataset of `caseCount` cases. */
export function booleanPassThreshold(flipRate: number, caseCount: number): number {
  const errorRate = Math.max(flipRate, MIN_MARGIN_ERROR_RATE);
  const margin = PASS_STANDARD_ERRORS * Math.sqrt((errorRate * (1 - errorRate)) / caseCount);
  return Math.max(0.5, 1 - flipRate - margin);
}

/** Within-tolerance rate a numeric theory must reach on `caseCount` cases. */
export function numericPassThreshold(caseCount: number): number {
  const p = GAUSSIAN_WITHIN_THREE_SD;
  return p - PASS_STANDARD_ERRORS * Math.sqrt((p * (1 - p)) / caseCount);
}

export function numericTolerance(noiseStandardDeviation: number): number {
  return noiseStandardDeviation > 0
    ? TOLERANCE_STANDARD_DEVIATIONS * noiseStandardDeviation
    : NOISELESS_TOLERANCE;
}

/** Scores a boolean theory (measurement, operator, threshold) on a boolean world. */
export function evaluateBooleanWorldTheory(
  world: BooleanWorld,
  theory: unknown,
  options: WorldEvaluationOptions,
): WorldEvaluationResult<BooleanWorldReport> {
  const variables = variablesOf(world);
  const validated = validateTheory(plainTheory(theory), variables);
  if (!validated.ok) {
    return { ok: false, error: { ...THEORY_ERROR } };
  }
  const threshold = booleanPassThreshold(world.flipRate, options.caseCount);
  const score = (cases: WorldCase[]) =>
    scoreBoolean(cases as WorldCase<boolean>[], validated.theory, variables, threshold);

  return {
    ok: true,
    report: {
      kind: "boolean",
      noiseCeiling: 1 - world.flipRate,
      inRange: score(generateWorldCases(world, options.inRangeSeed, options.caseCount, "in-range")),
      outOfRange: score(generateWorldCases(world, options.outOfRangeSeed, options.caseCount, "out-of-range")),
      complexity: measureExpressionComplexity(validated.theory.measurement),
    },
  };
}

/** Scores a numeric theory (a measurement that predicts the value) on a numeric world. */
export function evaluateNumericWorldTheory(
  world: NumericWorld,
  theory: unknown,
  options: WorldEvaluationOptions,
): WorldEvaluationResult<NumericWorldReport> {
  const variables = variablesOf(world);
  const validated = validateNumericTheory(plainTheory(theory), variables);
  if (!validated.ok) {
    return { ok: false, error: { ...THEORY_ERROR } };
  }
  const tolerance = numericTolerance(world.noiseStandardDeviation);
  const threshold = numericPassThreshold(options.caseCount);
  const score = (cases: WorldCase[]) =>
    scoreNumeric(cases as WorldCase<number>[], validated.theory.measurement, variables, tolerance, threshold);

  return {
    ok: true,
    report: {
      kind: "number",
      noiseStandardDeviation: world.noiseStandardDeviation,
      tolerance,
      inRange: score(generateWorldCases(world, options.inRangeSeed, options.caseCount, "in-range")),
      outOfRange: score(generateWorldCases(world, options.outOfRangeSeed, options.caseCount, "out-of-range")),
      complexity: measureExpressionComplexity(validated.theory.measurement),
    },
  };
}

export type AnyWorldReport = BooleanWorldReport | NumericWorldReport;

/**
 * Scores a theory on any world: a boolean theory for a boolean outcome, a
 * numeric theory for a numeric one. `kind` is checked against the world.
 */
export function evaluateWorldTheory(
  world: World,
  theory: unknown,
  options: WorldEvaluationOptions,
): WorldEvaluationResult<AnyWorldReport> {
  return world.kind === "boolean"
    ? evaluateBooleanWorldTheory(world, theory, options)
    : evaluateNumericWorldTheory(world, theory, options);
}

/** The same for a registered world, so callers never handle the world object. */
export function evaluateWorldTheoryById(
  worldId: string,
  theory: unknown,
  options: WorldEvaluationOptions,
): WorldEvaluationResult<AnyWorldReport> {
  const world = getWorld(worldId);
  if (world === undefined) {
    throw new Error("Unknown world.");
  }
  return evaluateWorldTheory(world, theory, options);
}

function scoreBoolean(
  cases: readonly WorldCase<boolean>[],
  theory: { measurement: unknown; operator: ComparisonOperator; threshold: number },
  variables: VariableSet,
  passThreshold: number,
): BooleanDatasetReport {
  let correctPredictions = 0;
  const evaluationErrors: Partial<Record<LanguageErrorCode, number>> = {};
  for (const testCase of cases) {
    const measured = evaluateExpression(theory.measurement, testCase.inputs, variables);
    if (!measured.ok) {
      evaluationErrors[measured.error.code] = (evaluationErrors[measured.error.code] ?? 0) + 1;
      continue;
    }
    if (compare(measured.value, theory.operator, theory.threshold) === testCase.outcome) {
      correctPredictions++;
    }
  }
  const totalCases = cases.length;
  const accuracy = totalCases === 0 ? 0 : correctPredictions / totalCases;
  return {
    totalCases,
    correctPredictions,
    incorrectPredictions: totalCases - correctPredictions,
    accuracy,
    evaluationErrors,
    passThreshold,
    passed: accuracy >= passThreshold,
  };
}

function scoreNumeric(
  cases: readonly WorldCase<number>[],
  measurement: unknown,
  variables: VariableSet,
  tolerance: number,
  passThreshold: number,
): NumericDatasetReport {
  let scoredCases = 0;
  let absoluteSum = 0;
  let squaredSum = 0;
  let withinTolerance = 0;
  const evaluationErrors: Partial<Record<LanguageErrorCode, number>> = {};
  for (const testCase of cases) {
    const measured = evaluateExpression(measurement, testCase.inputs, variables);
    if (!measured.ok) {
      evaluationErrors[measured.error.code] = (evaluationErrors[measured.error.code] ?? 0) + 1;
      continue;
    }
    const error = Math.abs(measured.value - testCase.outcome);
    scoredCases++;
    absoluteSum += error;
    squaredSum += error * error;
    if (error <= tolerance) {
      withinTolerance++;
    }
  }
  const totalCases = cases.length;
  const withinToleranceRate = totalCases === 0 ? 0 : withinTolerance / totalCases;
  return {
    totalCases,
    scoredCases,
    meanAbsoluteError: scoredCases === 0 ? null : absoluteSum / scoredCases,
    rootMeanSquaredError: scoredCases === 0 ? null : Math.sqrt(squaredSum / scoredCases),
    withinTolerance,
    withinToleranceRate,
    evaluationErrors,
    passThreshold,
    passed: withinToleranceRate >= passThreshold,
  };
}

function drawInputs(world: World, random: RandomSource, region: EvaluationRegion): Record<string, number> {
  const { spec, extrapolation } = world;
  const inputs: Record<string, number> = {};
  for (const name of spec.attributeNames) {
    const range = spec.attributes[name]!;
    const width = range.max - range.min;
    if (region === "out-of-range" && extrapolation.outsideAttributes.includes(name)) {
      // At least a tenth of the range-width outside, matching Glow World's gap of 1 on 0 to 10.
      const offset = width / 10 + random() * width;
      inputs[name] = random() < 0.5 ? range.min - offset : range.max + offset;
    } else if (region === "out-of-range" && extrapolation.extendedAttributes.includes(name)) {
      inputs[name] = range.min - width + random() * width * 3;
    } else {
      inputs[name] = range.min + random() * width;
    }
  }
  return inputs;
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

/** Copies a validated (frozen) theory into a plain object so it can be re-validated for this world. */
function plainTheory(theory: unknown): unknown {
  try {
    return structuredClone(theory);
  } catch {
    return undefined;
  }
}

const variableSets = new Map<string, VariableSet>();

function variablesOf(world: World): VariableSet {
  const key = world.spec.attributeNames.join(",");
  let set = variableSets.get(key);
  if (set === undefined) {
    set = createVariableSet(world.spec.attributeNames);
    variableSets.set(key, set);
  }
  return set;
}

function validateCaseCount(world: World, caseCount: number): void {
  if (!Number.isInteger(caseCount) || caseCount < 2) {
    throw new Error("Case count must be an integer of at least 2.");
  }
  if (world.kind === "boolean" && caseCount % 2 !== 0) {
    throw new Error("Case count for a boolean world must be even.");
  }
}
