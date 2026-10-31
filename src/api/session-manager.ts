/**
 * Discovery sessions for the HTTP API, persisted through a `SessionStore`.
 *
 * Public views contain only what the agent itself could see or produce: the
 * public world description, the transcript, the observation log, and the
 * submitted theory. The noise seed, evaluation options, and evaluator reports
 * are stored with the session but only reach the evaluator-only views.
 *
 * Running sessions keep a live agent run in memory. After a restart a
 * running session is rebuilt on its next step: its stored experiments are
 * replayed through fresh tools with the same private noise seed (rejected
 * requests draw no noise, so the stream lines up), every replayed outcome
 * must match the stored one, and the stored conversation is resumed.
 * Progress is saved after every model turn.
 */
import { randomUUID } from "node:crypto";
import { createDiscoveryRun, type DiscoveryRun, type TranscriptEntry } from "../agents/discovery-agent.js";
import { GLOW_WORLD_SESSION_ID } from "../agents/discovery-session.js";
import { evaluateWorldTheoryById, type WorldEvaluationOptions } from "../evaluator/world-evaluator.js";
import type { LlmProvider, ProviderErrorDiagnostic } from "../llm/provider.js";
import {
  createMemorySessionStore,
  type ProviderKind,
  type SessionProgress,
  type SessionRecord,
  type SessionStatus,
  type SessionStore,
  type StoredEvaluation,
  type StoredTheory,
} from "../storage/session-store.js";
import { createExperimentTools } from "../tools/experiment-tools.js";
import type { AnyExperimentTools, AnyObservation, AnyWorldDescription } from "../tools/public-types.js";
import { createWorldToolsById } from "../tools/world-tools.js";
import { WORLD_IDS } from "../worlds/registry.js";
import { ApiError, type CreateSessionRequest } from "./schemas.js";

export type { ProviderKind, StoredEvaluation } from "../storage/session-store.js";
export type PublicTheory = StoredTheory;

export const DEFAULT_MAX_SESSIONS = 100;

export interface SessionManagerOptions {
  /** Provider factories. A kind without a factory is not available. */
  providers: Partial<Record<ProviderKind, () => LlmProvider>>;
  /** Defaults to an in-memory store. */
  store?: SessionStore;
  /** Scrubbed from transcripts. Never returned. */
  secrets?: readonly string[];
  maxSessions?: number;
  now?: () => Date;
}

export interface PublicSessionView {
  sessionId: string;
  worldId: string;
  provider: ProviderKind;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  modelTurns: number;
  maxModelTurns: number;
  budget: number;
  experimentCount: number;
  remainingBudget: number;
  submittedTheory: PublicTheory | null;
  providerDiagnostic: ProviderErrorDiagnostic | null;
}

export interface OperatorSessionView {
  sessionId: string;
  worldId: string;
  /** Null when the session used the world's default noise stream. */
  noiseSeed: number | null;
  evaluations: StoredEvaluation[];
}

interface LiveSession {
  tools: AnyExperimentTools;
  run: DiscoveryRun;
}

export interface SessionManager {
  readonly storageKind: SessionStore["kind"];
  worldIds(): readonly string[];
  publicWorld(worldId: string): Omit<AnyWorldDescription, "experimentBudget">;
  create(request: CreateSessionRequest): Promise<PublicSessionView>;
  list(): Promise<PublicSessionView[]>;
  view(sessionId: string): Promise<PublicSessionView>;
  world(sessionId: string): Promise<AnyWorldDescription>;
  observations(sessionId: string): Promise<AnyObservation[]>;
  transcript(sessionId: string, from: number): Promise<{ entries: TranscriptEntry[]; total: number; nextIndex: number }>;
  step(sessionId: string, turns: number): Promise<{ turnsRun: number; session: PublicSessionView; entries: TranscriptEntry[] }>;
  remove(sessionId: string): Promise<void>;
  evaluate(sessionId: string, options: WorldEvaluationOptions): Promise<StoredEvaluation>;
  operatorView(sessionId: string): Promise<OperatorSessionView>;
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const store = options.store ?? createMemorySessionStore();
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const now = options.now ?? (() => new Date());
  const secrets = options.secrets ?? [];
  const live = new Map<string, LiveSession>();
  const busy = new Set<string>();

  async function load(sessionId: string): Promise<SessionRecord> {
    const record = await store.get(sessionId);
    if (record === null) {
      throw new ApiError("NOT_FOUND");
    }
    return record;
  }

  function openTools(record: Pick<SessionRecord, "worldId" | "config">): AnyExperimentTools {
    const { budget, noiseSeed } = record.config;
    return record.worldId === GLOW_WORLD_SESSION_ID && noiseSeed === null
      ? createExperimentTools({ budget })
      : createWorldToolsById(record.worldId, { budget, noiseSeed: noiseSeed ?? undefined });
  }

  function providerFor(kind: ProviderKind): LlmProvider {
    const factory = options.providers[kind];
    if (factory === undefined) {
      throw new ApiError("PROVIDER_UNAVAILABLE");
    }
    return factory();
  }

  function runOptions(record: Pick<SessionRecord, "provider" | "config">, tools: AnyExperimentTools) {
    return {
      provider: providerFor(record.provider),
      tools,
      maxModelTurns: record.config.maxModelTurns,
      timeoutMs: record.config.timeoutMs,
      maxRetries: record.config.maxRetries,
      secrets,
    };
  }

  function rehydrate(record: SessionRecord): LiveSession {
    const tools = openTools(record);
    for (const observation of record.observations) {
      const replayed = tools.runExperiment({ ...observation.inputs });
      if (!replayed.ok || JSON.stringify(replayed.observation) !== JSON.stringify(observation)) {
        throw new ApiError("SESSION_CORRUPT");
      }
    }
    const run = createDiscoveryRun(runOptions(record, tools), {
      transcript: record.transcript,
      messages: record.messages,
      modelTurns: record.modelTurns,
    });
    return { tools, run };
  }

  function progressOf(session: LiveSession): SessionProgress {
    const snapshot = session.run.snapshot();
    const theory = snapshot.submittedTheory ?? snapshot.submittedNumericTheory;
    return {
      status: snapshot.status ?? "running",
      modelTurns: snapshot.modelTurns,
      transcript: snapshot.transcript,
      messages: session.run.messages(),
      observations: session.tools.getObservationLog(),
      submittedTheory: theory === null ? null : copyTheory(theory),
      providerDiagnostic: snapshot.providerDiagnostic,
      updatedAt: now().toISOString(),
    };
  }

  return {
    storageKind: store.kind,

    worldIds() {
      return WORLD_IDS;
    },

    publicWorld(worldId) {
      if (!WORLD_IDS.includes(worldId)) {
        throw new ApiError("NOT_FOUND");
      }
      const { experimentBudget: _budget, ...description } = createWorldToolsById(worldId, { budget: 1 }).describeWorld();
      return description;
    },

    async create(request) {
      if (!WORLD_IDS.includes(request.worldId)) {
        throw new ApiError("UNKNOWN_WORLD");
      }
      if (options.providers[request.provider] === undefined) {
        throw new ApiError("PROVIDER_UNAVAILABLE");
      }
      if ((await store.count()) >= maxSessions) {
        throw new ApiError("SESSION_LIMIT");
      }
      const createdAt = now().toISOString();
      const base = {
        sessionId: randomUUID(),
        worldId: request.worldId,
        provider: request.provider,
        createdAt,
        config: {
          budget: request.budget,
          maxModelTurns: request.maxModelTurns,
          timeoutMs: request.timeoutMs,
          maxRetries: request.maxRetries,
          noiseSeed: request.noiseSeed ?? null,
        },
        evaluations: [],
      };
      const tools = openTools(base);
      const session: LiveSession = { tools, run: createDiscoveryRun(runOptions(base, tools)) };
      const record: SessionRecord = { ...base, ...progressOf(session), updatedAt: createdAt };
      await store.insert(record);
      live.set(record.sessionId, session);
      return publicView(record);
    },

    async list() {
      return (await store.list()).map(publicView);
    },

    async view(sessionId) {
      return publicView(await load(sessionId));
    },

    async world(sessionId) {
      const record = await load(sessionId);
      return openTools(record).describeWorld();
    },

    async observations(sessionId) {
      return (await load(sessionId)).observations;
    },

    async transcript(sessionId, from) {
      const entries = (await load(sessionId)).transcript;
      return { entries: entries.slice(from), total: entries.length, nextIndex: Math.max(from, entries.length) };
    },

    async step(sessionId, turns) {
      if (busy.has(sessionId)) {
        throw new ApiError("SESSION_BUSY");
      }
      busy.add(sessionId);
      try {
        const record = await load(sessionId);
        if (record.status !== "running") {
          live.delete(sessionId);
          throw new ApiError("SESSION_FINISHED");
        }
        let session = live.get(sessionId);
        if (session === undefined) {
          session = rehydrate(record);
          live.set(sessionId, session);
        }
        const before = record.transcript.length;
        let turnsRun = 0;
        let progress = progressOf(session);
        while (turnsRun < turns && session.run.status() === null) {
          await session.run.step();
          turnsRun++;
          progress = progressOf(session);
          if (!(await store.saveProgress(sessionId, progress))) {
            live.delete(sessionId);
            throw new ApiError("NOT_FOUND");
          }
        }
        if (session.run.status() !== null) {
          live.delete(sessionId);
        }
        return {
          turnsRun,
          session: publicView({ ...record, ...progress }),
          entries: progress.transcript.slice(before),
        };
      } finally {
        busy.delete(sessionId);
      }
    },

    async remove(sessionId) {
      if (busy.has(sessionId)) {
        throw new ApiError("SESSION_BUSY");
      }
      if (!(await store.remove(sessionId))) {
        throw new ApiError("NOT_FOUND");
      }
      live.delete(sessionId);
    },

    async evaluate(sessionId, evaluation) {
      const record = await load(sessionId);
      if (record.submittedTheory === null) {
        throw new ApiError("NO_THEORY");
      }
      const result = evaluateWorldTheoryById(record.worldId, copyTheory(record.submittedTheory), evaluation);
      if (!result.ok) {
        throw new ApiError("INTERNAL_ERROR");
      }
      const stored: StoredEvaluation = {
        evaluationId: record.evaluations.length + 1,
        evaluatedAt: now().toISOString(),
        options: { ...evaluation },
        report: result.report,
      };
      if (!(await store.appendEvaluation(sessionId, stored))) {
        throw new ApiError("NOT_FOUND");
      }
      return structuredClone(stored);
    },

    async operatorView(sessionId) {
      const record = await load(sessionId);
      return {
        sessionId: record.sessionId,
        worldId: record.worldId,
        noiseSeed: record.config.noiseSeed,
        evaluations: record.evaluations,
      };
    },
  };
}

function publicView(record: SessionRecord): PublicSessionView {
  return {
    sessionId: record.sessionId,
    worldId: record.worldId,
    provider: record.provider,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    modelTurns: record.modelTurns,
    maxModelTurns: record.config.maxModelTurns,
    budget: record.config.budget,
    experimentCount: record.observations.length,
    remainingBudget: record.config.budget - record.observations.length,
    submittedTheory: record.submittedTheory === null ? null : copyTheory(record.submittedTheory),
    providerDiagnostic: record.providerDiagnostic,
  };
}

function copyTheory(theory: { measurement: unknown; operator?: string; threshold?: number }): PublicTheory {
  return theory.operator === undefined
    ? { measurement: structuredClone(theory.measurement) }
    : { measurement: structuredClone(theory.measurement), operator: theory.operator, threshold: theory.threshold! };
}
