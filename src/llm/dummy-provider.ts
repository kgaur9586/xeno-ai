/**
 * Scripted stand-in used when no live model is called.
 *
 * It runs the public minimum, midpoint, and maximum grid, then submits the
 * theory chosen by the observation catalog. It does not open a network connection.
 */
import { fitTheoryFromObservations, readObservedRow, type ObservedRow, type PublicRanges } from "../agents/observation-theorist.js";
import { planGrid } from "../agents/systematic-explorer.js";
import { RUN_EXPERIMENT_TOOL, SUBMIT_THEORY_TOOL } from "../agents/discovery-tool-declarations.js";
import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmToolCall,
} from "./provider.js";
import type { PublicDescription } from "../tools/schemas.js";

export const DUMMY_PROVIDER_NAME = "dummy";

const DESCRIPTION_MARKER = "Public world description:\n";

export function createDummyProvider(): LlmProvider {
  return {
    name: DUMMY_PROVIDER_NAME,
    complete(request) {
      if (request.signal.aborted) {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        return Promise.reject(error);
      }
      return Promise.resolve(nextCompletion(request));
    },
  };
}

function nextCompletion(request: LlmCompletionRequest): LlmCompletionResult {
  const description = readPublicDescription(request.systemInstruction);
  const observations = readObservations(request.messages);
  const experiments = description === null ? [] : remainingExperiments(description, observations.length);
  if (experiments.length > 0) {
    return { kind: "tool_calls", calls: experiments };
  }

  const ranges = description === null ? emptyRanges() : rangesOf(description);
  const fitted = fitTheoryFromObservations(ranges, observations);
  return {
    kind: "tool_calls",
    calls: [
      {
        id: "dummy-theory",
        name: SUBMIT_THEORY_TOOL,
        arguments: {
          measurement: structuredClone(fitted.theory.measurement),
          operator: fitted.theory.operator,
          threshold: fitted.theory.threshold,
        },
      },
    ],
  };
}

function remainingExperiments(description: PublicDescription, completed: number): LlmToolCall[] {
  const planned = planGrid(description);
  const remainingBudget = description.experimentBudget - completed;
  if (remainingBudget < 1 || completed >= planned.length) {
    return [];
  }
  const count = Math.min(remainingBudget, planned.length - completed);
  const calls: LlmToolCall[] = [];
  for (let offset = 0; offset < count; offset++) {
    const inputs = planned[completed + offset];
    if (inputs === undefined) {
      break;
    }
    calls.push({
      id: `dummy-exp-${completed + offset + 1}`,
      name: RUN_EXPERIMENT_TOOL,
      arguments: { a: inputs.a, b: inputs.b, c: inputs.c },
    });
  }
  return calls;
}

function readObservations(messages: readonly LlmMessage[]): ObservedRow[] {
  const rows: ObservedRow[] = [];
  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }
    for (const result of message.results) {
      if (result.name !== RUN_EXPERIMENT_TOOL) {
        continue;
      }
      const row = readObservedRow(result.output);
      if (row !== null) {
        rows.push(row);
      }
    }
  }
  return rows;
}

function readPublicDescription(systemInstruction: string): PublicDescription | null {
  const start = systemInstruction.indexOf(DESCRIPTION_MARKER);
  if (start < 0) {
    return null;
  }
  const jsonStart = start + DESCRIPTION_MARKER.length;
  const jsonEnd = systemInstruction.indexOf("\n\n", jsonStart);
  if (jsonEnd < 0) {
    return null;
  }
  try {
    return parsePublicDescription(JSON.parse(systemInstruction.slice(jsonStart, jsonEnd)) as unknown);
  } catch {
    return null;
  }
}

function parsePublicDescription(value: unknown): PublicDescription | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.worldId !== "glow-world" || !isPositiveInteger(record.experimentBudget)) {
    return null;
  }
  if (typeof record.attributes !== "object" || record.attributes === null) {
    return null;
  }
  const attributes = record.attributes as Record<string, unknown>;
  const a = readBounds(attributes.a);
  const b = readBounds(attributes.b);
  const c = readBounds(attributes.c);
  if (a === null || b === null || c === null) {
    return null;
  }
  const outcome = record.outcome;
  if (typeof outcome !== "object" || outcome === null || (outcome as Record<string, unknown>).glows !== "boolean") {
    return null;
  }
  return {
    worldId: "glow-world",
    attributes: { a, b, c },
    outcome: { glows: "boolean" },
    experimentBudget: record.experimentBudget,
  };
}

function readBounds(value: unknown): { min: number; max: number } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.min !== "number" || typeof record.max !== "number") {
    return null;
  }
  if (!Number.isFinite(record.min) || !Number.isFinite(record.max) || record.min > record.max) {
    return null;
  }
  return { min: record.min, max: record.max };
}

function rangesOf(description: PublicDescription): PublicRanges {
  return {
    a: { min: description.attributes.a.min, max: description.attributes.a.max },
    b: { min: description.attributes.b.min, max: description.attributes.b.max },
    c: { min: description.attributes.c.min, max: description.attributes.c.max },
  };
}

function emptyRanges(): PublicRanges {
  return {
    a: { min: Number.NaN, max: Number.NaN },
    b: { min: Number.NaN, max: Number.NaN },
    c: { min: Number.NaN, max: Number.NaN },
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
