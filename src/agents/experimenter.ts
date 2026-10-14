/**
 * The common contract for every experimenter (scripted now, LLM-based later).
 *
 * An experimenter sees only what a real agent may see: the public world
 * description and the agent-facing experiment tools. It never receives the
 * world engine, the hidden rule, or anything belonging to the evaluator.
 */
import type { ExperimentTools } from "../tools/experiment-tools.js";
import type { PublicDescription } from "../tools/schemas.js";

export interface ExperimenterContext {
  readonly description: PublicDescription;
  readonly tools: ExperimentTools;
}

export interface Experimenter {
  readonly name: string;
  /** Runs experiments through `context.tools` until finished or out of budget. */
  run(context: ExperimenterContext): void;
}

export type AttributeRange = PublicDescription["attributes"]["a"];
