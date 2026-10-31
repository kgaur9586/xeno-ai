/**
 * Strict request schemas and fixed errors for the HTTP API.
 *
 * Every request body and query string is parsed with one of these schemas.
 * Unknown fields are rejected. Error responses use only the fixed codes and
 * messages below and never echo the request.
 */
import { z } from "zod";

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_TURNS_PER_REQUEST = 32;
export const MAX_SESSION_BUDGET = 500;
export const MAX_SESSION_TURNS = 200;
export const MAX_TIMEOUT_MS = 300_000;
export const MAX_CASE_COUNT = 10_000;

const seed = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

export const CreateSessionSchema = z.strictObject({
  worldId: z.string().min(1).max(64),
  provider: z.enum(["dummy", "gemini"]).default("dummy"),
  budget: z.number().int().min(1).max(MAX_SESSION_BUDGET).default(30),
  maxModelTurns: z.number().int().min(1).max(MAX_SESSION_TURNS).default(16),
  timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).default(60_000),
  maxRetries: z.number().int().min(0).max(5).default(2),
  /** Private. Stored with the session and never returned. */
  noiseSeed: seed.optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionSchema>;

export const RunStepsSchema = z.strictObject({
  turns: z.number().int().min(1).max(MAX_TURNS_PER_REQUEST).default(1),
});

export const TranscriptQuerySchema = z.strictObject({
  from: z
    .string()
    .regex(/^\d{1,6}$/)
    .transform(Number)
    .default(0),
});

export const EmptyQuerySchema = z.strictObject({});

export const EvaluateSchema = z
  .strictObject({
    inRangeSeed: seed.default(1),
    outOfRangeSeed: seed.default(2),
    caseCount: z.number().int().min(2).max(MAX_CASE_COUNT).default(200),
  })
  .refine((value) => value.caseCount % 2 === 0);

export const API_ERRORS = {
  INVALID_JSON: { status: 400, message: "Request body is not valid JSON." },
  INVALID_REQUEST: { status: 400, message: "Request does not match the endpoint schema." },
  UNKNOWN_WORLD: { status: 400, message: "Unknown world." },
  PROVIDER_UNAVAILABLE: { status: 400, message: "That provider is not enabled on this server." },
  UNAUTHORIZED: { status: 401, message: "Operator token required." },
  EVALUATOR_DISABLED: { status: 403, message: "Evaluator routes are disabled on this server." },
  NOT_FOUND: { status: 404, message: "Not found." },
  METHOD_NOT_ALLOWED: { status: 405, message: "Method not allowed." },
  SESSION_BUSY: { status: 409, message: "The session is already running a step." },
  SESSION_FINISHED: { status: 409, message: "The session has finished." },
  NO_THEORY: { status: 409, message: "The session has no submitted theory to evaluate." },
  SESSION_LIMIT: { status: 409, message: "Too many sessions. Delete one first." },
  BODY_TOO_LARGE: { status: 413, message: "Request body is too large." },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: "Request body must be application/json." },
  INTERNAL_ERROR: { status: 500, message: "Internal error." },
  SESSION_CORRUPT: { status: 500, message: "The stored session could not be restored." },
  STORAGE_UNAVAILABLE: { status: 503, message: "Session storage is unavailable." },
} as const;

export type ApiErrorCode = keyof typeof API_ERRORS;

export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode) {
    super(API_ERRORS[code].message);
    this.name = "ApiError";
  }
}
