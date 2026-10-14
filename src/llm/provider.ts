/**
 * Replaceable model-provider boundary.
 *
 * A provider turns the public conversation and the declared tools into either
 * tool calls or a text reply. It does not run experiments, score theories, or
 * see the world engine. Another provider can implement `LlmProvider` later
 * without changing the agent loop.
 */

export interface LlmToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. The agent validates again before use. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type LlmMessage =
  | { role: "user"; text: string }
  | { role: "model"; text: string; echo?: unknown }
  | { role: "model"; toolCalls: LlmToolCall[]; echo?: unknown }
  | {
      role: "tool";
      results: Array<{ callId: string; name: string; output: Record<string, unknown> }>;
    };

export interface LlmCompletionRequest {
  systemInstruction: string;
  messages: LlmMessage[];
  tools: readonly LlmToolDeclaration[];
  signal: AbortSignal;
}

export type LlmCompletionResult =
  | { kind: "tool_calls"; calls: LlmToolCall[]; echo?: unknown }
  | { kind: "text"; text: string; echo?: unknown }
  | { kind: "malformed" };

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResult>;
}

export const PROVIDER_ERROR_MESSAGES = {
  MISSING_CONFIGURATION: "Model provider configuration is incomplete.",
  TIMEOUT: "The model provider timed out.",
  PROVIDER_FAILURE: "The model provider failed.",
  MALFORMED_RESPONSE: "The model provider returned a response that could not be used.",
} as const;

export type ProviderErrorCode = keyof typeof PROVIDER_ERROR_MESSAGES;

/** Fixed failure when GEMINI_API_KEY or GEMINI_MODEL is missing. */
export class ProviderConfigError extends Error {
  readonly code = "MISSING_CONFIGURATION" as const;

  constructor() {
    super(PROVIDER_ERROR_MESSAGES.MISSING_CONFIGURATION);
    this.name = "ProviderConfigError";
  }
}

/** The provider did not answer before the deadline. The message is fixed. */
export class ProviderTimeoutError extends Error {
  readonly code = "TIMEOUT" as const;

  constructor() {
    super(PROVIDER_ERROR_MESSAGES.TIMEOUT);
    this.name = "ProviderTimeoutError";
  }
}

/**
 * Any other provider failure. The original error is discarded so a message
 * that contains a credential cannot reach the transcript or the console.
 */
export class ProviderRequestError extends Error {
  readonly code = "PROVIDER_FAILURE" as const;

  constructor() {
    super(PROVIDER_ERROR_MESSAGES.PROVIDER_FAILURE);
    this.name = "ProviderRequestError";
  }
}

const REDACTED = "[REDACTED]";
const MIN_SECRET_LENGTH = 8;

/** Replaces known secrets and Google API key shapes. Short strings are left alone. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) {
      continue;
    }
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted.replace(/\bAIza[0-9A-Za-z\-_]{10,}\b/g, REDACTED);
}

/** Redacts secrets inside strings of a JSON-like value. Non-strings pass through. */
export function redactValue<T>(value: T, secrets: readonly string[]): T {
  return redactUnknown(value, secrets) as T;
}

function redactUnknown(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactSecrets(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, secrets));
  }
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      copy[redactSecrets(key, secrets)] = redactUnknown(child, secrets);
    }
    return copy;
  }
  return value;
}
