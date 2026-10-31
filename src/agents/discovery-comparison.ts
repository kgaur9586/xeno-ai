/**
 * Scores one agent and the Phase 2 baselines at one shared budget.
 *
 * Baseline theories come from the observation catalog. The agent's theory is
 * whatever its provider submitted. The evaluator runs only after each
 * strategy has stopped.
 */
import { evaluateTheory, type TheoryEvaluationOptions, type TheoryEvaluationReport } from "../evaluator/evaluator.js";
import type { Theory, ValidatedTheory } from "../language/theory.js";
import type { DiscoveryStatus, TranscriptEntry } from "./discovery-agent.js";
import type { Experimenter } from "./experimenter.js";
import { runDiscoverySession } from "./discovery-session.js";
import {
  fitTheoryFromObservations,
  readObservedRow,
  scoreTheoryOnObservations,
  type ObservedRow,
  type PublicRanges,
} from "./observation-theorist.js";
import { BASELINE_COMPARISON_BUDGET, BASELINE_COMPARISON_SEED } from "./baseline-comparison.js";
import { runBaseline } from "./baseline-runner.js";
import { RUN_EXPERIMENT_TOOL } from "./discovery-tool-declarations.js";
import { createRandomExplorer } from "./random-explorer.js";
import { createSystematicExplorer } from "./systematic-explorer.js";
import { createDummyProvider } from "../llm/dummy-provider.js";
import type { LlmProvider } from "../llm/provider.js";
import { createExperimentTools } from "../tools/experiment-tools.js";
import type { Observation } from "../tools/schemas.js";

export const DISCOVERY_COMPARISON_EVALUATION = {
  inRangeSeed: 424242,
  outOfRangeSeed: 737373,
  caseCount: 200,
} as const;

export const BASELINE_FIT_NOTE =
  "Each baseline is a Phase 2 explorer plus one theory chosen from a catalog. The catalog uses only the public ranges and the observations. It does not read the world engine.";

export const DUMMY_EXPLORATION_NOTE =
  "The dummy provider runs the public minimum, midpoint, and maximum grid, the same grid as the systematic explorer, then submits the catalog theory that best fits those observations.";

export const CALLER_EXPLORATION_NOTE =
  "The agent provider was supplied by the caller. Its experiments are whatever that provider requested.";

export const MIDPOINT_CAVEAT =
  "The catalog's only numeric constants are zero and each public range midpoint. In Glow World that midpoint coincides with the private threshold. See docs/ARCHITECTURE.md section 7. A high score here is not a live-model discovery.";

export const IN_SAMPLE_NOTE =
  "In-sample accuracy is the fit on that strategy's own observations. In-range and out-of-range accuracy come from the evaluator afterward. Fitting never sees those cases.";

const OPERATOR_SYMBOL: Record<string, string> = {
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

const EXPRESSION_SYMBOL: Record<string, string> = {
  add: "+",
  sub: "-",
  mul: "*",
  div: "/",
};

export interface DiscoveryComparisonOptions {
  budget?: number;
  seed?: number;
  evaluation?: TheoryEvaluationOptions;
  /** Defaults to the scripted dummy provider. */
  provider?: LlmProvider;
  /** True only for an opted-in live model run. */
  liveModel?: boolean;
  maxModelTurns?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ScoredStrategy {
  name: string;
  experimentCount: number;
  remainingBudget: number;
  inSampleAccuracy: number | null;
  theory: Theory | null;
  evaluation: TheoryEvaluationReport | null;
}

export interface DiscoveryComparisonReport {
  budget: number;
  seed: number;
  evaluationOptions: TheoryEvaluationOptions;
  liveModel: boolean;
  agent: ScoredStrategy & { status: DiscoveryStatus; modelTurns: number };
  baselines: ScoredStrategy[];
  notes: {
    model: string;
    fit: string;
    exploration: string;
    midpoint: string;
    inSample: string;
  };
}

export async function runDiscoveryComparison(
  options: DiscoveryComparisonOptions = {},
): Promise<DiscoveryComparisonReport> {
  const budget = options.budget ?? BASELINE_COMPARISON_BUDGET;
  const seed = options.seed ?? BASELINE_COMPARISON_SEED;
  const evaluation: TheoryEvaluationOptions = options.evaluation ?? {
    inRangeSeed: DISCOVERY_COMPARISON_EVALUATION.inRangeSeed,
    outOfRangeSeed: DISCOVERY_COMPARISON_EVALUATION.outOfRangeSeed,
    caseCount: DISCOVERY_COMPARISON_EVALUATION.caseCount,
  };
  const provider = options.provider ?? createDummyProvider();
  const liveModel = options.liveModel ?? false;
  const ranges = rangesFromDescription(budget);

  const baselines = [createRandomExplorer({ seed }), createSystematicExplorer()].map((experimenter) =>
    scoreBaseline(experimenter, budget, ranges, evaluation),
  );

  const session = await runDiscoverySession({
    provider,
    budget,
    maxModelTurns: options.maxModelTurns ?? budget + 2,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries ?? 0,
    evaluation,
  });
  const agentRows = rowsFromTranscript(session.transcript);

  return {
    budget,
    seed,
    evaluationOptions: {
      inRangeSeed: evaluation.inRangeSeed,
      outOfRangeSeed: evaluation.outOfRangeSeed,
      caseCount: evaluation.caseCount,
    },
    liveModel,
    agent: {
      name: provider.name,
      status: session.status,
      modelTurns: session.modelTurns,
      experimentCount: session.experimentCount,
      remainingBudget: session.remainingBudget,
      inSampleAccuracy:
        session.submittedTheory === null ? null : scoreTheoryOnObservations(session.submittedTheory, agentRows),
      theory: session.submittedTheory === null ? null : structuredClone(session.submittedTheory),
      evaluation: session.evaluation === null ? null : structuredClone(session.evaluation),
    },
    baselines,
    notes: {
      model: liveModel
        ? `LIVE MODEL: ${provider.name}. The scores below are this run only.`
        : `NOT A LIVE MODEL. No API request was sent. The agent provider is "${provider.name}". This is not a Gemini result.`,
      fit: BASELINE_FIT_NOTE,
      exploration: options.provider === undefined ? DUMMY_EXPLORATION_NOTE : CALLER_EXPLORATION_NOTE,
      midpoint: MIDPOINT_CAVEAT,
      inSample: IN_SAMPLE_NOTE,
    },
  };
}

export function formatDiscoveryComparison(report: DiscoveryComparisonReport): string {
  const rows: string[][] = [
    ["Strategy", "Experiments", "Budget left", "In-sample", "In-range", "Out-of-range"],
    strategyRow(report.agent),
    ...report.baselines.map((strategy) => strategyRow(strategy)),
  ];

  return [
    "XENO discovery comparison",
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
    `${report.agent.name}: ${formatTheory(report.agent.theory)}`,
    ...report.baselines.map((strategy) => `${strategy.name}: ${formatTheory(strategy.theory)}`),
    "",
    report.notes.fit,
    report.notes.exploration,
    report.notes.inSample,
    report.notes.midpoint,
  ].join("\n");
}

function scoreBaseline(
  experimenter: Experimenter,
  budget: number,
  ranges: PublicRanges,
  evaluation: TheoryEvaluationOptions,
): ScoredStrategy {
  const baseline = runBaseline(experimenter, { budget });
  const fitted = fitTheoryFromObservations(ranges, rowsFromObservations(baseline.observations));
  return {
    name: baseline.experimenter,
    experimentCount: baseline.experimentCount,
    remainingBudget: baseline.remainingBudget,
    inSampleAccuracy: fitted.inSampleAccuracy,
    theory: copyTheory(fitted.theory),
    evaluation: evaluateTheory(fitted.theory, evaluation),
  };
}

function rangesFromDescription(budget: number): PublicRanges {
  const description = createExperimentTools({ budget }).describeWorld();
  return {
    a: { min: description.attributes.a.min, max: description.attributes.a.max },
    b: { min: description.attributes.b.min, max: description.attributes.b.max },
    c: { min: description.attributes.c.min, max: description.attributes.c.max },
  };
}

function rowsFromObservations(observations: readonly Observation[]): ObservedRow[] {
  return observations.map((observation) => ({
    inputs: {
      a: observation.inputs.a,
      b: observation.inputs.b,
      c: observation.inputs.c,
    },
    outcome: observation.outcome.glows,
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

function copyTheory(theory: ValidatedTheory): Theory {
  return {
    measurement: structuredClone(theory.measurement),
    operator: theory.operator,
    threshold: theory.threshold,
  };
}

function strategyRow(strategy: ScoredStrategy): string[] {
  return [
    strategy.name,
    String(strategy.experimentCount),
    String(strategy.remainingBudget),
    formatAccuracy(strategy.inSampleAccuracy),
    formatAccuracy(strategy.evaluation?.inRange.accuracy ?? null),
    formatAccuracy(strategy.evaluation?.outOfRange.accuracy ?? null),
  ];
}

function formatAccuracy(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }
  return value.toFixed(4);
}

export function formatTheory(
  theory: { measurement: unknown; operator: string; threshold: number } | null,
): string {
  if (theory === null) {
    return "none";
  }
  const symbol = OPERATOR_SYMBOL[theory.operator] ?? theory.operator;
  return `${formatExpression(theory.measurement)} ${symbol} ${theory.threshold}`;
}

export function formatExpression(expression: unknown): string {
  if (typeof expression !== "object" || expression === null) {
    return "?";
  }
  if ("const" in expression && typeof expression.const === "number") {
    return String(expression.const);
  }
  if ("var" in expression && typeof expression.var === "string") {
    return expression.var;
  }
  if ("op" in expression && "left" in expression && "right" in expression && typeof expression.op === "string") {
    const symbol = EXPRESSION_SYMBOL[expression.op] ?? expression.op;
    return `(${formatExpression(expression.left)} ${symbol} ${formatExpression(expression.right)})`;
  }
  if ("fn" in expression && "args" in expression && typeof expression.fn === "string" && Array.isArray(expression.args)) {
    return `${expression.fn}(${expression.args.map((argument: unknown) => formatExpression(argument)).join(", ")})`;
  }
  return "?";
}

export function formatTable(rows: string[][]): string[] {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  const lines = rows.map((row) =>
    row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd(),
  );
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [lines[0]!, separator, ...lines.slice(1)];
}
