/**
 * Scripted stand-in used when no live model is called.
 *
 * It explores with the public minimum, midpoint, and maximum grid when that
 * grid has at most 27 points (three attributes), and otherwise with a
 * fixed-seed random design inside the public ranges. It then submits the
 * catalog theory that best fits its observations: a boolean theory for a
 * boolean outcome, a numeric theory for a numeric one. It does not open a
 * network connection.
 */
import {
  fitNumericTheoryFromObservations,
  fitTheoryFromObservations,
  readObservedRow,
  type ObservedRow,
  type PublicRanges,
} from "../agents/observation-theorist.js";
import { planGrid } from "../agents/systematic-explorer.js";
import { RUN_EXPERIMENT_TOOL, SUBMIT_THEORY_TOOL } from "../agents/discovery-tool-declarations.js";
import { createSeededRandom } from "../shared/random.js";
import type { AnyWorldDescription } from "../tools/public-types.js";
import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmToolCall,
} from "./provider.js";

export const DUMMY_PROVIDER_NAME = "dummy";
/** Largest grid the dummy runs; larger worlds use the random design. */
export const DUMMY_MAX_GRID_POINTS = 27;
/** Differs from the random explorer's seed so the two designs are independent. */
export const DUMMY_DESIGN_SEED = 7;

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

  const ranges = description === null ? { a: { min: Number.NaN, max: Number.NaN } } : rangesOf(description);
  return {
    kind: "tool_calls",
    calls: [{ id: "dummy-theory", name: SUBMIT_THEORY_TOOL, arguments: chooseTheory(description, ranges, observations) }],
  };
}

function chooseTheory(
  description: AnyWorldDescription | null,
  ranges: PublicRanges,
  observations: readonly ObservedRow[],
): Record<string, unknown> {
  const numeric = description !== null && Object.values(description.outcome)[0] === "number";
  if (numeric) {
    const fitted = fitNumericTheoryFromObservations(ranges, observations);
    return { measurement: structuredClone(fitted.theory.measurement) };
  }
  const fitted = fitTheoryFromObservations(ranges, observations);
  return {
    measurement: structuredClone(fitted.theory.measurement),
    operator: fitted.theory.operator,
    threshold: fitted.theory.threshold,
  };
}

/** The full planned design, in run order. */
export function dummyDesign(description: AnyWorldDescription): Array<Record<string, number>> {
  const names = Object.keys(description.attributes);
  if (3 ** names.length <= DUMMY_MAX_GRID_POINTS) {
    return planGrid(description);
  }
  const random = createSeededRandom(DUMMY_DESIGN_SEED);
  return Array.from({ length: description.experimentBudget }, () => {
    const point: Record<string, number> = {};
    for (const name of names) {
      const range = description.attributes[name]!;
      point[name] = range.min + random() * (range.max - range.min);
    }
    return point;
  });
}

function remainingExperiments(description: AnyWorldDescription, completed: number): LlmToolCall[] {
  const planned = dummyDesign(description);
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
      arguments: { ...inputs },
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

function readPublicDescription(systemInstruction: string): AnyWorldDescription | null {
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

function parsePublicDescription(value: unknown): AnyWorldDescription | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.worldId !== "string" || !isPositiveInteger(record.experimentBudget)) {
    return null;
  }
  if (typeof record.attributes !== "object" || record.attributes === null) {
    return null;
  }
  const attributes: Record<string, { min: number; max: number }> = {};
  for (const [name, bounds] of Object.entries(record.attributes as Record<string, unknown>)) {
    const parsed = readBounds(bounds);
    if (parsed === null) {
      return null;
    }
    attributes[name] = parsed;
  }
  if (Object.keys(attributes).length === 0) {
    return null;
  }
  if (typeof record.outcome !== "object" || record.outcome === null) {
    return null;
  }
  const outcomes = Object.entries(record.outcome as Record<string, unknown>);
  if (outcomes.length !== 1 || (outcomes[0]![1] !== "boolean" && outcomes[0]![1] !== "number")) {
    return null;
  }
  return {
    worldId: record.worldId,
    attributes,
    outcome: { [outcomes[0]![0]]: outcomes[0]![1] },
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

function rangesOf(description: AnyWorldDescription): PublicRanges {
  const ranges: Record<string, { min: number; max: number }> = {};
  for (const [name, bounds] of Object.entries(description.attributes)) {
    ranges[name] = { min: bounds.min, max: bounds.max };
  }
  return ranges;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
