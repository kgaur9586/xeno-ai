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
import { createSeededRandom, type RandomSource } from "./random.js";

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

/**
 * Generates `caseCount` cases within the permitted input ranges: exactly half
 * glowing and half not glowing. The same seed and count always produce the
 * same cases in the same order.
 */
export function generateEvaluationCases(seed: number, caseCount: number): EvaluationCase[] {
  if (!Number.isInteger(caseCount) || caseCount < 2 || caseCount % 2 !== 0) {
    throw new Error("Case count must be a positive even integer.");
  }

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

function drawAttribute(random: RandomSource): number {
  return ATTRIBUTE_MIN + random() * (ATTRIBUTE_MAX - ATTRIBUTE_MIN);
}
