/** Pulls measurements and theory attempts out of a public transcript. */
import type { TranscriptEntry } from "./types.js";

export interface MeasurementRecord {
  callId: string;
  expression: unknown;
  ok: boolean;
  errorCode: string | null;
  values: Array<{ step: number; value: number | null }>;
}

export interface TheoryAttempt {
  callId: string;
  theory: { measurement: unknown; operator?: string; threshold?: number } | null;
  accepted: boolean;
  errorCode: string | null;
}

export function extractMeasurements(entries: readonly TranscriptEntry[]): MeasurementRecord[] {
  return pairCalls(entries, "evaluate_measurement").map(({ callId, args, output }) => {
    const record = asRecord(args);
    const expression = typeof record?.expression === "string" ? parseJson(record.expression) : record?.expression;
    const rows = Array.isArray(output?.rows) ? output.rows : [];
    return {
      callId,
      expression,
      ok: output?.ok === true,
      errorCode: errorCodeOf(output),
      values: rows.map((row) => {
        const value = asRecord(row);
        return {
          step: typeof value?.step === "number" ? value.step : 0,
          value: typeof value?.value === "number" ? value.value : null,
        };
      }),
    };
  });
}

export function extractTheoryAttempts(entries: readonly TranscriptEntry[]): TheoryAttempt[] {
  return pairCalls(entries, "submit_theory").map(({ callId, args, output }) => {
    const record = asRecord(args);
    return {
      callId,
      theory:
        record === null
          ? null
          : {
              measurement: record.measurement,
              operator: typeof record.operator === "string" ? record.operator : undefined,
              threshold: typeof record.threshold === "number" ? record.threshold : undefined,
            },
      accepted: output?.ok === true,
      errorCode: errorCodeOf(output),
    };
  });
}

function pairCalls(
  entries: readonly TranscriptEntry[],
  name: string,
): Array<{ callId: string; args: unknown; output: Record<string, unknown> | null }> {
  const results = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (entry.type === "tool_result" && entry.name === name) {
      results.set(entry.callId, entry.output);
    }
  }
  const pairs: Array<{ callId: string; args: unknown; output: Record<string, unknown> | null }> = [];
  for (const entry of entries) {
    if (entry.type !== "tool_calls") {
      continue;
    }
    for (const call of entry.calls) {
      if (call.name === name) {
        pairs.push({ callId: call.id, args: call.arguments, output: results.get(call.id) ?? null });
      }
    }
  }
  return pairs;
}

function errorCodeOf(output: Record<string, unknown> | null): string | null {
  const error = asRecord(output?.error);
  return typeof error?.code === "string" ? error.code : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
