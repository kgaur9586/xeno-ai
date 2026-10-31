/**
 * In-memory discovery sessions for the HTTP API.
 *
 * A session owns its experiment tools and a stepwise discovery run. Public
 * views contain only what the agent itself could see or produce: the public
 * world description, the transcript, the observation log, and the submitted
 * theory. The noise seed, evaluation options, and evaluator reports are kept
 * apart and only reach the evaluator-only views.
 */
import { randomUUID } from "node:crypto";
import { createDiscoveryRun, type DiscoveryRun, type DiscoveryStatus, type TranscriptEntry } from "../agents/discovery-agent.js";
import { GLOW_WORLD_SESSION_ID } from "../agents/discovery-session.js";
import {
  evaluateWorldTheoryById,
  type AnyWorldReport,
  type WorldEvaluationOptions,
} from "../evaluator/world-evaluator.js";
import type { LlmProvider, ProviderErrorDiagnostic } from "../llm/provider.js";
import { createExperimentTools } from "../tools/experiment-tools.js";
import type { AnyExperimentTools, AnyObservation, AnyWorldDescription } from "../tools/public-types.js";
import { createWorldToolsById } from "../tools/world-tools.js";
import { WORLD_IDS } from "../worlds/registry.js";
import { ApiError, type CreateSessionRequest } from "./schemas.js";

export const DEFAULT_MAX_SESSIONS = 100;

export type ProviderKind = "dummy" | "gemini";

export interface SessionManagerOptions {
  /** Provider factories. A kind without a factory is not available. */
  providers: Partial<Record<ProviderKind, () => LlmProvider>>;
  /** Scrubbed from transcripts. Never returned. */
  secrets?: readonly string[];
  maxSessions?: number;
  now?: () => Date;
}

export interface PublicTheory {
  measurement: unknown;
  operator?: string;
  threshold?: number;
}

export interface PublicSessionView {
  sessionId: string;
  worldId: string;
  provider: ProviderKind;
  createdAt: string;
  status: DiscoveryStatus | "running";
  modelTurns: number;
  maxModelTurns: number;
  budget: number;
  experimentCount: number;
  remainingBudget: number;
  submittedTheory: PublicTheory | null;
  providerDiagnostic: ProviderErrorDiagnostic | null;
}

export interface StoredEvaluation {
  evaluationId: number;
  evaluatedAt: string;
  options: WorldEvaluationOptions;
  report: AnyWorldReport;
}

export interface OperatorSessionView {
  sessionId: string;
  worldId: string;
  /** Null when the session used the world's default noise stream. */
  noiseSeed: number | null;
  evaluations: StoredEvaluation[];
}

interface Session {
  id: string;
  worldId: string;
  provider: ProviderKind;
  createdAt: string;
  budget: number;
  maxModelTurns: number;
  tools: AnyExperimentTools;
  run: DiscoveryRun;
  busy: boolean;
  noiseSeed: number | null;
  evaluations: StoredEvaluation[];
}

export interface SessionManager {
  worldIds(): readonly string[];
  publicWorld(worldId: string): Omit<AnyWorldDescription, "experimentBudget">;
  create(request: CreateSessionRequest): PublicSessionView;
  list(): PublicSessionView[];
  view(sessionId: string): PublicSessionView;
  world(sessionId: string): AnyWorldDescription;
  observations(sessionId: string): AnyObservation[];
  transcript(sessionId: string, from: number): { entries: TranscriptEntry[]; total: number; nextIndex: number };
  step(sessionId: string, turns: number): Promise<{ turnsRun: number; session: PublicSessionView; entries: TranscriptEntry[] }>;
  remove(sessionId: string): void;
  evaluate(sessionId: string, options: WorldEvaluationOptions): StoredEvaluation;
  operatorView(sessionId: string): OperatorSessionView;
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const sessions = new Map<string, Session>();
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const now = options.now ?? (() => new Date());
  const secrets = options.secrets ?? [];

  function get(sessionId: string): Session {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      throw new ApiError("NOT_FOUND");
    }
    return session;
  }

  function publicView(session: Session): PublicSessionView {
    const snapshot = session.run.snapshot();
    const theory = snapshot.submittedTheory ?? snapshot.submittedNumericTheory;
    return {
      sessionId: session.id,
      worldId: session.worldId,
      provider: session.provider,
      createdAt: session.createdAt,
      status: snapshot.status ?? "running",
      modelTurns: snapshot.modelTurns,
      maxModelTurns: session.maxModelTurns,
      budget: session.budget,
      experimentCount: session.tools.getObservationLog().length,
      remainingBudget: session.tools.getRemainingBudget(),
      submittedTheory: theory === null ? null : copyTheory(theory),
      providerDiagnostic: snapshot.providerDiagnostic,
    };
  }

  return {
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

    create(request) {
      if (!WORLD_IDS.includes(request.worldId)) {
        throw new ApiError("UNKNOWN_WORLD");
      }
      const factory = options.providers[request.provider];
      if (factory === undefined) {
        throw new ApiError("PROVIDER_UNAVAILABLE");
      }
      if (sessions.size >= maxSessions) {
        throw new ApiError("SESSION_LIMIT");
      }
      const tools: AnyExperimentTools =
        request.worldId === GLOW_WORLD_SESSION_ID && request.noiseSeed === undefined
          ? createExperimentTools({ budget: request.budget })
          : createWorldToolsById(request.worldId, { budget: request.budget, noiseSeed: request.noiseSeed });
      const run = createDiscoveryRun({
        provider: factory(),
        tools,
        maxModelTurns: request.maxModelTurns,
        timeoutMs: request.timeoutMs,
        maxRetries: request.maxRetries,
        secrets,
      });
      const session: Session = {
        id: randomUUID(),
        worldId: request.worldId,
        provider: request.provider,
        createdAt: now().toISOString(),
        budget: request.budget,
        maxModelTurns: request.maxModelTurns,
        tools,
        run,
        busy: false,
        noiseSeed: request.noiseSeed ?? null,
        evaluations: [],
      };
      sessions.set(session.id, session);
      return publicView(session);
    },

    list() {
      return [...sessions.values()].map(publicView);
    },

    view(sessionId) {
      return publicView(get(sessionId));
    },

    world(sessionId) {
      return get(sessionId).tools.describeWorld();
    },

    observations(sessionId) {
      return get(sessionId).tools.getObservationLog();
    },

    transcript(sessionId, from) {
      const entries = get(sessionId).run.snapshot().transcript;
      const slice = entries.slice(from);
      return { entries: slice, total: entries.length, nextIndex: Math.max(from, entries.length) };
    },

    async step(sessionId, turns) {
      const session = get(sessionId);
      if (session.busy) {
        throw new ApiError("SESSION_BUSY");
      }
      if (session.run.status() !== null) {
        throw new ApiError("SESSION_FINISHED");
      }
      session.busy = true;
      const before = session.run.snapshot().transcript.length;
      let turnsRun = 0;
      try {
        while (turnsRun < turns && session.run.status() === null) {
          await session.run.step();
          turnsRun++;
        }
      } finally {
        session.busy = false;
      }
      return {
        turnsRun,
        session: publicView(session),
        entries: session.run.snapshot().transcript.slice(before),
      };
    },

    remove(sessionId) {
      const session = get(sessionId);
      if (session.busy) {
        throw new ApiError("SESSION_BUSY");
      }
      sessions.delete(sessionId);
    },

    evaluate(sessionId, evaluation) {
      const session = get(sessionId);
      const snapshot = session.run.snapshot();
      const theory = snapshot.submittedTheory ?? snapshot.submittedNumericTheory;
      if (theory === null) {
        throw new ApiError("NO_THEORY");
      }
      const result = evaluateWorldTheoryById(session.worldId, copyTheory(theory), evaluation);
      if (!result.ok) {
        throw new ApiError("INTERNAL_ERROR");
      }
      const stored: StoredEvaluation = {
        evaluationId: session.evaluations.length + 1,
        evaluatedAt: now().toISOString(),
        options: { ...evaluation },
        report: result.report,
      };
      session.evaluations.push(stored);
      return structuredClone(stored);
    },

    operatorView(sessionId) {
      const session = get(sessionId);
      return {
        sessionId: session.id,
        worldId: session.worldId,
        noiseSeed: session.noiseSeed,
        evaluations: structuredClone(session.evaluations),
      };
    },
  };
}

function copyTheory(theory: { measurement: unknown; operator?: string; threshold?: number }): PublicTheory {
  return theory.operator === undefined
    ? { measurement: structuredClone(theory.measurement) }
    : { measurement: structuredClone(theory.measurement), operator: theory.operator, threshold: theory.threshold! };
}
