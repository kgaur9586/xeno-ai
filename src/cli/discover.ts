/**
 * Runs one real discovery session.
 *
 * Reads GEMINI_API_KEY and GEMINI_MODEL from the environment, or from a local
 * .env file if those variables are unset. The key is never printed.
 *
 * Evaluation scores are printed for the operator after the model has finished.
 * They are not part of the conversation that was sent to the model.
 */
import { pathToFileURL } from "node:url";
import { runDiscoverySession, type DiscoverySessionResult } from "../agents/discovery-session.js";
import { loadProjectEnv } from "../llm/env.js";
import { createGeminiProviderFromEnv } from "../llm/gemini-provider.js";
import { PROVIDER_ERROR_MESSAGES, ProviderConfigError } from "../llm/provider.js";

const INTEGER_OPTIONS = {
  "--budget": { fallback: 30, minimum: 1 },
  "--max-turns": { fallback: 16, minimum: 1 },
  "--timeout-ms": { fallback: 60_000, minimum: 1 },
  "--retries": { fallback: 2, minimum: 0 },
  "--in-range-seed": { fallback: 1, minimum: Number.MIN_SAFE_INTEGER },
  "--out-of-range-seed": { fallback: 2, minimum: Number.MIN_SAFE_INTEGER },
  "--case-count": { fallback: 200, minimum: 2 },
} as const;

type IntegerOption = keyof typeof INTEGER_OPTIONS;

export class DiscoverArgumentsError extends Error {
  constructor() {
    super("Invalid command arguments.");
    this.name = "DiscoverArgumentsError";
  }
}

export interface DiscoverArguments {
  budget: number;
  maxModelTurns: number;
  timeoutMs: number;
  maxRetries: number;
  inRangeSeed: number;
  outOfRangeSeed: number;
  caseCount: number;
}

export function parseDiscoverArgs(argv: readonly string[]): DiscoverArguments {
  const values = new Map<IntegerOption, number>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined || !isIntegerOption(token)) {
      throw new DiscoverArgumentsError();
    }
    const raw = argv[index + 1];
    if (raw === undefined || isIntegerOption(raw)) {
      throw new DiscoverArgumentsError();
    }
    const spec = INTEGER_OPTIONS[token];
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < spec.minimum) {
      throw new DiscoverArgumentsError();
    }
    if (token === "--case-count" && parsed % 2 !== 0) {
      throw new DiscoverArgumentsError();
    }
    values.set(token, parsed);
    index++;
  }

  return {
    budget: values.get("--budget") ?? INTEGER_OPTIONS["--budget"].fallback,
    maxModelTurns: values.get("--max-turns") ?? INTEGER_OPTIONS["--max-turns"].fallback,
    timeoutMs: values.get("--timeout-ms") ?? INTEGER_OPTIONS["--timeout-ms"].fallback,
    maxRetries: values.get("--retries") ?? INTEGER_OPTIONS["--retries"].fallback,
    inRangeSeed: values.get("--in-range-seed") ?? INTEGER_OPTIONS["--in-range-seed"].fallback,
    outOfRangeSeed: values.get("--out-of-range-seed") ?? INTEGER_OPTIONS["--out-of-range-seed"].fallback,
    caseCount: values.get("--case-count") ?? INTEGER_OPTIONS["--case-count"].fallback,
  };
}

async function main(): Promise<void> {
  try {
    loadProjectEnv();
    const args = parseDiscoverArgs(process.argv.slice(2));
    const apiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
    const provider = createGeminiProviderFromEnv();
    const result = await runDiscoverySession({
      provider,
      budget: args.budget,
      maxModelTurns: args.maxModelTurns,
      timeoutMs: args.timeoutMs,
      maxRetries: args.maxRetries,
      secrets: apiKey === "" ? [] : [apiKey],
      evaluation: {
        inRangeSeed: args.inRangeSeed,
        outOfRangeSeed: args.outOfRangeSeed,
        caseCount: args.caseCount,
      },
    });
    process.stdout.write(`${JSON.stringify(operatorReport(result), null, 2)}\n`);
  } catch (error) {
    if (error instanceof ProviderConfigError || error instanceof DiscoverArgumentsError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${PROVIDER_ERROR_MESSAGES.PROVIDER_FAILURE}\n`);
    }
    process.exitCode = 1;
  }
}

function operatorReport(result: DiscoverySessionResult): DiscoverySessionResult {
  return {
    status: result.status,
    modelTurns: result.modelTurns,
    experimentCount: result.experimentCount,
    remainingBudget: result.remainingBudget,
    submittedTheory: result.submittedTheory,
    theoryId: result.theoryId,
    evaluation: result.evaluation,
    evaluationOptions: result.evaluationOptions,
    providerDiagnostic: result.providerDiagnostic,
    transcript: result.transcript,
  };
}

function isIntegerOption(token: string): token is IntegerOption {
  return Object.hasOwn(INTEGER_OPTIONS, token);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
