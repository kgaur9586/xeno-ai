/** Response shapes, imported as types only so no server code reaches the bundle. */
export type { TranscriptEntry } from "../../src/agents/discovery-agent.js";
export type {
  OperatorSessionView,
  PublicSessionView,
  PublicTheory,
  StoredEvaluation,
} from "../../src/api/session-manager.js";
export type { AnyWorldReport } from "../../src/evaluator/world-evaluator.js";
export type { AnyObservation, AnyWorldDescription, PublicAttributeRange } from "../../src/tools/public-types.js";

import type { AnyWorldDescription } from "../../src/tools/public-types.js";

export type PublicWorld = Omit<AnyWorldDescription, "experimentBudget">;

export interface CreateSessionBody {
  worldId: string;
  budget?: number;
  maxModelTurns?: number;
  noiseSeed?: number;
}
