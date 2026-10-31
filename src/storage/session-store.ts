/**
 * Durable storage for discovery sessions.
 *
 * A record holds everything needed to show a session and to continue it
 * after a restart: its settings (including the private noise seed), the
 * public transcript, the provider conversation, the observation log, the
 * submitted theory, and the evaluator's results. The HTTP layer decides which
 * of these fields any response may contain; the store itself is
 * operator-side and is never handed to an agent.
 *
 * Every backend must pass `tests/storage-contract.ts`.
 */
import type { DiscoveryStatus, TranscriptEntry } from "../agents/discovery-agent.js";
import type { AnyWorldReport, WorldEvaluationOptions } from "../evaluator/world-evaluator.js";
import type { LlmMessage, ProviderErrorDiagnostic } from "../llm/provider.js";
import type { AnyObservation } from "../tools/public-types.js";

export type ProviderKind = "dummy" | "gemini";
export type SessionStatus = DiscoveryStatus | "running";

export interface StoredTheory {
  measurement: unknown;
  operator?: string;
  threshold?: number;
}

export interface StoredEvaluation {
  evaluationId: number;
  evaluatedAt: string;
  options: WorldEvaluationOptions;
  report: AnyWorldReport;
}

export interface SessionConfig {
  budget: number;
  maxModelTurns: number;
  timeoutMs: number;
  maxRetries: number;
  /** Private. Null means the world's default noise stream. */
  noiseSeed: number | null;
}

/** Fields that change as the agent works. */
export interface SessionProgress {
  status: SessionStatus;
  modelTurns: number;
  transcript: TranscriptEntry[];
  /** Provider conversation, kept so a running session can resume. */
  messages: LlmMessage[];
  observations: AnyObservation[];
  submittedTheory: StoredTheory | null;
  providerDiagnostic: ProviderErrorDiagnostic | null;
  updatedAt: string;
}

export interface SessionRecord extends SessionProgress {
  sessionId: string;
  worldId: string;
  provider: ProviderKind;
  createdAt: string;
  config: SessionConfig;
  evaluations: StoredEvaluation[];
}

export class DuplicateSessionError extends Error {
  constructor() {
    super("A session with that id already exists.");
    this.name = "DuplicateSessionError";
  }
}

export interface SessionStore {
  readonly kind: "memory" | "mongodb";
  /** Throws `DuplicateSessionError` when the id is taken. */
  insert(record: SessionRecord): Promise<void>;
  get(sessionId: string): Promise<SessionRecord | null>;
  /** Oldest first, ties broken by id. */
  list(): Promise<SessionRecord[]>;
  count(): Promise<number>;
  /** False when the session does not exist. */
  saveProgress(sessionId: string, progress: SessionProgress): Promise<boolean>;
  /** Appends atomically. False when the session does not exist. */
  appendEvaluation(sessionId: string, evaluation: StoredEvaluation): Promise<boolean>;
  /** False when the session does not exist. */
  remove(sessionId: string): Promise<boolean>;
  close(): Promise<void>;
}

/** Keeps records in this process. Every read and write copies, so callers never share state with the store. */
export function createMemorySessionStore(): SessionStore {
  const records = new Map<string, SessionRecord>();
  let closed = false;

  function open(): void {
    if (closed) {
      throw new Error("The session store is closed.");
    }
  }

  return {
    kind: "memory",
    async insert(record) {
      open();
      if (records.has(record.sessionId)) {
        throw new DuplicateSessionError();
      }
      records.set(record.sessionId, structuredClone(record));
    },
    async get(sessionId) {
      open();
      const record = records.get(sessionId);
      return record === undefined ? null : structuredClone(record);
    },
    async list() {
      open();
      return [...records.values()].sort(compareRecords).map((record) => structuredClone(record));
    },
    async count() {
      open();
      return records.size;
    },
    async saveProgress(sessionId, progress) {
      open();
      const record = records.get(sessionId);
      if (record === undefined) {
        return false;
      }
      records.set(sessionId, { ...record, ...structuredClone(pickProgress(progress)) });
      return true;
    },
    async appendEvaluation(sessionId, evaluation) {
      open();
      const record = records.get(sessionId);
      if (record === undefined) {
        return false;
      }
      record.evaluations.push(structuredClone(evaluation));
      return true;
    },
    async remove(sessionId) {
      open();
      return records.delete(sessionId);
    },
    async close() {
      closed = true;
      records.clear();
    },
  };
}

export function compareRecords(left: SessionRecord, right: SessionRecord): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
}

/** Copies exactly the progress fields, so stray properties are never stored. */
export function pickProgress(progress: SessionProgress): SessionProgress {
  return {
    status: progress.status,
    modelTurns: progress.modelTurns,
    transcript: progress.transcript,
    messages: progress.messages,
    observations: progress.observations,
    submittedTheory: progress.submittedTheory,
    providerDiagnostic: progress.providerDiagnostic,
    updatedAt: progress.updatedAt,
  };
}
