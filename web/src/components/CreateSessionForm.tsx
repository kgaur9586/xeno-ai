import { forwardRef, useState, type FormEvent } from "react";
import type { CreateSessionBody, PublicWorld } from "../types.js";
import { PlusIcon } from "./Icons.js";

export interface CreateSessionFormProps {
  worlds: readonly PublicWorld[];
  busy: boolean;
  onCreate(body: CreateSessionBody): void;
}

export const CreateSessionForm = forwardRef<HTMLSelectElement, CreateSessionFormProps>(function CreateSessionForm(
  { worlds, busy, onCreate },
  worldRef,
) {
  const [worldId, setWorldId] = useState("");
  const [budget, setBudget] = useState("30");
  const [maxModelTurns, setMaxModelTurns] = useState("16");
  const [noiseSeed, setNoiseSeed] = useState("");
  const selectedWorld = worldId || worlds[0]?.worldId || "";
  const world = worlds.find((candidate) => candidate.worldId === selectedWorld);

  const budgetValue = toInteger(budget);
  const turnsValue = toInteger(maxModelTurns);
  const seedValue = noiseSeed.trim() === "" ? undefined : toInteger(noiseSeed);
  const budgetValid = budgetValue !== null && budgetValue >= 1;
  const turnsValid = turnsValue !== null && turnsValue >= 1;
  const valid = selectedWorld !== "" && budgetValid && turnsValid && seedValue !== null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) {
      return;
    }
    onCreate({
      worldId: selectedWorld,
      budget: budgetValue!,
      maxModelTurns: turnsValue!,
      ...(seedValue === undefined ? {} : { noiseSeed: seedValue }),
    });
  }

  return (
    <form className="create-form" onSubmit={submit} aria-label="Create session">
      <label className="field">
        <span className="field-label">World</span>
        <select ref={worldRef} value={selectedWorld} onChange={(event) => setWorldId(event.target.value)}>
          {worlds.map((candidate) => (
            <option key={candidate.worldId} value={candidate.worldId}>
              {candidate.worldId}
            </option>
          ))}
        </select>
      </label>
      {world && (
        <div className="world-preview" aria-hidden="true">
          <span className="chip">{Object.keys(world.attributes).length} inputs</span>
          <span className="chip">{Object.values(world.outcome)[0] === "number" ? "numeric" : "boolean"} outcome</span>
          {world.observationNoise === "present" && <span className="chip chip-warn">noisy</span>}
        </div>
      )}
      <div className="field-row">
        <label className="field">
          <span className="field-label">Budget</span>
          <input
            inputMode="numeric"
            aria-invalid={!budgetValid}
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Max turns</span>
          <input
            inputMode="numeric"
            aria-invalid={!turnsValid}
            value={maxModelTurns}
            onChange={(event) => setMaxModelTurns(event.target.value)}
          />
        </label>
      </div>
      <label className="field">
        <span className="field-label">
          Noise seed <span className="field-hint">optional · private</span>
        </span>
        <input
          inputMode="numeric"
          placeholder="default stream"
          aria-invalid={seedValue === null}
          value={noiseSeed}
          onChange={(event) => setNoiseSeed(event.target.value)}
        />
      </label>
      <button type="submit" className="button primary block" disabled={!valid || busy} aria-keyshortcuts="N">
        <PlusIcon />
        <span>Create session</span>
      </button>
    </form>
  );
});

function toInteger(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}
