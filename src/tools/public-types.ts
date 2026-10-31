/**
 * Type-only shapes shared by every set of agent-facing experiment tools.
 *
 * Both the Glow World tools and the generic world tools satisfy these
 * structurally. Agents and experimenters depend on these types, never on a
 * world engine.
 */

export interface PublicAttributeRange {
  min: number;
  max: number;
}

export interface AnyWorldDescription {
  worldId: string;
  attributes: Readonly<Record<string, PublicAttributeRange>>;
  /** Exactly one outcome name mapped to its kind. */
  outcome: Readonly<Record<string, "boolean" | "number">>;
  experimentBudget: number;
  /** Absent for Glow World's original description. */
  observationNoise?: "none" | "present";
}

export interface AnyObservation {
  step: number;
  inputs: Readonly<Record<string, number>>;
  outcome: Readonly<Record<string, boolean | number>>;
  remainingBudget: number;
}

export type AnyExperimentResult =
  | { ok: true; observation: AnyObservation }
  | { ok: false; error: { code: string; message: string } };

export interface AnyExperimentTools {
  describeWorld(): AnyWorldDescription;
  runExperiment(request: unknown): AnyExperimentResult;
  getObservationLog(): AnyObservation[];
  getRemainingBudget(): number;
}
