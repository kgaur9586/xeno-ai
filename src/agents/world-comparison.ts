/**
 * Scores one agent and the Phase 2 baselines on any registered world, at one
 * shared budget and one shared private noise seed.
 *
 * Each strategy gets fresh tools for the same world. Baseline theories come
 * from the observation catalog (boolean worlds) or the least-squares catalog
 * (numeric worlds). The evaluator runs only after every strategy has stopped.
 */
import {
  evaluateWorldTheoryById,
  type AnyWorldReport,
  type WorldEvaluationOptions,
} from "../evaluator/world-evaluator.js";
import { createDummyProvider } from "../llm/dummy-provider.js";
import type { LlmProvider } from "../llm/provider.js";
import type { AnyObservation, AnyWorldDescription } from "../tools/public-types.js";
import { createWorldToolsById, DEFAULT_NOISE_SEED, type WorldTools } from "../tools/world-tools.js";
import { BASELINE_COMPARISON_BUDGET, BASELINE_COMPARISON_SEED } from "./baseline-comparison.js";
import type { DiscoveryStatus, TranscriptEntry } from "./discovery-agent.js";
import {
  BASELINE_FIT_NOTE,
  CALLER_EXPLORATION_NOTE,
  DISCOVERY_COMPARISON_EVALUATION,
  IN_SAMPLE_NOTE,
  formatExpression,
  formatTable,
  formatTheory,
} from "./discovery-comparison.js";
import { runDiscoverySession } from "./discovery-session.js";
import { RUN_EXPERIMENT_TOOL } from "./discovery-tool-declarations.js";
import type { Experimenter } from "./experimenter.js";
import {
  fitNumericTheoryFromObservations,
  fitTheoryFromObservations,
  readObservedRow,
  scoreNumericTheoryOnObservations,
  scoreTheoryOnObservations,
  type ObservedRow,
  type PublicRanges,
} from "./observation-theorist.js";
import { createRandomExplorer } from "./random-explorer.js";
import { createSystematicExplorer } from "./systematic-explorer.js";

export const WORLD_DUMMY_EXPLORATION_NOTE =
  "The dummy provider runs the public minimum, midpoint, and maximum grid when it has at most 27 points, otherwise a fixed-seed random design inside the public ranges. It then submits the catalog theory that best fits those observations.";

export const NUMERIC_FIT_NOTE =
  "For a numeric outcome the in-sample column is root mean squared error (lower is better). The evaluator reports root mean squared error and whether the within-tolerance rate passed.";

export interface WorldComparisonOptions {
  worldId: string;
  budget?: number;
  /** Random explorer seed. */
  seed?: number;
  /** Private observation noise seed shared by every strategy. */
  noiseSeed?: number;
  evaluation?: WorldEvaluationOptions;
  /** Defaults to the scripted dummy provider. */
  provider?: LlmProvider;
  liveModel?: boolean;
  maxModelTurns?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

/** Plain copy of a submitted or fitted theory. `operator` and `threshold` are absent for numeric worlds. */
export interface ComparedTheory {
  measurement: unknown;
  operator?: string;
  threshold?: number;
}

export interface WorldScoredStrategy {
  name: string;
  experimentCount: number;
  remainingBudget: number;
  /** Accuracy for boolean worlds, root mean squared error for numeric worlds. */
  inSample: number | null;
  theory: ComparedTheory | null;
  evaluation: AnyWorldReport | null;
}

export interface WorldComparisonReport {
  worldId: string;
  outcomeKind: "boolean" | "number";
  budget: number;
  seed: number;
  noiseSeed: number;
  evaluationOptions: WorldEvaluationOptions;
  liveModel: boolean;
  agent: WorldScoredStrategy & { status: DiscoveryStatus; modelTurns: number };
  baselines: WorldScoredStrategy[];
  notes: { model: string; fit: string; exploration: string; inSample: string };
}

export async function runWorldComparison(options: WorldComparisonOptions): Promise<WorldComparisonReport> {
  const budget = options.budget ?? BASELINE_COMPARISON_BUDGET;
  const seed = options.seed ?? BASELINE_COMPARISON_SEED;
  const noiseSeed = options.noiseSeed ?? DEFAULT_NOISE_SEED;
  const evaluation: WorldEvaluationOptions = options.evaluation ?? {
    inRangeSeed: DISCOVERY_COMPARISON_EVALUATION.inRangeSeed,
    outOfRangeSeed: DISCOVERY_COMPARISON_EVALUATION.outOfRangeSeed,
    caseCount: DISCOVERY_COMPARISON_EVALUATION.caseCount,
  };
  const provider = options.provider ?? createDummyProvider();
  const liveModel = options.liveModel ?? false;

  const description = createWorldToolsById(options.worldId, { budget, noiseSeed }).describeWorld();
  const outcomeKind = Object.values(description.outcome)[0]!;
  const ranges = rangesOf(description);

  const explored: Array<{ experimenter: Experimenter; tools: WorldTools }> = [
    createRandomExplorer({ seed }),
    createSystematicExplorer(),
  ].map((experimenter) => {
    const tools = createWorldToolsById(options.worldId, { budget, noiseSeed });
    experimenter.run({ description: tools.describeWorld(), tools });
    return { experimenter, tools };
  });

  const session = await runDiscoverySession({
    provider,
    worldId: options.worldId,
    noiseSeed,
    budget,
    maxModelTurns: options.maxModelTurns ?? budget + 2,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries ?? 0,
    evaluation,
  });

  const baselines = explored.map(({ experimenter, tools }) => {
    const rows = rowsFromObservations(tools.getObservationLog());
    const theory = fitCatalogTheory(outcomeKind, ranges, rows);
    return {
      name: experimenter.name,
      experimentCount: tools.getObservationLog().length,
      remainingBudget: tools.getRemainingBudget(),
      inSample: theory.inSample,
      theory: theory.theory,
      evaluation: scoreWithEvaluator(options.worldId, theory.theory, evaluation),
    };
  });

  const agentTheory: ComparedTheory | null =
    session.submittedTheory !== null
      ? {
          measurement: structuredClone(session.submittedTheory.measurement),
          operator: session.submittedTheory.operator,
          threshold: session.submittedTheory.threshold,
        }
      : session.submittedNumericTheory !== null
        ? { measurement: structuredClone(session.submittedNumericTheory.measurement) }
        : null;
  const agentRows = rowsFromTranscript(session.transcript);

  return {
    worldId: options.worldId,
    outcomeKind,
    budget,
    seed,
    noiseSeed,
    evaluationOptions: { ...evaluation },
    liveModel,
    agent: {
      name: provider.name,
      status: session.status,
      modelTurns: session.modelTurns,
      experimentCount: session.experimentCount,
      remainingBudget: session.remainingBudget,
      inSample: agentTheory === null ? null : inSampleScore(outcomeKind, agentTheory, agentRows),
      theory: agentTheory,
      evaluation: session.worldEvaluation === null ? null : structuredClone(session.worldEvaluation),
    },
    baselines,
    notes: {
      model: liveModel
        ? `LIVE MODEL: ${provider.name}. The scores below are this run only.`
        : `NOT A LIVE MODEL. No API request was sent. The agent provider is "${provider.name}". This is not a Gemini result.`,
      fit: BASELINE_FIT_NOTE,
      exploration: options.provider === undefined ? WORLD_DUMMY_EXPLORATION_NOTE : CALLER_EXPLORATION_NOTE,
      inSample: outcomeKind === "number" ? `${IN_SAMPLE_NOTE} ${NUMERIC_FIT_NOTE}` : IN_SAMPLE_NOTE,
    },
  };
}

export function formatWorldComparison(report: WorldComparisonReport): string {
  const numeric = report.outcomeKind === "number";
  const header = numeric
    ? ["Strategy", "Experiments", "Budget left", "In-sample RMSE", "In-range RMSE", "Pass", "Out-of-range RMSE", "Pass"]
    : ["Strategy", "Experiments", "Budget left", "In-sample", "In-range", "Pass", "Out-of-range", "Pass"];
  const rows: string[][] = [header, strategyRow(report.agent), ...report.baselines.map(strategyRow)];

  return [
    `XENO discovery comparison: ${report.worldId}`,
    report.notes.model,
    "",
    `Equal experiment budget: ${report.budget}`,
    `Random explorer seed: ${report.seed}`,
    `Evaluation cases: ${report.evaluationOptions.caseCount}`,
    `In-range seed: ${report.evaluationOptions.inRangeSeed}`,
    `Out-of-range seed: ${report.evaluationOptions.outOfRangeSeed}`,
    `Agent status: ${report.agent.status} (${report.agent.modelTurns} model turns)`,
    "",
    ...formatTable(rows),
    "",
    "Theories",
    `${report.agent.name}: ${formatComparedTheory(report.agent.theory)}`,
    ...report.baselines.map((strategy) => `${strategy.name}: ${formatComparedTheory(strategy.theory)}`),
    "",
    report.notes.fit,
    report.notes.exploration,
    report.notes.inSample,
  ].join("\n");
}

function fitCatalogTheory(
  outcomeKind: "boolean" | "number",
  ranges: PublicRanges,
  rows: readonly ObservedRow[],
): { theory: ComparedTheory; inSample: number | null } {
  if (outcomeKind === "number") {
    const fitted = fitNumericTheoryFromObservations(ranges, rows);
    return {
      theory: { measurement: structuredClone(fitted.theory.measurement) },
      inSample: fitted.inSampleRmse,
    };
  }
  const fitted = fitTheoryFromObservations(ranges, rows);
  return {
    theory: {
      measurement: structuredClone(fitted.theory.measurement),
      operator: fitted.theory.operator,
      threshold: fitted.theory.threshold,
    },
    inSample: fitted.inSampleAccuracy,
  };
}

function inSampleScore(
  outcomeKind: "boolean" | "number",
  theory: ComparedTheory,
  rows: readonly ObservedRow[],
): number | null {
  if (outcomeKind === "number") {
    return scoreNumericTheoryOnObservations({ measurement: theory.measurement }, rows);
  }
  return scoreTheoryOnObservations(theory, rows);
}

function scoreWithEvaluator(
  worldId: string,
  theory: ComparedTheory,
  evaluation: WorldEvaluationOptions,
): AnyWorldReport | null {
  const result = evaluateWorldTheoryById(worldId, theory, evaluation);
  return result.ok ? result.report : null;
}

function rangesOf(description: AnyWorldDescription): PublicRanges {
  const ranges: Record<string, { min: number; max: number }> = {};
  for (const [name, bounds] of Object.entries(description.attributes)) {
    ranges[name] = { min: bounds.min, max: bounds.max };
  }
  return ranges;
}

function rowsFromObservations(observations: readonly AnyObservation[]): ObservedRow[] {
  return observations.map((observation) => ({
    inputs: { ...observation.inputs },
    outcome: Object.values(observation.outcome)[0]!,
  }));
}

function rowsFromTranscript(transcript: readonly TranscriptEntry[]): ObservedRow[] {
  const rows: ObservedRow[] = [];
  for (const entry of transcript) {
    if (entry.type !== "tool_result" || entry.name !== RUN_EXPERIMENT_TOOL) {
      continue;
    }
    const row = readObservedRow(entry.output);
    if (row !== null) {
      rows.push(row);
    }
  }
  return rows;
}

function strategyRow(strategy: WorldScoredStrategy): string[] {
  const report = strategy.evaluation;
  if (report === null) {
    return [strategy.name, String(strategy.experimentCount), String(strategy.remainingBudget), formatNumber(strategy.inSample), "n/a", "n/a", "n/a", "n/a"];
  }
  const inRange = report.kind === "number" ? report.inRange.rootMeanSquaredError : report.inRange.accuracy;
  const outOfRange = report.kind === "number" ? report.outOfRange.rootMeanSquaredError : report.outOfRange.accuracy;
  return [
    strategy.name,
    String(strategy.experimentCount),
    String(strategy.remainingBudget),
    formatNumber(strategy.inSample),
    formatNumber(inRange),
    report.inRange.passed ? "yes" : "no",
    formatNumber(outOfRange),
    report.outOfRange.passed ? "yes" : "no",
  ];
}

function formatComparedTheory(theory: ComparedTheory | null): string {
  if (theory === null) {
    return "none";
  }
  if (theory.operator === undefined || theory.threshold === undefined) {
    return formatExpression(theory.measurement);
  }
  return formatTheory({ measurement: theory.measurement, operator: theory.operator, threshold: theory.threshold });
}

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }
  return value.toFixed(4);
}
