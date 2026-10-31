/**
 * Strict Zod schemas for the generic experiment tools, built from a world's
 * public spec. Unknown fields are rejected at every level.
 */
import { z } from "zod";
import type { WorldSpec } from "../worlds/world.js";
import { ErrorCodeSchema } from "./schemas.js";

export type WorldOutcomeValue = boolean | number;

export interface WorldDescription {
  worldId: string;
  attributes: Record<string, { min: number; max: number }>;
  outcome: Record<string, "boolean" | "number">;
  /** Says only whether observations are imprecise, never by how much. */
  observationNoise: "none" | "present";
  experimentBudget: number;
}

export interface WorldObservation {
  step: number;
  inputs: Record<string, number>;
  outcome: Record<string, WorldOutcomeValue>;
  remainingBudget: number;
}

export type WorldExperimentResult =
  | { ok: true; observation: WorldObservation }
  | { ok: false; error: { code: z.infer<typeof ErrorCodeSchema>; message: string } };

export interface WorldSchemas {
  input: z.ZodType<Record<string, number>>;
  observation: z.ZodType<WorldObservation>;
  result: z.ZodType<WorldExperimentResult>;
  description: z.ZodType<WorldDescription>;
}

export function createWorldSchemas(spec: WorldSpec): WorldSchemas {
  const inputShape: Record<string, z.ZodNumber> = {};
  const rangeShape: Record<string, z.ZodType<{ min: number; max: number }>> = {};
  for (const name of spec.attributeNames) {
    const range = spec.attributes[name]!;
    // z.number() already rejects NaN and Infinity in Zod 4.
    inputShape[name] = z.number().min(range.min).max(range.max);
    rangeShape[name] = z.strictObject({ min: z.literal(range.min), max: z.literal(range.max) });
  }

  const input = z.strictObject(inputShape) as unknown as z.ZodType<Record<string, number>>;
  const outcomeValue = spec.outcomeKind === "boolean" ? z.boolean() : z.number();
  const outcome = z.strictObject({ [spec.outcomeName]: outcomeValue });

  const observation = z.strictObject({
    step: z.number().int().positive(),
    inputs: input,
    outcome,
    remainingBudget: z.number().int().nonnegative(),
  }) as unknown as z.ZodType<WorldObservation>;

  const result = z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), observation }),
    z.strictObject({
      ok: z.literal(false),
      error: z.strictObject({ code: ErrorCodeSchema, message: z.string() }),
    }),
  ]) as unknown as z.ZodType<WorldExperimentResult>;

  const description = z.strictObject({
    worldId: z.literal(spec.worldId),
    attributes: z.strictObject(rangeShape),
    outcome: z.strictObject({ [spec.outcomeName]: z.literal(spec.outcomeKind) }),
    observationNoise: z.literal(spec.noisy ? "present" : "none"),
    experimentBudget: z.number().int().positive(),
  }) as unknown as z.ZodType<WorldDescription>;

  return { input, observation, result, description };
}
