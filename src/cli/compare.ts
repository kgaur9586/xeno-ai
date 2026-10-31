/**
 * Entry point for `npm run compare`. Always uses the scripted dummy provider.
 *
 * Without options it runs the original Glow World comparison. `--world <id>`
 * runs the noise-aware comparison on any registered world, and
 * `--noise-seed <n>` sets the private observation noise seed for it.
 */
import { pathToFileURL } from "node:url";
import { formatDiscoveryComparison, runDiscoveryComparison } from "../agents/discovery-comparison.js";
import { discoveryRunFileName, saveRunFile } from "../agents/discovery-run-log.js";
import { formatWorldComparison, runWorldComparison } from "../agents/world-comparison.js";
import { WORLD_IDS } from "../worlds/registry.js";

export const COMPARE_USAGE = `Usage: npm run compare -- [--world <${WORLD_IDS.join("|")}>] [--noise-seed <integer>]`;

export interface CompareArgs {
  worldId: string | undefined;
  noiseSeed: number | undefined;
}

export class CompareArgumentsError extends Error {
  constructor() {
    super(COMPARE_USAGE);
    this.name = "CompareArgumentsError";
  }
}

export function parseCompareArgs(argv: readonly string[]): CompareArgs {
  let worldId: string | undefined;
  let noiseSeed: number | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const raw = argv[index + 1];
    if (raw === undefined) {
      throw new CompareArgumentsError();
    }
    if (token === "--world" && worldId === undefined && WORLD_IDS.includes(raw)) {
      worldId = raw;
    } else if (token === "--noise-seed" && noiseSeed === undefined && /^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) {
      noiseSeed = Number(raw);
    } else {
      throw new CompareArgumentsError();
    }
  }
  if (noiseSeed !== undefined && worldId === undefined) {
    throw new CompareArgumentsError();
  }
  return { worldId, noiseSeed };
}

async function main(): Promise<void> {
  let args: CompareArgs;
  try {
    args = parseCompareArgs(process.argv.slice(2));
  } catch {
    process.stderr.write(`${COMPARE_USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  const savedAt = new Date();
  if (args.worldId === undefined) {
    const report = await runDiscoveryComparison();
    const savedTo = saveRunFile({
      directory: "runs",
      fileName: discoveryRunFileName(savedAt, "dummy", "comparison"),
      body: { savedAt: savedAt.toISOString(), report },
    });
    process.stdout.write(`${formatDiscoveryComparison(report)}\n\nSaved to ${savedTo}\n`);
    return;
  }

  const report = await runWorldComparison({ worldId: args.worldId, noiseSeed: args.noiseSeed });
  const savedTo = saveRunFile({
    directory: "runs",
    fileName: discoveryRunFileName(savedAt, "dummy", `${args.worldId}-comparison`),
    body: { savedAt: savedAt.toISOString(), report },
  });
  process.stdout.write(`${formatWorldComparison(report)}\n\nSaved to ${savedTo}\n`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
