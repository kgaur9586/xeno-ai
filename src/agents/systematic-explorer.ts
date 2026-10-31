/**
 * Systematic Explorer: runs a factorial grid built from the public ranges.
 *
 * With the default of 3 levels, each attribute takes its minimum, midpoint,
 * and maximum, and every combination is tried once (3 x 3 x 3 = 27
 * experiments). The explorer stops when the grid is complete or the budget
 * runs out, whichever comes first.
 */
import type { AnyWorldDescription } from "../tools/public-types.js";
import type { AttributeRange, Experimenter } from "./experimenter.js";

export const DEFAULT_LEVELS_PER_ATTRIBUTE = 3;

export interface SystematicExplorerOptions {
  levelsPerAttribute?: number;
}

export type GridPoint<D extends AnyWorldDescription> = Record<keyof D["attributes"] & string, number>;

/**
 * Lists the grid in run order: the first attribute changes slowest, the last
 * fastest (for Glow World, `a` slowest and `c` fastest).
 */
export function planGrid<D extends AnyWorldDescription>(
  description: D,
  levelsPerAttribute: number = DEFAULT_LEVELS_PER_ATTRIBUTE,
): GridPoint<D>[] {
  assertValidLevelCount(levelsPerAttribute);
  const names = Object.keys(description.attributes);
  const levels = names.map((name) => evenlySpacedLevels(description.attributes[name]!, levelsPerAttribute));

  let plan: Array<Record<string, number>> = [{}];
  for (let index = 0; index < names.length; index++) {
    const next: Array<Record<string, number>> = [];
    for (const partial of plan) {
      for (const value of levels[index]!) {
        next.push({ ...partial, [names[index]!]: value });
      }
    }
    plan = next;
  }
  return plan as GridPoint<D>[];
}

export function createSystematicExplorer(options: SystematicExplorerOptions = {}): Experimenter {
  const levelsPerAttribute = options.levelsPerAttribute ?? DEFAULT_LEVELS_PER_ATTRIBUTE;
  assertValidLevelCount(levelsPerAttribute);

  return {
    name: "systematic-explorer",

    run({ description, tools }) {
      for (const inputs of planGrid(description, levelsPerAttribute)) {
        if (tools.getRemainingBudget() === 0) {
          return;
        }
        const result = tools.runExperiment(inputs);
        if (!result.ok) {
          return;
        }
      }
    },
  };
}

function evenlySpacedLevels(range: AttributeRange, count: number): number[] {
  const levels: number[] = [];
  for (let i = 0; i < count; i++) {
    levels.push(range.min + ((range.max - range.min) * i) / (count - 1));
  }
  // A zero-width range would otherwise repeat the same value.
  return [...new Set(levels)];
}

function assertValidLevelCount(levelsPerAttribute: number): void {
  if (!Number.isInteger(levelsPerAttribute) || levelsPerAttribute < 2) {
    throw new Error("Levels per attribute must be an integer of at least 2.");
  }
}
