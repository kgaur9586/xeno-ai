/**
 * Baseline runner: runs one experimenter against fresh experiment tools and
 * reports descriptive exploration metrics.
 *
 * The metrics describe WHAT was explored (coverage, repeats, outcome counts).
 * They do not say how well the rule was discovered; that requires theories
 * scored by the evaluator, which arrives in Phase 4.
 */
import {
  DEFAULT_EXPERIMENT_BUDGET,
  createExperimentTools,
  type ExperimentTools,
} from "../tools/experiment-tools.js";
import type { ErrorCode, Observation, PublicDescription } from "../tools/schemas.js";
import type { AttributeRange, Experimenter } from "./experimenter.js";

export const HISTOGRAM_BIN_COUNT = 5;

export interface BaselineRunOptions {
  budget?: number;
}

export interface HistogramBin {
  from: number;
  to: number;
  count: number;
}

export interface AttributeSummary {
  min: number | null;
  max: number | null;
  mean: number | null;
  distinctValueCount: number;
  histogram: HistogramBin[];
}

export interface ObservationSummary {
  experimentCount: number;
  uniqueInputCount: number;
  repeatedExperimentCount: number;
  outcomeCounts: { glowing: number; notGlowing: number };
  attributes: { a: AttributeSummary; b: AttributeSummary; c: AttributeSummary };
}

export interface BaselineReport extends ObservationSummary {
  experimenter: string;
  budget: number;
  remainingBudget: number;
  requestCount: number;
  rejectedRequests: Record<ErrorCode, number>;
  observations: Observation[];
}

export function runBaseline(experimenter: Experimenter, options: BaselineRunOptions = {}): BaselineReport {
  const budget = options.budget ?? DEFAULT_EXPERIMENT_BUDGET;
  const tools = createExperimentTools({ budget });
  const description = tools.describeWorld();

  let requestCount = 0;
  const rejectedRequests: Record<ErrorCode, number> = { INVALID_INPUT: 0, BUDGET_EXHAUSTED: 0 };

  // Same four methods as the real tools; only adds request counting.
  const countingTools: ExperimentTools = {
    describeWorld: () => tools.describeWorld(),
    runExperiment(request) {
      requestCount++;
      const result = tools.runExperiment(request);
      if (!result.ok) {
        rejectedRequests[result.error.code]++;
      }
      return result;
    },
    getObservationLog: () => tools.getObservationLog(),
    getRemainingBudget: () => tools.getRemainingBudget(),
  };

  experimenter.run({ description, tools: countingTools });

  const observations = tools.getObservationLog();
  return {
    experimenter: experimenter.name,
    budget,
    remainingBudget: tools.getRemainingBudget(),
    requestCount,
    rejectedRequests: { ...rejectedRequests },
    ...summarizeObservations(observations, description),
    observations,
  };
}

export function summarizeObservations(
  observations: readonly Observation[],
  description: PublicDescription,
  binCount: number = HISTOGRAM_BIN_COUNT,
): ObservationSummary {
  const uniqueInputs = new Set(
    observations.map(({ inputs }) => `${inputs.a},${inputs.b},${inputs.c}`),
  );
  const glowing = observations.filter((observation) => observation.outcome.glows).length;

  return {
    experimentCount: observations.length,
    uniqueInputCount: uniqueInputs.size,
    repeatedExperimentCount: observations.length - uniqueInputs.size,
    outcomeCounts: { glowing, notGlowing: observations.length - glowing },
    attributes: {
      a: summarizeAttribute(observations.map(({ inputs }) => inputs.a), description.attributes.a, binCount),
      b: summarizeAttribute(observations.map(({ inputs }) => inputs.b), description.attributes.b, binCount),
      c: summarizeAttribute(observations.map(({ inputs }) => inputs.c), description.attributes.c, binCount),
    },
  };
}

function summarizeAttribute(values: number[], range: AttributeRange, binCount: number): AttributeSummary {
  const width = (range.max - range.min) / binCount;
  const histogram: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    from: range.min + width * i,
    to: range.min + width * (i + 1),
    count: 0,
  }));

  for (const value of values) {
    // Bins include their lower edge; the range maximum falls into the last bin.
    const index = width === 0 ? 0 : Math.min(Math.floor((value - range.min) / width), binCount - 1);
    histogram[index]!.count++;
  }

  if (values.length === 0) {
    return { min: null, max: null, mean: null, distinctValueCount: 0, histogram };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: sum / values.length,
    distinctValueCount: new Set(values).size,
    histogram,
  };
}
