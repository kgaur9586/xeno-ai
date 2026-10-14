/**
 * Systematic Explorer: runs a factorial grid built from the public ranges.
 *
 * With the default of 3 levels, each attribute takes its minimum, midpoint,
 * and maximum, and every combination is tried once (3 x 3 x 3 = 27
 * experiments). The explorer stops when the grid is complete or the budget
 * runs out, whichever comes first.
 */
import type { ExperimentInput, PublicDescription } from "../tools/schemas.js";
import type { AttributeRange, Experimenter } from "./experimenter.js";

export const DEFAULT_LEVELS_PER_ATTRIBUTE = 3;

export interface SystematicExplorerOptions {
  levelsPerAttribute?: number;
}

/** Lists the grid in run order: `a` changes slowest, `c` fastest. */
export function planGrid(
  description: PublicDescription,
  levelsPerAttribute: number = DEFAULT_LEVELS_PER_ATTRIBUTE,
): ExperimentInput[] {
  assertValidLevelCount(levelsPerAttribute);
  const { a, b, c } = description.attributes;
  const aLevels = evenlySpacedLevels(a, levelsPerAttribute);
  const bLevels = evenlySpacedLevels(b, levelsPerAttribute);
  const cLevels = evenlySpacedLevels(c, levelsPerAttribute);

  const plan: ExperimentInput[] = [];
  for (const aValue of aLevels) {
    for (const bValue of bLevels) {
      for (const cValue of cLevels) {
        plan.push({ a: aValue, b: bValue, c: cValue });
      }
    }
  }
  return plan;
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
