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
import type { Theory } from "../language/theory.js";
import { DEFAULT_EXPERIMENT_BUDGET, createExperimentTools } from "../tools/experiment-tools.js";
import {
  runDiscoveryAgent,
  type DiscoveryAgentResult,
  type DiscoveryStatus,
  type TranscriptEntry,
} from "./discovery-agent.js";
import type { LlmProvider } from "../llm/provider.js";

export interface DiscoverySessionOptions {
  provider: LlmProvider;
  /** Used only after the agent loop returns. Never sent to the provider. */
  evaluation: TheoryEvaluationOptions;
  budget?: number;
  maxModelTurns?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Scrubs transcript text. Never inserted into the prompt. */
  secrets?: readonly string[];
}

export interface DiscoverySessionResult {
  status: DiscoveryStatus;
  transcript: TranscriptEntry[];
  submittedTheory: Theory | null;
  /** Operator-only. Null when the agent did not submit a valid theory. */
  evaluation: TheoryEvaluationReport | null;
  theoryId: number | null;
  modelTurns: number;
  experimentCount: number;
  remainingBudget: number;
  /** Operator-only record of the seeds used after the session. */
  evaluationOptions: TheoryEvaluationOptions;
}

export async function runDiscoverySession(options: DiscoverySessionOptions): Promise<DiscoverySessionResult> {
  const budget = options.budget ?? DEFAULT_EXPERIMENT_BUDGET;
  const tools = createExperimentTools({ budget });
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
  const scored = scoreAfterDiscovery(agentResult, options.evaluation);

  if (tools.getObservationLog().length !== experimentCount || tools.getRemainingBudget() !== remainingBudget) {
    throw new Error("Evaluation changed the investigation record.");
  }

  return {
    status: agentResult.status,
    transcript: agentResult.transcript,
    submittedTheory: agentResult.submittedTheory === null ? null : copyTheory(agentResult.submittedTheory),
    evaluation: scored.evaluation,
    theoryId: scored.theoryId,
    modelTurns: agentResult.modelTurns,
    experimentCount,
    remainingBudget,
    evaluationOptions: {
      inRangeSeed: options.evaluation.inRangeSeed,
      outOfRangeSeed: options.evaluation.outOfRangeSeed,
      caseCount: options.evaluation.caseCount,
    },
  };
}

function scoreAfterDiscovery(
  agentResult: DiscoveryAgentResult,
  evaluation: TheoryEvaluationOptions,
): { evaluation: TheoryEvaluationReport | null; theoryId: number | null } {
  if (agentResult.submittedTheory === null) {
    return { evaluation: null, theoryId: null };
  }

  const report = evaluateTheory(agentResult.submittedTheory, evaluation);
  const record = createTheoryRegistry().register(agentResult.submittedTheory, report);
  return { evaluation: record.evaluation, theoryId: record.id };
}

function copyTheory(theory: Theory): Theory {
  return {
    measurement: structuredClone(theory.measurement),
    operator: theory.operator,
    threshold: theory.threshold,
  };
}
