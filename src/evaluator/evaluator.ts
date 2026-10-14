/**
 * Evaluator: generates held-out cases and scores predictors against them.
 *
 * It calls the world engine directly and never goes through the experiment
 * tools, so evaluation never uses the agent's budget or appears in its
 * observation log.
 */
import {
  ATTRIBUTE_MAX,
  ATTRIBUTE_MIN,
  computeGlowOutcome,
  type GlowInputs,
} from "../worlds/glow-world.js";
import type { LanguageErrorCode } from "../language/errors.js";
import { evaluateExpression } from "../language/interpreter.js";
import {
  isValidatedTheory,
  measureTheoryComplexity,
  type ComparisonOperator,
  type TheoryComplexity,
  type ValidatedTheory,
} from "../language/theory.js";
import { createSeededRandom, type RandomSource } from "../shared/random.js";

export interface EvaluationCase {
  inputs: GlowInputs;
  glows: boolean;
}

/** Phase 1 predictors are trusted TypeScript functions written by developers. */
export type Predictor = (inputs: GlowInputs) => boolean;

export interface EvaluationResult {
  caseCount: number;
  correct: number;
  accuracy: number;
}

export interface EvaluationOptions {
  seed: number;
  caseCount: number;
}

export interface TheoryEvaluationOptions {
  inRangeSeed: number;
  outOfRangeSeed: number;
  caseCount: number;
}

export interface TheoryDatasetMetrics {
  totalCases: number;
  correctPredictions: number;
  incorrectPredictions: number;
  accuracy: number;
  evaluationErrors: Partial<Record<LanguageErrorCode, number>>;
}

export interface TheoryEvaluationReport {
  inRange: TheoryDatasetMetrics;
  outOfRange: TheoryDatasetMetrics;
  complexity: TheoryComplexity;
}

/**
 * Generates `caseCount` cases within the permitted input ranges: exactly half
 * glowing and half not glowing. The same seed and count always produce the
 * same cases in the same order.
 */
export function generateEvaluationCases(seed: number, caseCount: number): EvaluationCase[] {
  validateCaseCount(caseCount);

  const random = createSeededRandom(seed);
  const perClass = caseCount / 2;
  const cases: EvaluationCase[] = [];
  let glowingCount = 0;
  let darkCount = 0;

  while (glowingCount < perClass || darkCount < perClass) {
    const inputs = {
      a: drawAttribute(random),
      b: drawAttribute(random),
      c: drawAttribute(random),
    };
    const { glows } = computeGlowOutcome(inputs);

    // Skip draws whose class is already full, so the set stays balanced.
    if (glows && glowingCount < perClass) {
      cases.push({ inputs, glows });
      glowingCount++;
    } else if (!glows && darkCount < perClass) {
      cases.push({ inputs, glows });
      darkCount++;
    }
  }

  return cases;
}

/** A descriptive Phase 4 name; the original export remains for compatibility. */
export const generateInRangeEvaluationCases = generateEvaluationCases;

/**
 * Generates balanced extrapolation cases without revealing them through the
 * experiment tools. `a` is always below the public minimum or above the public
 * maximum; `b` is drawn from one public-range-width beyond each side; and `c`
 * remains in range. Labels always come from the world engine.
 */
export function generateOutOfRangeEvaluationCases(
  seed: number,
  caseCount: number,
): EvaluationCase[] {
  validateCaseCount(caseCount);

  const random = createSeededRandom(seed);
  const perClass = caseCount / 2;
  const cases: EvaluationCase[] = [];
  let glowingCount = 0;
  let darkCount = 0;

  while (glowingCount < perClass || darkCount < perClass) {
    const inputs = {
      a: drawOutsidePublicRange(random),
      b: drawExtendedRelevantAttribute(random),
      c: drawAttribute(random),
    };
    const { glows } = computeGlowOutcome(inputs);

    if (glows && glowingCount < perClass) {
      cases.push({ inputs, glows });
      glowingCount++;
    } else if (!glows && darkCount < perClass) {
      cases.push({ inputs, glows });
      darkCount++;
    }
  }

  return cases;
}

export function scorePredictor(predictor: Predictor, cases: readonly EvaluationCase[]): EvaluationResult {
  let correct = 0;
  for (const testCase of cases) {
    // Pass a copy so a predictor cannot alter the evaluation cases.
    const prediction = predictor({ ...testCase.inputs });
    if (prediction === testCase.glows) {
      correct++;
    }
  }
  return {
    caseCount: cases.length,
    correct,
    accuracy: cases.length === 0 ? 0 : correct / cases.length,
  };
}

export function evaluatePredictor(predictor: Predictor, options: EvaluationOptions): EvaluationResult {
  return scorePredictor(predictor, generateEvaluationCases(options.seed, options.caseCount));
}

/**
 * Scores one validated theory on two independently seeded private datasets.
 * The report contains aggregate metrics only: no cases, labels, or seeds.
 */
export function evaluateTheory(
  theory: ValidatedTheory,
  options: TheoryEvaluationOptions,
): TheoryEvaluationReport {
  if (!isValidatedTheory(theory)) {
    throw new Error("Theory must be validated before evaluation.");
  }

  const inRangeCases = generateInRangeEvaluationCases(options.inRangeSeed, options.caseCount);
  const outOfRangeCases = generateOutOfRangeEvaluationCases(
    options.outOfRangeSeed,
    options.caseCount,
  );

  return {
    inRange: scoreTheory(theory, inRangeCases),
    outOfRange: scoreTheory(theory, outOfRangeCases),
    complexity: measureTheoryComplexity(theory),
  };
}

function scoreTheory(
  theory: ValidatedTheory,
  cases: readonly EvaluationCase[],
): TheoryDatasetMetrics {
  let correctPredictions = 0;
  const evaluationErrors: Partial<Record<LanguageErrorCode, number>> = {};

  for (const testCase of cases) {
    const measurement = evaluateExpression(theory.measurement, testCase.inputs);
    if (!measurement.ok) {
      const category = measurement.error.code;
      evaluationErrors[category] = (evaluationErrors[category] ?? 0) + 1;
      continue;
    }

    const prediction = compare(measurement.value, theory.operator, theory.threshold);
    if (prediction === testCase.glows) {
      correctPredictions++;
    }
  }

  const totalCases = cases.length;
  return {
    totalCases,
    correctPredictions,
    incorrectPredictions: totalCases - correctPredictions,
    accuracy: totalCases === 0 ? 0 : correctPredictions / totalCases,
    evaluationErrors,
  };
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

function drawAttribute(random: RandomSource): number {
  return ATTRIBUTE_MIN + random() * (ATTRIBUTE_MAX - ATTRIBUTE_MIN);
}

function drawOutsidePublicRange(random: RandomSource): number {
  const width = ATTRIBUTE_MAX - ATTRIBUTE_MIN;
  return random() < 0.5
    ? ATTRIBUTE_MIN - (1 + random() * width)
    : ATTRIBUTE_MAX + (1 + random() * width);
}

function drawExtendedRelevantAttribute(random: RandomSource): number {
  const width = ATTRIBUTE_MAX - ATTRIBUTE_MIN;
  return ATTRIBUTE_MIN - width + random() * width * 3;
}

function validateCaseCount(caseCount: number): void {
  if (!Number.isInteger(caseCount) || caseCount < 2 || caseCount % 2 !== 0) {
    throw new Error("Case count must be a positive even integer.");
  }
}
