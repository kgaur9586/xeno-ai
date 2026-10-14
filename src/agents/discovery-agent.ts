/**
 * Bounded discovery loop for one investigator.
 *
 * The loop shows the model the public prompt and tool results, then stops for
 * a valid theory, the model-turn limit, or a provider failure. It does not
 * score the theory and it does not execute generated JavaScript.
 */
import type { ValidatedTheory } from "../language/theory.js";
import {
  PROVIDER_ERROR_MESSAGES,
  ProviderRequestError,
  ProviderTimeoutError,
  redactValue,
  type LlmCompletionRequest,
  type LlmCompletionResult,
  type LlmMessage,
  type LlmProvider,
} from "../llm/provider.js";
import type { ExperimentTools } from "../tools/experiment-tools.js";
import { buildDiscoveryPrompt } from "./discovery-prompt.js";
import { DISCOVERY_TOOL_DECLARATIONS } from "./discovery-tool-declarations.js";
import { executeDiscoveryTool, notExecutedResult } from "./discovery-tools.js";

export const DEFAULT_MAX_MODEL_TURNS = 16;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
export const DEFAULT_PROVIDER_RETRIES = 2;

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
      theory: { measurement: unknown; operator: string; threshold: number };
    };

export interface DiscoveryAgentOptions {
  provider: LlmProvider;
  tools: ExperimentTools;
  maxModelTurns?: number;
  timeoutMs?: number;
  /** Extra attempts after the first provider failure. Zero means one attempt. */
  maxRetries?: number;
  /** Used only to scrub transcript text. Never inserted into the prompt. */
  secrets?: readonly string[];
}

export interface DiscoveryAgentResult {
  status: DiscoveryStatus;
  transcript: TranscriptEntry[];
  submittedTheory: ValidatedTheory | null;
  modelTurns: number;
}

export async function runDiscoveryAgent(options: DiscoveryAgentOptions): Promise<DiscoveryAgentResult> {
  const maxModelTurns = options.maxModelTurns ?? DEFAULT_MAX_MODEL_TURNS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_PROVIDER_RETRIES;
  const secrets = options.secrets ?? [];
  assertLimit(maxModelTurns, "Model turn limit");
  assertLimit(timeoutMs, "Provider timeout");
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("Provider retries must be a non-negative integer.");
  }

  const prompt = buildDiscoveryPrompt(options.tools.describeWorld());
  const transcript: TranscriptEntry[] = [];
  const messages: LlmMessage[] = [];
  let modelTurns = 0;
  let submittedTheory: ValidatedTheory | null = null;

  pushTranscript(transcript, { type: "system_prompt", text: prompt.systemInstruction }, secrets);
  pushTranscript(transcript, { type: "user_message", text: prompt.userMessage }, secrets);
  messages.push({ role: "user", text: prompt.userMessage });

  while (modelTurns < maxModelTurns) {
    const completion = await requestCompletion(
      options.provider,
      {
        systemInstruction: prompt.systemInstruction,
        messages,
        tools: DISCOVERY_TOOL_DECLARATIONS,
      },
      timeoutMs,
      maxRetries,
      transcript,
      secrets,
    );

    if (completion instanceof ProviderTimeoutError || completion instanceof ProviderRequestError) {
      return {
        status: completion instanceof ProviderTimeoutError ? "timeout" : "provider_failure",
        transcript: copyTranscript(transcript),
        submittedTheory: null,
        modelTurns,
      };
    }

    modelTurns++;
    const step = applyCompletion(completion, options.tools, transcript, messages, secrets);
    if (step.submittedTheory) {
      submittedTheory = step.submittedTheory;
      return {
        status: "theory_submitted",
        transcript: copyTranscript(transcript),
        submittedTheory,
        modelTurns,
      };
    }
  }

  return {
    status: "turn_limit",
    transcript: copyTranscript(transcript),
    submittedTheory: null,
    modelTurns,
  };
}

function applyCompletion(
  completion: LlmCompletionResult,
  tools: ExperimentTools,
  transcript: TranscriptEntry[],
  messages: LlmMessage[],
  secrets: readonly string[],
): { submittedTheory: ValidatedTheory | null } {
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
    return { submittedTheory: null };
  }

  if (completion.kind === "text") {
    pushTranscript(transcript, { type: "model_text", text: completion.text }, secrets);
    messages.push({ role: "model", text: redactValue(completion.text, secrets), echo: completion.echo });
    rememberUser(MODEL_FEEDBACK.TEXT_RESPONSE, transcript, messages, secrets);
    return { submittedTheory: null };
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
    return { submittedTheory: null };
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

  for (const call of completion.calls) {
    if (submittedTheory) {
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
  }

  messages.push({ role: "tool", results });
  return { submittedTheory };
}

async function requestCompletion(
  provider: LlmProvider,
  request: Omit<LlmCompletionRequest, "signal">,
  timeoutMs: number,
  maxRetries: number,
  transcript: TranscriptEntry[],
  secrets: readonly string[],
): Promise<LlmCompletionResult | ProviderTimeoutError | ProviderRequestError> {
  let lastError: ProviderTimeoutError | ProviderRequestError = new ProviderRequestError();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await completeBounded(provider, request, timeoutMs);
    } catch (error) {
      lastError = error instanceof ProviderTimeoutError ? error : new ProviderRequestError();
      const retried = attempt < maxRetries;
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
    }
  }

  return lastError;
}

async function completeBounded(
  provider: LlmProvider,
  request: Omit<LlmCompletionRequest, "signal">,
  timeoutMs: number,
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
      completion = provider.complete({ ...isolated, signal: controller.signal }).then(
        (result) => result,
        (error: unknown) => {
          if (error instanceof ProviderTimeoutError || controller.signal.aborted) {
            throw new ProviderTimeoutError();
          }
          throw new ProviderRequestError();
        },
      );
    } catch {
      throw new ProviderRequestError();
    }
    completion.catch(() => undefined);
    return await Promise.race([completion, timeout]);
  } finally {
    clearTimeout(timer);
  }
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
