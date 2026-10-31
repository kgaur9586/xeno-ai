/**
 * Runs one discovery session and saves a copy under runs/.
 *
 * Without `--live`, the scripted dummy provider is used and no network call is
 * made. `--live` reads GEMINI_API_KEY and GEMINI_MODEL from the environment or
 * from a local .env file. The key is never printed.
 *
 * Evaluation scores are printed for the operator after the provider has
 * finished. They are not part of the conversation that was sent to the provider.
 */
import { pathToFileURL } from "node:url";
import { discoveryRunFileName, saveRunFile } from "../agents/discovery-run-log.js";
import { runDiscoverySession, type DiscoverySessionResult } from "../agents/discovery-session.js";
import { loadProjectEnv, readGeminiConfig } from "../llm/env.js";
import { createDummyProvider } from "../llm/dummy-provider.js";
import { createGeminiProviderFromEnv } from "../llm/gemini-provider.js";
import { PROVIDER_ERROR_MESSAGES, ProviderConfigError, type LlmProvider } from "../llm/provider.js";

export const DUMMY_SESSION_NOTICE =
  "DUMMY DATA: the scripted dummy provider ran this session. No live model was called.";

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
  /** Live Gemini is opt-in. The default is the scripted dummy provider. */
  live: boolean;
}

export interface DiscoveryProviderChoice {
  provider: LlmProvider;
  liveModel: boolean;
  label: string;
}

/** Uses Gemini only when `live` is set and both environment values are present. */
export function resolveDiscoveryProvider(env: NodeJS.ProcessEnv, live: boolean): DiscoveryProviderChoice {
  if (!live) {
    return { provider: createDummyProvider(), liveModel: false, label: "dummy" };
  }
  const { apiKey, model } = readGeminiConfig(env);
  if (apiKey === "" || model === "") {
    throw new ProviderConfigError();
  }
  return {
    provider: createGeminiProviderFromEnv(env),
    liveModel: true,
    label: `gemini:${model}`,
  };
}

export function parseDiscoverArgs(argv: readonly string[]): DiscoverArguments {
  const values = new Map<IntegerOption, number>();
  let live = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--live") {
      if (live) {
        throw new DiscoverArgumentsError();
      }
      live = true;
      continue;
    }
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
    live,
  };
}

async function main(): Promise<void> {
  try {
    loadProjectEnv();
    const args = parseDiscoverArgs(process.argv.slice(2));
    const choice = resolveDiscoveryProvider(process.env, args.live);
    const apiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
    const secrets = apiKey === "" ? [] : [apiKey];
    const result = await runDiscoverySession({
      provider: choice.provider,
      budget: args.budget,
      maxModelTurns: args.maxModelTurns,
      timeoutMs: args.timeoutMs,
      maxRetries: args.maxRetries,
      secrets,
      evaluation: {
        inRangeSeed: args.inRangeSeed,
        outOfRangeSeed: args.outOfRangeSeed,
        caseCount: args.caseCount,
      },
    });
    const savedAt = new Date();
    const savedTo = saveRunFile({
      directory: "runs",
      fileName: discoveryRunFileName(savedAt, choice.liveModel ? "gemini" : "dummy", result.status),
      secrets,
      body: {
        savedAt: savedAt.toISOString(),
        provider: choice.label,
        liveModel: choice.liveModel,
        result,
      },
    });
    if (!choice.liveModel) {
      process.stderr.write(`${DUMMY_SESSION_NOTICE}\n`);
    }
    process.stdout.write(
      `${JSON.stringify({ savedTo, provider: choice.label, liveModel: choice.liveModel, ...operatorReport(result) }, null, 2)}\n`,
    );
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
