/**
 * Strict Zod schemas for everything that crosses the agent boundary.
 *
 * "Strict" means unknown fields are rejected instead of silently ignored, so
 * nothing extra can slip into a request or a response.
 */
import { z } from "zod";
import { ATTRIBUTE_MAX, ATTRIBUTE_MIN, GLOW_WORLD_ID } from "../worlds/glow-world.js";

// z.number() already rejects NaN and Infinity in Zod 4.
const attributeValue = z.number().min(ATTRIBUTE_MIN).max(ATTRIBUTE_MAX);

export const ExperimentInputSchema = z.strictObject({
  a: attributeValue,
  b: attributeValue,
  c: attributeValue,
});

export const OutcomeSchema = z.strictObject({
  glows: z.boolean(),
});

export const ObservationSchema = z.strictObject({
  step: z.number().int().positive(),
  inputs: ExperimentInputSchema,
  outcome: OutcomeSchema,
  remainingBudget: z.number().int().nonnegative(),
});

export const ERROR_MESSAGES = {
  INVALID_INPUT: "Experiment inputs are invalid.",
  BUDGET_EXHAUSTED: "No experiments remain in the budget.",
} as const;

export const ErrorCodeSchema = z.enum(["INVALID_INPUT", "BUDGET_EXHAUSTED"]);

export const ExperimentSuccessSchema = z.strictObject({
  ok: z.literal(true),
  observation: ObservationSchema,
});

export const ExperimentErrorSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string(),
  }),
});

export const ExperimentResultSchema = z.discriminatedUnion("ok", [
  ExperimentSuccessSchema,
  ExperimentErrorSchema,
]);

const AttributeRangeSchema = z.strictObject({
  min: z.number(),
  max: z.number(),
});

export const PublicDescriptionSchema = z.strictObject({
  worldId: z.literal(GLOW_WORLD_ID),
  attributes: z.strictObject({
    a: AttributeRangeSchema,
    b: AttributeRangeSchema,
    c: AttributeRangeSchema,
  }),
  outcome: z.strictObject({
    glows: z.literal("boolean"),
  }),
  experimentBudget: z.number().int().positive(),
});

export type ExperimentInput = z.infer<typeof ExperimentInputSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ExperimentSuccess = z.infer<typeof ExperimentSuccessSchema>;
export type ExperimentError = z.infer<typeof ExperimentErrorSchema>;
export type ExperimentResult = z.infer<typeof ExperimentResultSchema>;
export type PublicDescription = z.infer<typeof PublicDescriptionSchema>;
