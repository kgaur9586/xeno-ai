/**
 * The common contract for every experimenter (scripted now, LLM-based later).
 *
 * An experimenter sees only what a real agent may see: the public world
 * description and the agent-facing experiment tools. It never receives the
 * world engine, the hidden rule, or anything belonging to the evaluator.
 * The contract works for any world, not only Glow World.
 */
import type { AnyExperimentTools, AnyWorldDescription, PublicAttributeRange } from "../tools/public-types.js";

export interface ExperimenterContext {
  readonly description: AnyWorldDescription;
  readonly tools: AnyExperimentTools;
}

export interface Experimenter {
  readonly name: string;
  /** Runs experiments through `context.tools` until finished or out of budget. */
  run(context: ExperimenterContext): void;
}

export type AttributeRange = PublicAttributeRange;
