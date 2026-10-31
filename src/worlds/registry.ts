/** The worlds XENO knows about, by id. Trusted code only. */
import { DRIFT_WORLD } from "./drift-world.js";
import { GLOW_WORLD } from "./glow-world.js";
import { RING_WORLD } from "./ring-world.js";
import type { World } from "./world.js";

export const WORLDS: readonly World[] = Object.freeze([GLOW_WORLD, RING_WORLD, DRIFT_WORLD]);

export const WORLD_IDS: readonly string[] = Object.freeze(WORLDS.map((world) => world.spec.worldId));

export function getWorld(worldId: string): World | undefined {
  return WORLDS.find((world) => world.spec.worldId === worldId);
}
