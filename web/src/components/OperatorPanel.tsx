import { useState, type FormEvent } from "react";
import { LockIcon, UnlockIcon } from "./Icons.js";

export interface OperatorPanelProps {
  active: boolean;
  onUnlock(token: string): void;
  onLock(): void;
}

/** Holds the operator token in memory only. Scores never appear without it. */
export function OperatorPanel({ active, onUnlock, onLock }: OperatorPanelProps) {
  const [token, setToken] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (token.trim() !== "") {
      onUnlock(token.trim());
      setToken("");
    }
  }

  if (active) {
    return (
      <div className="operator active" aria-label="Operator mode">
        <span className="operator-state">
          <UnlockIcon />
          Operator mode: held-out scores visible
        </span>
        <button type="button" className="button ghost small" onClick={onLock}>
          Hide scores
        </button>
      </div>
    );
  }
  return (
    <form className="operator" onSubmit={submit} aria-label="Operator mode">
      <label className="operator-field">
        <LockIcon />
        <span className="visually-hidden">Operator token</span>
        <input
          type="password"
          autoComplete="off"
          placeholder="Operator token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      <button type="submit" className="button ghost small" disabled={token.trim() === ""}>
        Show scores
      </button>
    </form>
  );
}
