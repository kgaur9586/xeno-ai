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

/**
 * Safe failure label. This is a closed set of short names, never the raw
 * provider message, response body, headers, or request.
 */
export const PROVIDER_ERROR_CATEGORIES = [
  "timeout",
  "network",
  "rate_limit",
  "server_error",
  "bad_request",
  "unauthorized",
  "forbidden",
  "client_error",
  "unknown",
] as const;

export type ProviderErrorCategory = (typeof PROVIDER_ERROR_CATEGORIES)[number];

/**
 * Operator-facing failure facts. `message` is a short sanitized excerpt, never
 * the raw body, headers, prompt, or tool arguments.
 */
export interface ProviderErrorDiagnostic {
  category: ProviderErrorCategory;
  httpStatus: number | null;
  message: string;
}

export const PROVIDER_DIAGNOSTIC_MESSAGES = {
  UNREADABLE: "The provider did not return a readable error message.",
  OMITTED: "The provider error included request content and was omitted.",
} as const;

const DIAGNOSTIC_MESSAGE_LIMIT = 240;
const SENSITIVE_MESSAGE_MARKERS = [
  "authorization",
  "x-goog-api-key",
  "bearer ",
  "systeminstruction",
  "system instruction",
  "functiondeclarations",
  "function declarations",
  "parametersjsonschema",
  "toolconfig",
  "hidden_threshold",
  "computeglowoutcome",
  "prompt text",
];

const PROVIDER_ERROR_CATEGORY_SET = new Set<string>(PROVIDER_ERROR_CATEGORIES);
const RETRYABLE_SERVER_STATUSES = new Set([500, 502, 503, 504]);
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT",
]);

const TIMEOUT_DIAGNOSTIC: ProviderErrorDiagnostic = {
  category: "timeout",
  httpStatus: null,
  message: PROVIDER_ERROR_MESSAGES.TIMEOUT,
};

/** The provider did not answer before the deadline. The message is fixed. */
export class ProviderTimeoutError extends Error {
  readonly code = "TIMEOUT" as const;
  readonly diagnostic: ProviderErrorDiagnostic = { ...TIMEOUT_DIAGNOSTIC };
  readonly retryable = true;

  constructor() {
    super(PROVIDER_ERROR_MESSAGES.TIMEOUT);
    this.name = "ProviderTimeoutError";
  }
}

/**
 * Any other provider failure. The public message stays fixed so a credential
 * in the original error cannot reach the transcript or the console. The
 * diagnostic keeps a normalized category, HTTP status, and sanitized excerpt.
 */
export class ProviderRequestError extends Error {
  readonly code = "PROVIDER_FAILURE" as const;
  readonly diagnostic: ProviderErrorDiagnostic;
  readonly retryable: boolean;

  constructor(diagnostic?: ProviderErrorDiagnostic) {
    super(PROVIDER_ERROR_MESSAGES.PROVIDER_FAILURE);
    this.name = "ProviderRequestError";
    this.diagnostic = sanitizeProviderDiagnostic(diagnostic);
    this.retryable = isRetryableProviderDiagnostic(this.diagnostic);
  }
}

export function isProviderErrorCategory(value: unknown): value is ProviderErrorCategory {
  return typeof value === "string" && PROVIDER_ERROR_CATEGORY_SET.has(value);
}

/** True for timeouts, network failures, HTTP 408 and 429, and transient 5xx statuses. */
export function isRetryableProviderDiagnostic(diagnostic: ProviderErrorDiagnostic): boolean {
  switch (diagnostic.category) {
    case "timeout":
    case "network":
    case "rate_limit":
    case "unknown":
      return true;
    case "server_error":
      return diagnostic.httpStatus !== null && RETRYABLE_SERVER_STATUSES.has(diagnostic.httpStatus);
    default:
      return false;
  }
}

/**
 * Reads a category, HTTP status, and short message from an SDK or transport error.
 * Headers, request bodies, and nested debug payloads are ignored. `secrets` are
 * removed from the message before it is returned.
 */
export function classifyProviderError(
  error: unknown,
  secrets: readonly string[] = [],
): ProviderErrorDiagnostic {
  if (isAbortError(error)) {
    return { ...TIMEOUT_DIAGNOSTIC };
  }
  const message = diagnosticMessageFromError(error, secrets);
  const httpStatus = findHttpStatus(error);
  if (httpStatus !== null) {
    return { category: categoryForStatus(httpStatus), httpStatus, message };
  }
  if (hasNetworkFailure(error)) {
    return { category: "network", httpStatus: null, message };
  }
  return { category: "unknown", httpStatus: null, message };
}

export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = "name" in error ? error.name : undefined;
  const code = "code" in error ? error.code : undefined;
  return name === "AbortError" || code === "ABORT_ERR";
}

function sanitizeProviderDiagnostic(
  diagnostic: ProviderErrorDiagnostic | undefined,
  secrets: readonly string[] = [],
): ProviderErrorDiagnostic {
  if (diagnostic === undefined) {
    return { category: "unknown", httpStatus: null, message: PROVIDER_DIAGNOSTIC_MESSAGES.UNREADABLE };
  }
  const category = isProviderErrorCategory(diagnostic.category) ? diagnostic.category : "unknown";
  const httpStatus = isProviderHttpStatus(diagnostic.httpStatus) ? diagnostic.httpStatus : null;
  return { category, httpStatus, message: sanitizeDiagnosticMessage(diagnostic.message, secrets) };
}

/**
 * The GenAI SDK stores `JSON.stringify(errorBody)` on `ApiError.message`.
 * Google's useful text is the nested `error.message` string. This reads that
 * string, or a plain transport message, and nothing else from the body.
 */
function diagnosticMessageFromError(error: unknown, secrets: readonly string[]): string {
  return sanitizeDiagnosticMessage(readErrorMessage(error, 0, new Set()), secrets);
}

function readErrorMessage(error: unknown, depth: number, seen: Set<object>): string | null {
  if (!isWalkable(error, depth, seen)) {
    return null;
  }
  seen.add(error);
  const record = error as Record<string, unknown>;
  const direct = candidateMessage(record.message);
  if (direct !== null) {
    return direct;
  }
  const nested = nestedErrorMessage(record.error);
  if (nested !== null) {
    return nested;
  }
  return readErrorMessage(record.cause, depth + 1, seen);
}

function nestedErrorMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return candidateMessage((value as Record<string, unknown>).message);
}

function candidateMessage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      return nestedErrorMessage((parsed as Record<string, unknown>).error);
    } catch {
      return null;
    }
  }
  return trimmed;
}

function sanitizeDiagnosticMessage(value: unknown, secrets: readonly string[]): string {
  if (typeof value !== "string") {
    return PROVIDER_DIAGNOSTIC_MESSAGES.UNREADABLE;
  }
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed === "") {
    return PROVIDER_DIAGNOSTIC_MESSAGES.UNREADABLE;
  }
  const redacted = redactCredentialShapes(redactSecrets(collapsed, secrets));
  if (SENSITIVE_MESSAGE_MARKERS.some((marker) => redacted.toLowerCase().includes(marker))) {
    return PROVIDER_DIAGNOSTIC_MESSAGES.OMITTED;
  }
  if (redacted.length <= DIAGNOSTIC_MESSAGE_LIMIT) {
    return redacted;
  }
  return `${redacted.slice(0, DIAGNOSTIC_MESSAGE_LIMIT - 1).trimEnd()}…`;
}

function redactCredentialShapes(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:key|api_key|access_token|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(x-goog-api-key|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, "$1 [REDACTED]");
}

function categoryForStatus(status: number): ProviderErrorCategory {
  if (status === 408) {
    return "timeout";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status === 400) {
    return "bad_request";
  }
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status >= 500) {
    return "server_error";
  }
  return "client_error";
}

function isProviderHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599;
}

function findHttpStatus(error: unknown): number | null {
  return readStatus(error, 0, new Set());
}

function hasNetworkFailure(error: unknown): boolean {
  return readNetwork(error, 0, new Set());
}

function readStatus(error: unknown, depth: number, seen: Set<object>): number | null {
  if (!isWalkable(error, depth, seen)) {
    return null;
  }
  seen.add(error);
  const record = error as Record<string, unknown>;
  const direct = firstStatus(record.status, record.statusCode, record.httpStatus, record.code);
  if (direct !== null) {
    return direct;
  }
  const responseStatus = statusFrom(record.response, "status");
  if (responseStatus !== null) {
    return responseStatus;
  }
  const nestedCode = statusFrom(record.error, "code");
  if (nestedCode !== null) {
    return nestedCode;
  }
  return readStatus(record.cause, depth + 1, seen);
}

function readNetwork(error: unknown, depth: number, seen: Set<object>): boolean {
  if (!isWalkable(error, depth, seen)) {
    return false;
  }
  seen.add(error);
  const record = error as Record<string, unknown>;
  if (typeof record.code === "string" && NETWORK_ERROR_CODES.has(record.code)) {
    return true;
  }
  if (record.name === "TypeError" && typeof record.message === "string" && record.message.startsWith("fetch failed")) {
    return true;
  }
  return readNetwork(record.cause, depth + 1, seen);
}

function firstStatus(...values: unknown[]): number | null {
  for (const value of values) {
    if (isProviderHttpStatus(value)) {
      return value;
    }
  }
  return null;
}

function statusFrom(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return firstStatus((value as Record<string, unknown>)[key]);
}

function isWalkable(error: unknown, depth: number, seen: Set<object>): error is object {
  return depth <= 5 && typeof error === "object" && error !== null && !seen.has(error);
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
