import type { PublicSessionView } from "../types.js";
import { OrbitIcon, TrashIcon } from "./Icons.js";
import { ProgressBar } from "./ProgressRing.js";
import { StatusBadge } from "./StatusBadge.js";

export interface SessionListProps {
  sessions: readonly PublicSessionView[];
  selectedId: string | null;
  onSelect(sessionId: string): void;
  onDelete(sessionId: string): void;
}

export function SessionList({ sessions, selectedId, onSelect, onDelete }: SessionListProps) {
  if (sessions.length === 0) {
    return (
      <div className="rail-empty">
        <OrbitIcon />
        <p>No sessions yet. Create one to start.</p>
      </div>
    );
  }
  return (
    <ul className="session-list" aria-label="Sessions">
      {[...sessions].reverse().map((session) => {
        const selected = session.sessionId === selectedId;
        const shortId = session.sessionId.slice(0, 8);
        return (
          <li key={session.sessionId} className={selected ? "session-card selected" : "session-card"}>
            <button
              type="button"
              className="session-open"
              aria-current={selected ? "true" : undefined}
              aria-label={`Open ${session.worldId} session ${shortId}`}
              onClick={() => onSelect(session.sessionId)}
            >
              <span className="session-top">
                <span className="session-world">{session.worldId}</span>
                <StatusBadge status={session.status} />
              </span>
              <span className="session-meta">
                <span className="mono">{shortId}</span>
                <span>·</span>
                <span>{session.provider}</span>
                <span className="session-count" title="Experiments used">
                  {session.experimentCount}/{session.budget}
                </span>
              </span>
              <ProgressBar value={session.experimentCount} max={session.budget} />
            </button>
            <button
              type="button"
              className="icon-button danger session-delete"
              aria-label={`Delete session ${shortId}`}
              title="Delete session"
              onClick={() => onDelete(session.sessionId)}
            >
              <TrashIcon />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
