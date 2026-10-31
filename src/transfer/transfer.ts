/**
 * Transfer metrics: does a theory found in one world still work in another?
 *
 * 1. The theory is scored in the source world and, unchanged, in the target
 *    world. "Unchanged" is not applicable when the theory names attributes
 *    the target does not have, or predicts the wrong kind of outcome.
 * 2. If it does not pass unchanged, it is adapted: experiments are run in
 *    the target in seeded batches through the ordinary world tools, and after
 *    each batch the theory is refitted on every observation so far (see
 *    `refit.ts`). The refit reads only observations and public ranges.
 * 3. `experimentsToAdapt` is the number of target experiments after which the
 *    refitted theory first passes the held-out evaluation in range and out of
 *    range. It is 0 when the unchanged theory already passes and null when no
 *    refit passed within the experiment limit.
 *
 * Operator-side code: it handles world objects and held-out scores, so it
 * must never be imported by an agent.
 */
import {
  evaluateWorldTheory,
  type AnyWorldReport,
  type WorldEvaluationOptions,
} from "../evaluator/world-evaluator.js";
import { createSeededRandom } from "../shared/random.js";
import { createWorldTools } from "../tools/world-tools.js";
import type { World } from "../worlds/world.js";
import { refitTheory, type TransferRow, type TransferTheory } from "./refit.js";

export const DEFAULT_ADAPTATION = {
  batchSize: 10,
  maxExperiments: 200,
  noiseSeed: 1,
  designSeed: 2026,
} as const;

export type AdaptationOptions = { [K in keyof typeof DEFAULT_ADAPTATION]: number };

export interface TransferOptions {
  evaluation: WorldEvaluationOptions;
  adaptation?: Partial<AdaptationOptions>;
}

export type UnchangedReason = "UNKNOWN_ATTRIBUTE" | "OUTCOME_KIND_MISMATCH";

export interface AdaptationStep {
  experiments: number;
  inSample: number | null;
  mapping: Record<string, string> | null;
  inRangePassed: boolean;
  outOfRangePassed: boolean;
}

export interface TransferReport {
  sourceWorldId: string;
  targetWorldId: string;
  source: AnyWorldReport | null;
  sourcePassed: boolean;
  /** Null when the unchanged theory is not applicable to the target. */
  unchanged: AnyWorldReport | null;
  unchangedReason: UnchangedReason | null;
  transfersUnchanged: boolean;
  experimentsToAdapt: number | null;
  adaptedTheory: TransferTheory | null;
  adaptedMapping: Record<string, string> | null;
  adaptedReport: AnyWorldReport | null;
  experimentsRun: number;
  steps: AdaptationStep[];
  evaluationOptions: WorldEvaluationOptions;
  adaptationOptions: AdaptationOptions;
}

export function runTransfer(source: World, target: World, theory: TransferTheory, options: TransferOptions): TransferReport {
  const adaptation: AdaptationOptions = { ...DEFAULT_ADAPTATION, ...options.adaptation };
  if (!Number.isInteger(adaptation.batchSize) || adaptation.batchSize < 1) {
    throw new Error("Batch size must be a positive integer.");
  }
  if (!Number.isInteger(adaptation.maxExperiments) || adaptation.maxExperiments < 1) {
    throw new Error("Experiment limit must be a positive integer.");
  }
  const evaluation = { ...options.evaluation };

  const sourceReport = score(source, theory, evaluation);
  const kindMatches = theoryKind(theory) === target.kind;
  const unchanged = kindMatches ? score(target, theory, evaluation) : null;
  const unchangedReason: UnchangedReason | null = !kindMatches
    ? "OUTCOME_KIND_MISMATCH"
    : unchanged === null
      ? "UNKNOWN_ATTRIBUTE"
      : null;

  const base = {
    sourceWorldId: source.spec.worldId,
    targetWorldId: target.spec.worldId,
    source: sourceReport,
    sourcePassed: passes(sourceReport),
    unchanged,
    unchangedReason,
    evaluationOptions: evaluation,
    adaptationOptions: adaptation,
  };

  if (passes(unchanged)) {
    return {
      ...base,
      transfersUnchanged: true,
      experimentsToAdapt: 0,
      adaptedTheory: copyTheory(theory),
      adaptedMapping: identityMapping(theory),
      adaptedReport: unchanged,
      experimentsRun: 0,
      steps: [],
    };
  }

  const failed = {
    ...base,
    transfersUnchanged: false,
    experimentsToAdapt: null,
    adaptedTheory: null,
    adaptedMapping: null,
    adaptedReport: null,
  };
  if (!kindMatches) {
    return { ...failed, experimentsRun: 0, steps: [] };
  }

  const tools = createWorldTools(target, { budget: adaptation.maxExperiments, noiseSeed: adaptation.noiseSeed });
  const description = tools.describeWorld();
  const names = Object.keys(description.attributes);
  const design = createSeededRandom(adaptation.designSeed);
  const refitTarget = { attributeNames: names, ranges: description.attributes, outcomeKind: target.kind };
  const steps: AdaptationStep[] = [];

  while (tools.getRemainingBudget() > 0) {
    const batch = Math.min(adaptation.batchSize, tools.getRemainingBudget());
    for (let index = 0; index < batch; index++) {
      const request: Record<string, number> = {};
      for (const name of names) {
        const range = description.attributes[name]!;
        request[name] = range.min + design() * (range.max - range.min);
      }
      const result = tools.runExperiment(request);
      if (!result.ok) {
        throw new Error("Adaptation experiment was rejected.");
      }
    }

    const rows: TransferRow[] = tools.getObservationLog().map((observation) => ({
      inputs: observation.inputs,
      outcome: Object.values(observation.outcome)[0]!,
    }));
    const refit = refitTheory(theory, refitTarget, rows);
    const report = refit === null ? null : score(target, refit.theory, evaluation);
    steps.push({
      experiments: rows.length,
      inSample: refit?.inSample ?? null,
      mapping: refit === null ? null : { ...refit.mapping },
      inRangePassed: report?.inRange.passed ?? false,
      outOfRangePassed: report?.outOfRange.passed ?? false,
    });
    if (refit !== null && passes(report)) {
      return {
        ...base,
        transfersUnchanged: false,
        experimentsToAdapt: rows.length,
        adaptedTheory: copyTheory(refit.theory),
        adaptedMapping: { ...refit.mapping },
        adaptedReport: report,
        experimentsRun: rows.length,
        steps,
      };
    }
  }
  return { ...failed, experimentsRun: tools.getObservationLog().length, steps };
}

export function passes(report: AnyWorldReport | null): boolean {
  return report !== null && report.inRange.passed && report.outOfRange.passed;
}

function score(world: World, theory: TransferTheory, evaluation: WorldEvaluationOptions): AnyWorldReport | null {
  if (theoryKind(theory) !== world.kind) {
    return null;
  }
  const result = evaluateWorldTheory(world, copyTheory(theory), evaluation);
  return result.ok ? result.report : null;
}

function theoryKind(theory: TransferTheory): "boolean" | "number" {
  return theory.operator === undefined && theory.threshold === undefined ? "number" : "boolean";
}

function copyTheory(theory: TransferTheory): TransferTheory {
  return theoryKind(theory) === "number"
    ? { measurement: structuredClone(theory.measurement) }
    : { measurement: structuredClone(theory.measurement), operator: theory.operator!, threshold: theory.threshold! };
}

function identityMapping(theory: TransferTheory): Record<string, string> {
  const names = new Set<string>();
  const pending: unknown[] = [theory.measurement];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null) {
      continue;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.var === "string") {
      names.add(record.var);
    }
    pending.push(record.left, record.right, ...(Array.isArray(record.args) ? record.args : []));
  }
  return Object.fromEntries([...names].sort().map((name) => [name, name]));
}
