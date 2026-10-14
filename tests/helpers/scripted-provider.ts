/**
 * In-memory provider for discovery tests.
 *
 * It never opens a network connection. Each scripted step is one model turn.
 */
import type {
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmToolDeclaration,
} from "../../src/llm/provider.js";

export interface RecordedRequest {
  systemInstruction: string;
  messages: LlmMessage[];
  tools: LlmToolDeclaration[];
}

export interface ScriptStep {
  result?: LlmCompletionResult;
  error?: unknown;
  /** Never resolves, so the agent deadline has to stop the turn. */
  hang?: boolean;
}

export function createScriptedProvider(steps: readonly ScriptStep[]) {
  const requests: RecordedRequest[] = [];
  let callCount = 0;

  const provider: LlmProvider = {
    name: "scripted",
    complete(request) {
      callCount += 1;
      requests.push(
        structuredClone({
          systemInstruction: request.systemInstruction,
          messages: request.messages,
          tools: [...request.tools],
        }),
      );
      const step = steps[callCount - 1];
      if (step === undefined) {
        return Promise.reject(new Error("script exhausted"));
      }
      if (step.hang) {
        return new Promise(() => undefined);
      }
      if (step.error !== undefined) {
        return Promise.reject(step.error);
      }
      return Promise.resolve(step.result ?? { kind: "malformed" });
    },
  };

  return {
    provider,
    requests,
    get callCount() {
      return callCount;
    },
  };
}

export function calls(name: string, args: unknown, id = name, echo?: unknown): ScriptStep {
  return {
    result: {
      kind: "tool_calls",
      calls: [{ id, name, arguments: args }],
      echo,
    },
  };
}
