/**
 * One discovery session.
 *
 * The agent loop runs to completion first. Only then, and only when a valid
 * theory was submitted, does this module score that theory. Scores, seeds,
 * and held-out cases stay here; they are not added to the transcript and the
 * provider is not called again.
 */
import { evaluateTheory, type TheoryEvaluationOptions, type TheoryEvaluationReport } from "../evaluator/evaluator.js";
import { createTheoryRegistry } from "../evaluator/theory-registry.js";
import { evaluateWorldTheoryById, type AnyWorldReport } from "../evaluator/world-evaluator.js";
import type { NumericTheory } from "../language/numeric-theory.js";
import type { Theory } from "../language/theory.js";
import { DEFAULT_EXPERIMENT_BUDGET, createExperimentTools } from "../tools/experiment-tools.js";
import type { AnyExperimentTools } from "../tools/public-types.js";
import { createWorldToolsById } from "../tools/world-tools.js";
import {
  runDiscoveryAgent,
  type DiscoveryAgentResult,
  type DiscoveryStatus,
  type TranscriptEntry,
} from "./discovery-agent.js";
import type { LlmProvider, ProviderErrorDiagnostic } from "../llm/provider.js";

export const GLOW_WORLD_SESSION_ID = "glow-world";

export interface DiscoverySessionOptions {
  provider: LlmProvider;
  /** Used only after the agent loop returns. Never sent to the provider. */
  evaluation: TheoryEvaluationOptions;
  /** Defaults to Glow World. */
  worldId?: string;
  /** Private seed for observation noise. Never sent to the provider. */
  noiseSeed?: number;
  budget?: number;
  maxModelTurns?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Scrubs transcript text. Never inserted into the prompt. */
  secrets?: readonly string[];
}

export interface DiscoverySessionResult {
  worldId: string;
  status: DiscoveryStatus;
  transcript: TranscriptEntry[];
  /** A boolean theory. Null when none was accepted. */
  submittedTheory: Theory | null;
  /** A numeric theory. Null when none was accepted. */
  submittedNumericTheory: NumericTheory | null;
  /** Operator-only Phase 4 report. Glow World only; null otherwise. */
  evaluation: TheoryEvaluationReport | null;
  /** Operator-only noise-aware report for any world. Null when no theory was accepted. */
  worldEvaluation: AnyWorldReport | null;
  /** Theory registry id. Glow World only; null otherwise. */
  theoryId: number | null;
  modelTurns: number;
  experimentCount: number;
  remainingBudget: number;
  /** Operator-only record of the seeds used after the session. */
  evaluationOptions: TheoryEvaluationOptions;
  /** Operator-only provider failure facts. Null when the provider did not stop the run. */
  providerDiagnostic: ProviderErrorDiagnostic | null;
}

export async function runDiscoverySession(options: DiscoverySessionOptions): Promise<DiscoverySessionResult> {
  const budget = options.budget ?? DEFAULT_EXPERIMENT_BUDGET;
  const worldId = options.worldId ?? GLOW_WORLD_SESSION_ID;
  const tools: AnyExperimentTools =
    worldId === GLOW_WORLD_SESSION_ID && options.noiseSeed === undefined
      ? createExperimentTools({ budget })
      : createWorldToolsById(worldId, { budget, noiseSeed: options.noiseSeed });
  const agentResult = await runDiscoveryAgent({
    provider: options.provider,
    tools,
    maxModelTurns: options.maxModelTurns,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    secrets: options.secrets,
  });

  const experimentCount = tools.getObservationLog().length;
  const remainingBudget = tools.getRemainingBudget();
  const scored = scoreAfterDiscovery(worldId, agentResult, options.evaluation);

  if (tools.getObservationLog().length !== experimentCount || tools.getRemainingBudget() !== remainingBudget) {
    throw new Error("Evaluation changed the investigation record.");
  }

  return {
    worldId,
    status: agentResult.status,
    transcript: agentResult.transcript,
    submittedTheory: agentResult.submittedTheory === null ? null : copyTheory(agentResult.submittedTheory),
    submittedNumericTheory:
      agentResult.submittedNumericTheory === null
        ? null
        : { measurement: structuredClone(agentResult.submittedNumericTheory.measurement) },
    evaluation: scored.evaluation,
    worldEvaluation: scored.worldEvaluation,
    theoryId: scored.theoryId,
    modelTurns: agentResult.modelTurns,
    experimentCount,
    remainingBudget,
    providerDiagnostic:
      agentResult.providerDiagnostic === null
        ? null
        : {
            category: agentResult.providerDiagnostic.category,
            httpStatus: agentResult.providerDiagnostic.httpStatus,
            message: agentResult.providerDiagnostic.message,
          },
    evaluationOptions: {
      inRangeSeed: options.evaluation.inRangeSeed,
      outOfRangeSeed: options.evaluation.outOfRangeSeed,
      caseCount: options.evaluation.caseCount,
    },
  };
}

function scoreAfterDiscovery(
  worldId: string,
  agentResult: DiscoveryAgentResult,
  evaluation: TheoryEvaluationOptions,
): { evaluation: TheoryEvaluationReport | null; worldEvaluation: AnyWorldReport | null; theoryId: number | null } {
  const submitted = agentResult.submittedTheory ?? agentResult.submittedNumericTheory;
  if (submitted === null) {
    return { evaluation: null, worldEvaluation: null, theoryId: null };
  }

  const world = evaluateWorldTheoryById(worldId, submitted, evaluation);
  const worldEvaluation = world.ok ? world.report : null;
  if (worldId !== GLOW_WORLD_SESSION_ID || agentResult.submittedTheory === null) {
    return { evaluation: null, worldEvaluation, theoryId: null };
  }

  const report = evaluateTheory(agentResult.submittedTheory, evaluation);
  const record = createTheoryRegistry().register(agentResult.submittedTheory, report);
  return { evaluation: record.evaluation, worldEvaluation, theoryId: record.id };
}

function copyTheory(theory: Theory): Theory {
  return {
    measurement: structuredClone(theory.measurement),
    operator: theory.operator,
    threshold: theory.threshold,
  };
}
