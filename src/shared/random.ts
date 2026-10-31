/**
 * Deterministic seeded random number generator (the "Mulberry32" algorithm).
 *
 * The same seed always produces the same sequence of numbers, which makes
 * evaluation cases reproducible. Not suitable for security purposes.
 */
export type RandomSource = () => number;

/** Returns a function that yields numbers in the range [0, 1). */
export function createSeededRandom(seed: number): RandomSource {
  if (!Number.isInteger(seed)) {
    throw new Error("Seed must be an integer.");
  }

  let state = seed >>> 0;

  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One draw from a standard normal distribution (mean 0, standard deviation 1)
 * using the Box-Muller transform. Consumes exactly two values from `random`.
 */
export function drawStandardNormal(random: RandomSource): number {
  // 1 - u keeps the logarithm's argument in (0, 1].
  const u1 = 1 - random();
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
