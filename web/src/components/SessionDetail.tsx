import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiClient } from "../api.js";
import { formatNumber, formatTheory } from "../format.js";
import { extractMeasurements, extractTheoryAttempts } from "../transcript.js";
import type { AnyObservation, AnyWorldDescription, PublicSessionView, StoredEvaluation, TranscriptEntry } from "../types.js";
import { AgentFeed } from "./AgentFeed.js";
import { ExperimentSpace } from "./ExperimentSpace.js";
import { ExperimentTimeline } from "./ExperimentTimeline.js";
import { AlertIcon, ChatIcon, FlaskIcon, PauseIcon, PlayIcon, RulerIcon, ScaleIcon, SparkIcon, StepIcon } from "./Icons.js";
import { MeasurementList } from "./MeasurementList.js";
import { ProgressRing } from "./ProgressRing.js";
import { ScoreChart } from "./ScoreChart.js";
import { StatusBadge } from "./StatusBadge.js";

export interface SessionDetailProps {
  client: ApiClient;
  session: PublicSessionView;
  /** Null hides every score control. */
  operatorToken: string | null;
  evaluations: readonly StoredEvaluation[];
  onSessionChanged(session: PublicSessionView): void;
  onEvaluated(sessionId: string, evaluation: StoredEvaluation): void;
  onError(error: unknown): void;
}

type Activity = "idle" | "stepping" | "running" | "evaluating";

export function SessionDetail({
  client,
  session,
  operatorToken,
  evaluations,
  onSessionChanged,
  onEvaluated,
  onError,
}: SessionDetailProps) {
  const [world, setWorld] = useState<AnyWorldDescription | null>(null);
  const [observations, setObservations] = useState<AnyObservation[]>([]);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [activity, setActivity] = useState<Activity>("idle");
  const stopRequested = useRef(false);
  const mounted = useRef(true);
  const id = session.sessionId;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopRequested.current = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    client.world(id).then(
      (next) => !cancelled && setWorld(next),
      (error: unknown) => !cancelled && onError(error),
    );
    return () => {
      cancelled = true;
    };
  }, [client, id, onError]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.observations(id), client.transcript(id)])
      .then(([nextObservations, nextTranscript]) => {
        if (!cancelled) {
          setObservations(nextObservations);
          setTranscript(nextTranscript);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [client, id, session.modelTurns, session.status, onError]);

  const measurements = useMemo(() => extractMeasurements(transcript), [transcript]);
  const attempts = useMemo(() => extractTheoryAttempts(transcript), [transcript]);
  const outcome = world ? Object.entries(world.outcome)[0] : undefined;
  const running = session.status === "running";
  const busy = activity !== "idle";

  const run = useCallback(
    async (untilDone: boolean) => {
      stopRequested.current = false;
      setActivity(untilDone ? "running" : "stepping");
      try {
        let current = session;
        const limit = untilDone ? current.maxModelTurns - current.modelTurns + 1 : 1;
        for (let request = 0; request < limit && !stopRequested.current; request++) {
          current = (await client.step(id, 1)).session;
          if (!mounted.current) return;
          onSessionChanged(current);
          if (current.status !== "running") break;
        }
      } catch (error) {
        if (mounted.current) onError(error);
      } finally {
        if (mounted.current) setActivity("idle");
      }
    },
    [client, id, session, onSessionChanged, onError],
  );

  const evaluate = useCallback(async () => {
    if (operatorToken === null) return;
    setActivity("evaluating");
    try {
      onEvaluated(id, await client.evaluate(id, operatorToken));
    } catch (error) {
      onError(error);
    } finally {
      if (mounted.current) setActivity("idle");
    }
  }, [client, id, operatorToken, onEvaluated, onError]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "s" && running && !busy) {
        event.preventDefault();
        void run(false);
      } else if (key === "r" && running && !busy) {
        event.preventDefault();
        void run(true);
      } else if (key === "p" && activity === "running") {
        stopRequested.current = true;
      } else if (key === "e" && operatorToken !== null && session.submittedTheory !== null && !busy) {
        event.preventDefault();
        void evaluate();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, busy, activity, operatorToken, session.submittedTheory, run, evaluate]);

  const latest = evaluations.at(-1);
  const acceptedAttempts = attempts.filter((attempt) => attempt.accepted).length;

  return (
    <section className="detail" aria-label="Session detail">
      <header className="detail-header">
        <div className="detail-title">
          <div className="eyebrow">
            <span className="mono">{id.slice(0, 8)}</span>
            <span>·</span>
            <span>{session.provider} agent</span>
            <span>·</span>
            <time dateTime={session.createdAt}>{new Date(session.createdAt).toLocaleString()}</time>
          </div>
          <h2>
            <span className="gradient-text">{session.worldId}</span>
            <StatusBadge status={session.status} />
          </h2>
          {world ? (
            <div className="chips" aria-label="World inputs">
              {Object.entries(world.attributes).map(([name, range]) => (
                <span key={name} className="chip mono">
                  {name} ∈ [{formatNumber(range.min)}, {formatNumber(range.max)}]
                </span>
              ))}
              {outcome && (
                <span className="chip chip-accent mono">
                  → {outcome[0]}: {outcome[1]}
                </span>
              )}
              {world.observationNoise === "present" && <span className="chip chip-warn">noisy observations</span>}
            </div>
          ) : (
            <div className="chips">
              <span className="skeleton skeleton-chip" />
              <span className="skeleton skeleton-chip" />
              <span className="skeleton skeleton-chip" />
            </div>
          )}
        </div>

        <div className="actions" role="toolbar" aria-label="Session actions">
          <button
            type="button"
            className="button"
            aria-label="Step one turn"
            aria-keyshortcuts="S"
            disabled={!running || busy}
            onClick={() => void run(false)}
          >
            <StepIcon />
            <span>Step</span>
            <kbd aria-hidden="true">S</kbd>
          </button>
          {activity === "running" ? (
            <button
              type="button"
              className="button primary"
              aria-label="Pause run"
              aria-keyshortcuts="P"
              onClick={() => {
                stopRequested.current = true;
              }}
            >
              <PauseIcon />
              <span>Pause</span>
              <kbd aria-hidden="true">P</kbd>
            </button>
          ) : (
            <button
              type="button"
              className="button primary"
              aria-label="Run to end"
              aria-keyshortcuts="R"
              disabled={!running || busy}
              onClick={() => void run(true)}
            >
              <PlayIcon />
              <span>Run to end</span>
              <kbd aria-hidden="true">R</kbd>
            </button>
          )}
          {operatorToken !== null && (
            <button
              type="button"
              className="button operator-button"
              aria-label="Evaluate theory"
              aria-keyshortcuts="E"
              disabled={session.submittedTheory === null || busy}
              onClick={() => void evaluate()}
            >
              <ScaleIcon />
              <span>Evaluate</span>
              <kbd aria-hidden="true">E</kbd>
            </button>
          )}
        </div>
      </header>

      {busy && (
        <div className="live-banner" role="status">
          <span className="pulse" aria-hidden="true" />
          {activity === "evaluating"
            ? "Scoring the theory on held-out cases…"
            : activity === "running"
              ? `Agent working · turn ${session.modelTurns + 1} of ${session.maxModelTurns}`
              : "Agent taking one turn…"}
        </div>
      )}

      {session.providerDiagnostic && (
        <div className="notice">
          <AlertIcon />
          <span>
            Provider stopped the run: {session.providerDiagnostic.category}
            {session.providerDiagnostic.httpStatus ? ` (HTTP ${session.providerDiagnostic.httpStatus})` : ""}
          </span>
        </div>
      )}

      <div className="kpis">
        <Kpi label="Model turns" value={session.modelTurns} max={session.maxModelTurns} tone="accent" icon={<ChatIcon />} />
        <Kpi label="Experiments" value={session.experimentCount} max={session.budget} tone="cyan" icon={<FlaskIcon />} />
        <Kpi label="Measurements" value={measurements.length} icon={<RulerIcon />} />
        <Kpi label="Theory attempts" value={attempts.length} detail={`${acceptedAttempts} accepted`} icon={<SparkIcon />} />
      </div>

      <div className="card theory-card">
        <div className="card-head">
          <h3>
            <SparkIcon /> Theory
          </h3>
          {session.submittedTheory ? <span className="tag tag-pass">submitted</span> : <span className="tag">pending</span>}
        </div>
        <p className={session.submittedTheory ? "formula hero" : "formula hero placeholder"}>
          {session.submittedTheory ? formatTheory(session.submittedTheory) : "Waiting for the agent to commit to a rule…"}
        </p>
        {attempts.length > 0 && (
          <table className="table compact" aria-label="Theory attempts">
            <thead>
              <tr>
                <th>Attempt</th>
                <th>Theory</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt, index) => (
                <tr key={attempt.callId}>
                  <td>{index + 1}</td>
                  <td>
                    <code className="formula small">{formatTheory(attempt.theory)}</code>
                  </td>
                  <td>
                    {attempt.accepted ? (
                      <span className="tag tag-pass">accepted</span>
                    ) : (
                      <span className="tag tag-fail">{attempt.errorCode ?? "no result"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h3>
              <FlaskIcon /> Experiment space
            </h3>
            <span className="muted small">{observations.length} probes</span>
          </div>
          {world && outcome ? (
            observations.length === 0 ? (
              <div className="empty-state compact">
                <p>No probes yet.</p>
              </div>
            ) : (
              <ExperimentSpace
                observations={observations}
                attributes={world.attributes}
                outcomeName={outcome[0]}
                outcomeKind={outcome[1]}
              />
            )
          ) : (
            <div className="skeleton skeleton-block" />
          )}
        </div>
        <div className="card feed-card">
          <div className="card-head">
            <h3>
              <ChatIcon /> Agent activity
            </h3>
            {busy && activity !== "evaluating" && <span className="live-dot">live</span>}
          </div>
          <div className="feed-scroll">
            <AgentFeed entries={transcript} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Experiment timeline</h3>
        </div>
        {outcome ? (
          <ExperimentTimeline observations={observations} outcomeName={outcome[0]} outcomeKind={outcome[1]} />
        ) : (
          <div className="skeleton skeleton-block short" />
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>
            <RulerIcon /> Measurements
          </h3>
        </div>
        <MeasurementList measurements={measurements} />
      </div>

      {operatorToken !== null && (
        <div className="card operator-card">
          <div className="card-head">
            <h3>
              <ScaleIcon /> Held-out scores <span className="tag tag-operator">evaluator only</span>
            </h3>
          </div>
          {latest ? (
            <ScoreChart report={latest.report} title={`Evaluation ${latest.evaluationId}`} />
          ) : (
            <div className="empty-state compact">
              <p>Not evaluated yet.</p>
              <span className="muted">Press Evaluate to score the theory on fresh, hidden cases.</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Kpi({
  label,
  value,
  max,
  detail,
  tone,
  icon,
}: {
  label: string;
  value: number;
  max?: number;
  detail?: string;
  tone?: "accent" | "cyan" | "amber";
  icon: ReactNode;
}) {
  return (
    <div className="kpi">
      {max !== undefined ? <ProgressRing value={value} max={max} tone={tone} /> : <span className="kpi-icon">{icon}</span>}
      <div>
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">
          {value}
          {max !== undefined && <span className="kpi-max"> / {max}</span>}
        </div>
        {detail && <div className="kpi-detail">{detail}</div>}
      </div>
    </div>
  );
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
}
