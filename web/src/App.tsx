import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, type ApiClient } from "./api.js";
import { CreateSessionForm } from "./components/CreateSessionForm.js";
import { FlaskIcon, LogoMark, ScaleIcon, SparkIcon } from "./components/Icons.js";
import { OperatorPanel } from "./components/OperatorPanel.js";
import { ScoreChart } from "./components/ScoreChart.js";
import { SessionDetail } from "./components/SessionDetail.js";
import { SessionList } from "./components/SessionList.js";
import { TheoryTable } from "./components/TheoryTable.js";
import { Toasts, type Toast } from "./components/Toasts.js";
import { formatTheory } from "./format.js";
import type { CreateSessionBody, PublicSessionView, PublicWorld, StoredEvaluation } from "./types.js";

const SUCCESS_TOAST_MS = 3500;
type Connection = "connecting" | "online" | "offline";

export function App({ client }: { client: ApiClient }) {
  const [worlds, setWorlds] = useState<PublicWorld[]>([]);
  const [sessions, setSessions] = useState<PublicSessionView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [operatorToken, setOperatorToken] = useState<string | null>(null);
  const [evaluations, setEvaluations] = useState<Record<string, StoredEvaluation[]>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [busy, setBusy] = useState(false);
  const nextToastId = useRef(1);
  const worldSelect = useRef<HTMLSelectElement>(null);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (tone: Toast["tone"], text: string) => {
      const id = nextToastId.current++;
      setToasts((current) => (current.some((toast) => toast.text === text) ? current : [...current, { id, tone, text }]));
      if (tone === "success") {
        setTimeout(() => dismiss(id), SUCCESS_TOAST_MS);
      }
    },
    [dismiss],
  );

  const showError = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiClientError) {
        setConnection("online");
        notify("error", `${cause.message} (${cause.code})`);
      } else {
        setConnection("offline");
        notify("error", "Could not reach the XENO API.");
      }
    },
    [notify],
  );

  useEffect(() => {
    client.worlds().then((next) => {
      setWorlds(next);
      setConnection("online");
    }, showError);
    client.listSessions().then((next) => {
      setSessions(next);
      setSelectedId((current) => current ?? next.at(-1)?.sessionId ?? null);
    }, showError);
  }, [client, showError]);

  // Scores reload when the token changes or a theory appears, not on every step.
  const theoryCount = sessions.filter((session) => session.submittedTheory !== null).length;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => {
    if (operatorToken === null) {
      setEvaluations({});
      return;
    }
    let cancelled = false;
    const evaluable = sessionsRef.current.filter((session) => session.submittedTheory !== null);
    Promise.all(evaluable.map((session) => client.operatorView(session.sessionId, operatorToken)))
      .then((views) => {
        if (!cancelled) {
          setEvaluations(Object.fromEntries(views.map((view) => [view.sessionId, view.evaluations])));
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiClientError && (cause.status === 401 || cause.status === 403)) {
          setOperatorToken(null);
        }
        showError(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [client, operatorToken, theoryCount, showError]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        worldSelect.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function create(body: CreateSessionBody) {
    setBusy(true);
    try {
      const session = await client.createSession(body);
      setSessions((current) => [...current, session]);
      setSelectedId(session.sessionId);
      notify("success", `Session started on ${session.worldId}`);
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function remove(sessionId: string) {
    try {
      await client.deleteSession(sessionId);
      setSessions((current) => current.filter((session) => session.sessionId !== sessionId));
      if (selectedId === sessionId) setSelectedId(null);
      notify("success", "Session deleted");
    } catch (cause) {
      showError(cause);
    }
  }

  const updateSession = useCallback((updated: PublicSessionView) => {
    setSessions((current) => current.map((session) => (session.sessionId === updated.sessionId ? updated : session)));
  }, []);

  const addEvaluation = useCallback(
    (sessionId: string, evaluation: StoredEvaluation) => {
      setEvaluations((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), evaluation] }));
      notify("success", `Evaluation ${evaluation.evaluationId} complete`);
    },
    [notify],
  );

  const selected = sessions.find((session) => session.sessionId === selectedId) ?? null;
  const theoryRows = useMemo(
    () =>
      sessions.map((session) => ({
        session,
        report: operatorToken === null ? undefined : (evaluations[session.sessionId]?.at(-1)?.report ?? null),
      })),
    [sessions, evaluations, operatorToken],
  );
  const scored = sessions.filter((session) => (evaluations[session.sessionId]?.length ?? 0) > 0);
  const runningCount = sessions.filter((session) => session.status === "running").length;

  return (
    <div className="app">
      <div className="backdrop" aria-hidden="true" />
      <header className="topbar">
        <div className="brand">
          <LogoMark />
          <div>
            <h1>XENO</h1>
            <span className="brand-tagline">Hidden-rule discovery lab</span>
          </div>
        </div>
        <div className="topbar-stats" aria-label="Lab status">
          <span className={`connection connection-${connection}`}>
            <span className="connection-dot" aria-hidden="true" />
            {connection === "online" ? "API online" : connection === "offline" ? "API offline" : "Connecting…"}
          </span>
          <span className="topbar-stat">
            <strong>{sessions.length}</strong> sessions
          </span>
          <span className="topbar-stat">
            <strong>{runningCount}</strong> running
          </span>
          <span className="topbar-stat">
            <strong>{theoryCount}</strong> theories
          </span>
        </div>
        <OperatorPanel active={operatorToken !== null} onUnlock={setOperatorToken} onLock={() => setOperatorToken(null)} />
      </header>

      <div className="shell">
        <aside className="rail">
          <section className="rail-section">
            <h2 className="rail-heading">
              New session <kbd>N</kbd>
            </h2>
            <CreateSessionForm ref={worldSelect} worlds={worlds} busy={busy} onCreate={create} />
          </section>
          <section className="rail-section grow">
            <h2 className="rail-heading">
              Sessions <span className="count">{sessions.length}</span>
            </h2>
            <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} onDelete={remove} />
          </section>
          <footer className="rail-foot" aria-label="Keyboard shortcuts">
            <span>
              <kbd>N</kbd> new
            </span>
            <span>
              <kbd>S</kbd> step
            </span>
            <span>
              <kbd>R</kbd> run
            </span>
            <span>
              <kbd>P</kbd> pause
            </span>
            {operatorToken !== null && (
              <span>
                <kbd>E</kbd> evaluate
              </span>
            )}
          </footer>
        </aside>

        <main className="main">
          {selected ? (
            <SessionDetail
              key={selected.sessionId}
              client={client}
              session={selected}
              operatorToken={operatorToken}
              evaluations={evaluations[selected.sessionId] ?? []}
              onSessionChanged={updateSession}
              onEvaluated={addEvaluation}
              onError={showError}
            />
          ) : (
            <Welcome hasSessions={sessions.length > 0} />
          )}

          <section className="card" aria-label="All theories">
            <div className="card-head">
              <h2>
                <SparkIcon /> Theories
              </h2>
              <span className="muted small">Every rule an agent has committed to</span>
            </div>
            <TheoryTable rows={theoryRows} showScores={operatorToken !== null} />
          </section>

          {operatorToken !== null && scored.length > 0 && (
            <section className="card operator-card" aria-label="Score charts">
              <div className="card-head">
                <h2>
                  <ScaleIcon /> Score charts <span className="tag tag-operator">evaluator only</span>
                </h2>
              </div>
              <div className="chart-grid">
                {scored.map((session) => (
                  <div key={session.sessionId} className="chart-tile">
                    <div className="chart-title">
                      <strong>{session.worldId}</strong>
                      <code className="formula small">{formatTheory(session.submittedTheory)}</code>
                    </div>
                    <ScoreChart report={evaluations[session.sessionId]!.at(-1)!.report} title={session.worldId} />
                  </div>
                ))}
              </div>
            </section>
          )}
        </main>
      </div>

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function Welcome({ hasSessions }: { hasSessions: boolean }) {
  return (
    <section className="welcome">
      <div className="welcome-orb" aria-hidden="true">
        <FlaskIcon />
      </div>
      <h2>{hasSessions ? "Pick a session to inspect" : "Start your first discovery run"}</h2>
      <p className="muted">
        An agent probes a world whose rule is hidden, designs measurements, and commits to a theory. You watch every
        experiment as it happens.
      </p>
      <ol className="welcome-steps">
        <li>
          <span className="step-number">1</span>
          <div>
            <strong>Choose a world</strong>
            <span className="muted">Set a budget of experiments and model turns.</span>
          </div>
        </li>
        <li>
          <span className="step-number">2</span>
          <div>
            <strong>Run the agent</strong>
            <span className="muted">Step turn by turn, or run to the end and watch it live.</span>
          </div>
        </li>
        <li>
          <span className="step-number">3</span>
          <div>
            <strong>Score the theory</strong>
            <span className="muted">With the operator token, test it on hidden cases.</span>
          </div>
        </li>
      </ol>
    </section>
  );
}
