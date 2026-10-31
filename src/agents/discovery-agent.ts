/**
 * Bounded discovery loop for one investigator.
 *
 * The loop shows the model the public prompt and tool results, then stops for
 * a valid theory, the model-turn limit, or a provider failure. It does not
 * score the theory and it does not execute generated JavaScript.
 */
import type { ValidatedNumericTheory } from "../language/numeric-theory.js";
import type { ValidatedTheory } from "../language/theory.js";
import {
  classifyProviderError,
  isAbortError,
  PROVIDER_ERROR_MESSAGES,
  ProviderRequestError,
  ProviderTimeoutError,
  redactValue,
  type LlmCompletionRequest,
  type LlmCompletionResult,
  type LlmMessage,
  type LlmProvider,
  type ProviderErrorDiagnostic,
} from "../llm/provider.js";
import type { AnyExperimentTools } from "../tools/public-types.js";
import { buildDiscoveryPrompt } from "./discovery-prompt.js";
import { buildDiscoveryToolDeclarations } from "./discovery-tool-declarations.js";
import { executeDiscoveryTool, notExecutedResult } from "./discovery-tools.js";
import { discoveryShapeOf } from "./discovery-world.js";

export const DEFAULT_MAX_MODEL_TURNS = 16;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
export const DEFAULT_PROVIDER_RETRIES = 2;
export const PROVIDER_RETRY_BASE_MS = 200;
export const PROVIDER_RETRY_MAX_MS = 2_000;

const MODEL_FEEDBACK = {
  MALFORMED_RESPONSE: "The previous response was not a usable tool call. Call one of the provided tools.",
  TEXT_RESPONSE: "A text reply does not investigate the world. Call one of the provided tools.",
} as const;

export type DiscoveryStatus = "theory_submitted" | "turn_limit" | "timeout" | "provider_failure";

export type TranscriptEntry =
  | { type: "system_prompt"; text: string }
  | { type: "user_message"; text: string }
  | { type: "model_text"; text: string }
  | { type: "tool_calls"; calls: Array<{ id: string; name: string; arguments: unknown }> }
  | { type: "tool_result"; callId: string; name: string; output: Record<string, unknown> }
  | {
      type: "provider_notice";
      code: "TIMEOUT" | "PROVIDER_FAILURE" | "MALFORMED_RESPONSE";
      message: string;
      attempt?: number;
      retried?: boolean;
    }
  | {
      type: "submitted_theory";
      /** `operator` and `threshold` are present for a boolean theory only. */
      theory: { measurement: unknown; operator?: string; threshold?: number };
    };

export interface DiscoveryAgentOptions {
  provider: LlmProvider;
  tools: AnyExperimentTools;
  maxModelTurns?: number;
  timeoutMs?: number;
  /** Extra attempts after the first provider failure. Zero means one attempt. */
  maxRetries?: number;
  /** Used only to scrub transcript text. Never inserted into the prompt. */
  secrets?: readonly string[];
  /** Waits between transient retries. Tests may replace the timer. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Unit interval for retry jitter. Tests may replace this. */
  random?: () => number;
}

/** A stored conversation to continue. Only runs that can still take turns are resumed. */
export interface DiscoveryResumeState {
  transcript: readonly TranscriptEntry[];
  messages: readonly LlmMessage[];
  modelTurns: number;
}

export interface DiscoveryAgentResult {
  status: DiscoveryStatus;
  transcript: TranscriptEntry[];
  /** A boolean theory, for a world with a boolean outcome. */
  submittedTheory: ValidatedTheory | null;
  /** A numeric theory, for a world with a numeric outcome. */
  submittedNumericTheory: ValidatedNumericTheory | null;
  modelTurns: number;
  /** Safe failure facts for the operator. Null when the provider did not stop the run. */
  providerDiagnostic: ProviderErrorDiagnostic | null;
}

export type DiscoveryRunSnapshot = Omit<DiscoveryAgentResult, "status"> & { status: DiscoveryStatus | null };

/** A discovery run that advances one model turn per `step()`. */
export interface DiscoveryRun {
  /** Runs one model turn (including provider retries). Does nothing once the run has finished. */
  step(): Promise<void>;
  /** Null while the run can still take turns. */
  status(): DiscoveryStatus | null;
  /** A fresh copy of the current state. */
  snapshot(): DiscoveryRunSnapshot;
  /** A fresh copy of the provider conversation, for storage and resuming. */
  messages(): LlmMessage[];
}

export async function runDiscoveryAgent(options: DiscoveryAgentOptions): Promise<DiscoveryAgentResult> {
  const run = createDiscoveryRun(options);
  while (run.status() === null) {
    await run.step();
  }
  const result = run.snapshot();
  return { ...result, status: result.status! };
}

export function createDiscoveryRun(options: DiscoveryAgentOptions, resume?: DiscoveryResumeState): DiscoveryRun {
  const maxModelTurns = options.maxModelTurns ?? DEFAULT_MAX_MODEL_TURNS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_PROVIDER_RETRIES;
  const secrets = options.secrets ?? [];
  assertLimit(maxModelTurns, "Model turn limit");
  assertLimit(timeoutMs, "Provider timeout");
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("Provider retries must be a non-negative integer.");
  }

  const description = options.tools.describeWorld();
  const prompt = buildDiscoveryPrompt(description);
  const declarations = buildDiscoveryToolDeclarations(discoveryShapeOf(description));
  const transcript: TranscriptEntry[] = [];
  const messages: LlmMessage[] = [];
  const sleep = options.sleep ?? delay;
  const random = options.random ?? Math.random;
  let modelTurns = 0;

  if (resume === undefined) {
    pushTranscript(transcript, { type: "system_prompt", text: prompt.systemInstruction }, secrets);
    pushTranscript(transcript, { type: "user_message", text: prompt.userMessage }, secrets);
    messages.push({ role: "user", text: prompt.userMessage });
  } else {
    if (!Number.isInteger(resume.modelTurns) || resume.modelTurns < 0 || resume.modelTurns >= maxModelTurns) {
      throw new Error("Only a run with turns left can be resumed.");
    }
    transcript.push(...structuredClone(resume.transcript));
    messages.push(...structuredClone(resume.messages));
    modelTurns = resume.modelTurns;
  }

  let status: DiscoveryStatus | null = null;
  let submitted: CompletionStep = NO_THEORY;
  let providerDiagnostic: ProviderErrorDiagnostic | null = null;
  let stepping = false;

  return {
    async step() {
      if (status !== null) {
        return;
      }
      if (stepping) {
        throw new Error("A step is already running.");
      }
      stepping = true;
      try {
        const completion = await requestCompletion(
          options.provider,
          {
            systemInstruction: prompt.systemInstruction,
            messages,
            tools: declarations,
          },
          timeoutMs,
          maxRetries,
          transcript,
          secrets,
          sleep,
          random,
        );

        if (completion instanceof ProviderTimeoutError || completion instanceof ProviderRequestError) {
          status = completion instanceof ProviderTimeoutError ? "timeout" : "provider_failure";
          providerDiagnostic = copyDiagnostic(completion.diagnostic);
          return;
        }

        modelTurns++;
        const step = applyCompletion(completion, options.tools, transcript, messages, secrets);
        if (step.submittedTheory || step.submittedNumericTheory) {
          submitted = step;
          status = "theory_submitted";
        } else if (modelTurns >= maxModelTurns) {
          status = "turn_limit";
        }
      } finally {
        stepping = false;
      }
    },
    status() {
      return status;
    },
    snapshot() {
      return {
        status,
        transcript: copyTranscript(transcript),
        submittedTheory: submitted.submittedTheory,
        submittedNumericTheory: submitted.submittedNumericTheory,
        modelTurns,
        providerDiagnostic: providerDiagnostic === null ? null : copyDiagnostic(providerDiagnostic),
      };
    },
    messages() {
      return structuredClone(messages);
    },
  };
}

interface CompletionStep {
  submittedTheory: ValidatedTheory | null;
  submittedNumericTheory: ValidatedNumericTheory | null;
}

const NO_THEORY: CompletionStep = { submittedTheory: null, submittedNumericTheory: null };

function applyCompletion(
  completion: LlmCompletionResult,
  tools: AnyExperimentTools,
  transcript: TranscriptEntry[],
  messages: LlmMessage[],
  secrets: readonly string[],
): CompletionStep {
  if (completion.kind === "malformed") {
    pushTranscript(
      transcript,
      {
        type: "provider_notice",
        code: "MALFORMED_RESPONSE",
        message: PROVIDER_ERROR_MESSAGES.MALFORMED_RESPONSE,
      },
      secrets,
    );
    rememberUser(MODEL_FEEDBACK.MALFORMED_RESPONSE, transcript, messages, secrets);
    return NO_THEORY;
  }

  if (completion.kind === "text") {
    pushTranscript(transcript, { type: "model_text", text: completion.text }, secrets);
    messages.push({ role: "model", text: redactValue(completion.text, secrets), echo: completion.echo });
    rememberUser(MODEL_FEEDBACK.TEXT_RESPONSE, transcript, messages, secrets);
    return NO_THEORY;
  }

  if (completion.calls.length === 0) {
    pushTranscript(
      transcript,
      {
        type: "provider_notice",
        code: "MALFORMED_RESPONSE",
        message: PROVIDER_ERROR_MESSAGES.MALFORMED_RESPONSE,
      },
      secrets,
    );
    rememberUser(MODEL_FEEDBACK.MALFORMED_RESPONSE, transcript, messages, secrets);
    return NO_THEORY;
  }

  pushTranscript(
    transcript,
    {
      type: "tool_calls",
      calls: completion.calls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    },
    secrets,
  );
  messages.push({
    role: "model",
    toolCalls: redactValue(completion.calls, secrets),
    echo: completion.echo,
  });

  const results: Array<{ callId: string; name: string; output: Record<string, unknown> }> = [];
  let submittedTheory: ValidatedTheory | null = null;
  let submittedNumericTheory: ValidatedNumericTheory | null = null;

  for (const call of completion.calls) {
    if (submittedTheory || submittedNumericTheory) {
      const output = notExecutedResult();
      results.push({ callId: call.id, name: call.name, output });
      pushTranscript(transcript, { type: "tool_result", callId: call.id, name: call.name, output }, secrets);
      continue;
    }

    const executed = executeDiscoveryTool(call.name, call.arguments, tools);
    const output = redactValue(executed.output, secrets);
    results.push({ callId: call.id, name: call.name, output });
    pushTranscript(
      transcript,
      { type: "tool_result", callId: call.id, name: call.name, output },
      secrets,
    );
    if (executed.acceptedTheory) {
      submittedTheory = executed.acceptedTheory;
      pushTranscript(
        transcript,
        {
          type: "submitted_theory",
          theory: {
            measurement: executed.acceptedTheory.measurement,
            operator: executed.acceptedTheory.operator,
            threshold: executed.acceptedTheory.threshold,
          },
        },
        secrets,
      );
    }
    if (executed.acceptedNumericTheory) {
      submittedNumericTheory = executed.acceptedNumericTheory;
      pushTranscript(
        transcript,
        { type: "submitted_theory", theory: { measurement: executed.acceptedNumericTheory.measurement } },
        secrets,
      );
    }
  }

  messages.push({ role: "tool", results });
  return { submittedTheory, submittedNumericTheory };
}

async function requestCompletion(
  provider: LlmProvider,
  request: Omit<LlmCompletionRequest, "signal">,
  timeoutMs: number,
  maxRetries: number,
  transcript: TranscriptEntry[],
  secrets: readonly string[],
  sleep: (milliseconds: number) => Promise<void>,
  random: () => number,
): Promise<LlmCompletionResult | ProviderTimeoutError | ProviderRequestError> {
  let lastError: ProviderTimeoutError | ProviderRequestError = new ProviderRequestError();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await completeBounded(provider, request, timeoutMs, secrets);
    } catch (error) {
      lastError = toProviderFailure(error, false, secrets);
      const retried = lastError.retryable && attempt < maxRetries;
      pushTranscript(
        transcript,
        {
          type: "provider_notice",
          code: lastError.code,
          message: lastError.message,
          attempt: attempt + 1,
          retried,
        },
        secrets,
      );
      if (!retried) {
        return lastError;
      }
      await sleep(providerRetryDelayMs(attempt, random()));
    }
  }

  return lastError;
}

/**
 * Bounded exponential delay with equal jitter. `failureIndex` zero is the
 * delay before the first retry. The unit interval selects the upper half of
 * the capped delay, so a retry never runs immediately.
 */
export function providerRetryDelayMs(failureIndex: number, randomUnit: number): number {
  const index = Number.isInteger(failureIndex) && failureIndex > 0 ? Math.min(failureIndex, 10) : 0;
  const ceiling = Math.min(PROVIDER_RETRY_MAX_MS, PROVIDER_RETRY_BASE_MS * 2 ** index);
  const unit = typeof randomUnit === "number" && Number.isFinite(randomUnit) ? Math.min(1, Math.max(0, randomUnit)) : 0;
  return Math.round(ceiling * (0.5 + unit * 0.5));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function completeBounded(
  provider: LlmProvider,
  request: Omit<LlmCompletionRequest, "signal">,
  timeoutMs: number,
  secrets: readonly string[],
): Promise<LlmCompletionResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderTimeoutError());
      }, timeoutMs);
    });
    // The race may settle from the other side; this prevents an unhandled rejection.
    timeout.catch(() => undefined);

    const isolated = structuredClone(request);
    let completion: Promise<LlmCompletionResult>;
    try {
      completion = Promise.resolve(
        provider.complete({ ...isolated, signal: controller.signal }),
      ).then(
        (result) => result,
        (error: unknown) => {
          throw toProviderFailure(error, controller.signal.aborted, secrets);
        },
      );
    } catch (error) {
      throw toProviderFailure(error, controller.signal.aborted, secrets);
    }
    completion.catch(() => undefined);
    return await Promise.race([completion, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function toProviderFailure(
  error: unknown,
  aborted = false,
  secrets: readonly string[] = [],
): ProviderTimeoutError | ProviderRequestError {
  if (aborted || error instanceof ProviderTimeoutError || isAbortError(error)) {
    return new ProviderTimeoutError();
  }
  if (error instanceof ProviderRequestError) {
    return error;
  }
  return new ProviderRequestError(classifyProviderError(error, secrets));
}

function copyDiagnostic(diagnostic: ProviderErrorDiagnostic): ProviderErrorDiagnostic {
  return {
    category: diagnostic.category,
    httpStatus: diagnostic.httpStatus,
    message: diagnostic.message,
  };
}

function rememberUser(
  text: string,
  transcript: TranscriptEntry[],
  messages: LlmMessage[],
  secrets: readonly string[],
): void {
  pushTranscript(transcript, { type: "user_message", text }, secrets);
  messages.push({ role: "user", text });
}

function pushTranscript(transcript: TranscriptEntry[], entry: TranscriptEntry, secrets: readonly string[]): void {
  transcript.push(redactValue(structuredClone(entry), secrets));
}

function copyTranscript(transcript: TranscriptEntry[]): TranscriptEntry[] {
  return structuredClone(transcript);
}

function assertLimit(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}
