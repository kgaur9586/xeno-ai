/**
 * Random Explorer: picks every attribute uniformly at random within its
 * public range. A fixed seed reproduces the same sequence of experiments.
 */
import { createSeededRandom, type RandomSource } from "../shared/random.js";
import type { AttributeRange, Experimenter } from "./experimenter.js";

export interface RandomExplorerOptions {
  seed: number;
}

export function createRandomExplorer(options: RandomExplorerOptions): Experimenter {
  const { seed } = options;
  if (!Number.isInteger(seed)) {
    throw new Error("Seed must be an integer.");
  }

  return {
    name: "random-explorer",

    run({ description, tools }) {
      // A fresh generator per run, so running the same explorer twice repeats its choices.
      const random = createSeededRandom(seed);
      const { a, b, c } = description.attributes;

      while (tools.getRemainingBudget() > 0) {
        const result = tools.runExperiment({
          a: drawWithin(random, a),
          b: drawWithin(random, b),
          c: drawWithin(random, c),
        });
        // Stop on any refusal instead of retrying, so a misbehaving tool cannot cause an endless loop.
        if (!result.ok) {
          return;
        }
      }
    },
  };
}

function drawWithin(random: RandomSource, range: AttributeRange): number {
  return range.min + random() * (range.max - range.min);
}
