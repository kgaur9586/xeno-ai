/**
 * Gemini adapter.
 *
 * Dependency: `@google/genai` is the official Google Gen AI SDK and the only
 * network client in this project. Tests inject a fake client and never call
 * the network. The API key is passed only to the SDK constructor. It is never
 * written into prompts, tool declarations, transcripts, or thrown errors.
 *
 * The adapter declares exactly the tools it is given and turns off the SDK's
 * automatic function calling and code execution. Generated code is ignored.
 */
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type FunctionCall,
  type GenerateContentConfig,
  type Part,
} from "@google/genai";
import { readGeminiConfig } from "./env.js";
import {
  ProviderConfigError,
  ProviderRequestError,
  ProviderTimeoutError,
  redactSecrets,
  type LlmCompletionRequest,
  type LlmCompletionResult,
  type LlmMessage,
  type LlmProvider,
  type LlmToolCall,
} from "./provider.js";

export interface GeminiModelPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
}

export interface GeminiGenerateRequest {
  model: string;
  contents: Content[];
  config: GenerateContentConfig;
}

export interface GeminiGenerateResponse {
  text?: string;
  functionCalls?: FunctionCall[];
  modelParts?: GeminiModelPart[];
  refusedExecutableCode?: boolean;
}

/** Narrow client surface so tests can substitute a fake with no network access. */
export interface GeminiGenerateClient {
  generateContent(request: GeminiGenerateRequest): Promise<GeminiGenerateResponse>;
}

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  client?: GeminiGenerateClient;
  /** Called with the API key only when `client` is omitted. */
  createClient?: (apiKey: string) => GeminiGenerateClient;
}

export function createGeminiProvider(options: GeminiProviderOptions): LlmProvider {
  const apiKey = options.apiKey.trim();
  const model = options.model.trim();
  if (apiKey === "" || model === "") {
    throw new ProviderConfigError();
  }

  const client = options.client ?? options.createClient?.(apiKey) ?? createSdkClient(apiKey);

  return {
    name: "gemini",

    async complete(request) {
      try {
        const response = await client.generateContent({
          model,
          contents: toContents(request, apiKey),
          config: toConfig(request, apiKey),
        });
        return normalizeResponse(response, apiKey);
      } catch (error) {
        if (request.signal.aborted || isAbortError(error)) {
          throw new ProviderTimeoutError();
        }
        throw new ProviderRequestError();
      }
    },
  };
}

export function createGeminiProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const { apiKey, model } = readGeminiConfig(env);
  return createGeminiProvider({ apiKey, model });
}

function createSdkClient(apiKey: string): GeminiGenerateClient {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async generateContent(request) {
      const response = await ai.models.generateContent({
        model: request.model,
        contents: request.contents,
        config: request.config,
      });
      return mapSdkResponse(response);
    },
  };
}

/** Copies the public parts of an SDK response and drops generated code. */
export function mapSdkResponse(response: {
  functionCalls?: FunctionCall[] | undefined;
  candidates?: Array<{ content?: { parts?: Part[] | undefined } | undefined }> | undefined;
}): GeminiGenerateResponse {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const refusedExecutableCode = parts.some(
    (part) => part.executableCode !== undefined || part.codeExecutionResult !== undefined,
  );
  const modelParts = parts
    .map(toPublicModelPart)
    .filter((part): part is GeminiModelPart => part !== undefined);
  const functionCalls = response.functionCalls;
  if (refusedExecutableCode && (functionCalls === undefined || functionCalls.length === 0)) {
    return { refusedExecutableCode: true, modelParts };
  }
  const text = functionCalls !== undefined && functionCalls.length > 0 ? undefined : textFromParts(parts);
  return { text, functionCalls, modelParts };
}

function toConfig(request: LlmCompletionRequest, apiKey: string): GenerateContentConfig {
  const names = request.tools.map((tool) => tool.name);
  return {
    systemInstruction: redactSecrets(request.systemInstruction, [apiKey]),
    tools: [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.parameters,
        })),
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: FunctionCallingConfigMode.ANY,
        allowedFunctionNames: names,
      },
    },
    automaticFunctionCalling: { disable: true },
    abortSignal: request.signal,
  };
}

function toContents(request: LlmCompletionRequest, apiKey: string): Content[] {
  return request.messages.map((message) => toContent(message, apiKey));
}

function toContent(message: LlmMessage, apiKey: string): Content {
  if (message.role === "user") {
    return { role: "user", parts: [{ text: redactSecrets(message.text, [apiKey]) }] };
  }
  if (message.role === "tool") {
    return {
      role: "user",
      parts: message.results.map((result) => ({
        functionResponse: {
          id: result.callId,
          name: result.name,
          response: { output: jsonObject(redactSecretsInUnknown(result.output, apiKey)) },
        },
      })),
    };
  }

  const echoed = echoParts(message.echo, apiKey);
  if (echoed.length > 0) {
    return { role: "model", parts: echoed };
  }
  if ("toolCalls" in message) {
    return {
      role: "model",
      parts: message.toolCalls.map((call) => ({
        functionCall: {
          id: call.id,
          name: call.name,
          args: jsonObject(call.arguments),
        },
      })),
    };
  }
  return { role: "model", parts: [{ text: redactSecrets(message.text, [apiKey]) }] };
}

function normalizeResponse(response: GeminiGenerateResponse, apiKey: string): LlmCompletionResult {
  if (response.refusedExecutableCode) {
    return { kind: "malformed" };
  }

  const calls = normalizeCalls(callsFrom(response));
  if (calls === "malformed") {
    return { kind: "malformed" };
  }
  if (calls.length > 0) {
    return { kind: "tool_calls", calls, echo: response.modelParts };
  }

  const text = redactSecrets(response.text ?? "", [apiKey]);
  if (text.trim() === "") {
    return { kind: "malformed" };
  }
  return { kind: "text", text, echo: response.modelParts };
}

function callsFrom(response: GeminiGenerateResponse): FunctionCall[] | undefined {
  const fromParts = (response.modelParts ?? [])
    .map((part) => part.functionCall)
    .filter((call): call is NonNullable<GeminiModelPart["functionCall"]> => call !== undefined);
  if (fromParts.length > 0) {
    return fromParts;
  }
  return response.functionCalls;
}

function normalizeCalls(calls: FunctionCall[] | undefined): LlmToolCall[] | "malformed" {
  if (calls === undefined || calls.length === 0) {
    return [];
  }

  const usedIds = new Set<string>();
  const normalized: LlmToolCall[] = [];
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]!;
    if (typeof call.name !== "string" || call.name.trim() === "") {
      return "malformed";
    }
    if (call.args !== undefined && !isPlainObject(call.args)) {
      return "malformed";
    }
    let id = typeof call.id === "string" && call.id.trim() !== "" ? call.id : `call-${index + 1}`;
    while (usedIds.has(id)) {
      id = `${id}-${usedIds.size + 1}`;
    }
    usedIds.add(id);
    normalized.push({ id, name: call.name, arguments: call.args ?? {} });
  }
  return normalized;
}

function echoParts(echo: unknown, apiKey: string): Part[] {
  if (!Array.isArray(echo)) {
    return [];
  }
  const parts: Part[] = [];
  for (const candidate of echo) {
    const part = sanitizeEchoPart(candidate, apiKey);
    if (part !== undefined) {
      parts.push(part);
    }
  }
  return parts;
}

function sanitizeEchoPart(value: unknown, apiKey: string): Part | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const part: Part = {};
  if (typeof value.text === "string") {
    part.text = redactSecrets(value.text, [apiKey]);
  }
  if (value.thought === true) {
    part.thought = true;
  }
  if (typeof value.thoughtSignature === "string") {
    part.thoughtSignature = value.thoughtSignature;
  }
  if (isPlainObject(value.functionCall) && typeof value.functionCall.name === "string") {
    const args = isPlainObject(value.functionCall.args) ? value.functionCall.args : {};
    part.functionCall = {
      name: value.functionCall.name,
      id: typeof value.functionCall.id === "string" ? value.functionCall.id : undefined,
      args: jsonObject(args),
    };
  }
  if (part.text === undefined && part.functionCall === undefined && part.thoughtSignature === undefined) {
    return undefined;
  }
  return part;
}

function toPublicModelPart(part: Part): GeminiModelPart | undefined {
  const copy: GeminiModelPart = {};
  if (typeof part.text === "string") {
    copy.text = part.text;
  }
  if (part.thought === true) {
    copy.thought = true;
  }
  if (typeof part.thoughtSignature === "string") {
    copy.thoughtSignature = part.thoughtSignature;
  }
  if (part.functionCall !== undefined) {
    copy.functionCall = {
      id: part.functionCall.id,
      name: part.functionCall.name,
      args: part.functionCall.args,
    };
  }
  if (copy.text === undefined && copy.functionCall === undefined && copy.thoughtSignature === undefined) {
    return undefined;
  }
  return copy;
}

function textFromParts(parts: readonly Part[]): string {
  return parts
    .filter((part) => part.thought !== true && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function redactSecretsInUnknown(value: unknown, apiKey: string): unknown {
  if (typeof value === "string") {
    return redactSecrets(value, [apiKey]);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsInUnknown(item, apiKey));
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      copy[redactSecrets(key, [apiKey])] = redactSecretsInUnknown(child, apiKey);
    }
    return copy;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = "name" in error ? error.name : undefined;
  const code = "code" in error ? error.code : undefined;
  return name === "AbortError" || code === "ABORT_ERR";
}
