/**
 * Entry point for `npm run serve`: starts the HTTP API on 127.0.0.1.
 *
 * The dummy provider is always available. Gemini is available only with
 * `--live` and both Gemini values set. Evaluator routes are enabled only when
 * XENO_OPERATOR_TOKEN is set. Sessions are kept in MongoDB when
 * XENO_MONGODB_URI is set (database XENO_MONGODB_DB, default `xeno`) and in
 * memory otherwise. The key, the token, and the URI are never printed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createApiServer } from "../api/app.js";
import { createSessionManager, type ProviderKind } from "../api/session-manager.js";
import { loadProjectEnv, readGeminiConfig } from "../llm/env.js";
import { createDummyProvider } from "../llm/dummy-provider.js";
import { createGeminiProviderFromEnv } from "../llm/gemini-provider.js";
import type { LlmProvider } from "../llm/provider.js";
import { createMongoSessionStore, DEFAULT_MONGODB_DATABASE } from "../storage/mongo-session-store.js";
import { createMemorySessionStore, type SessionStore } from "../storage/session-store.js";

export const SERVE_USAGE = "Usage: npm run serve -- [--port <1-65535>] [--live]";
export const DEFAULT_PORT = 3000;
export const DASHBOARD_DIRECTORY = "dist-web";

export interface ServeArgs {
  port: number;
  live: boolean;
}

export class ServeArgumentsError extends Error {
  constructor() {
    super(SERVE_USAGE);
    this.name = "ServeArgumentsError";
  }
}

export function parseServeArgs(argv: readonly string[]): ServeArgs {
  let port: number | undefined;
  let live = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--live" && !live) {
      live = true;
    } else if (token === "--port" && port === undefined) {
      const raw = argv[++index] ?? "";
      const parsed = Number(raw);
      if (!/^\d+$/.test(raw) || parsed < 1 || parsed > 65_535) {
        throw new ServeArgumentsError();
      }
      port = parsed;
    } else {
      throw new ServeArgumentsError();
    }
  }
  return { port: port ?? DEFAULT_PORT, live };
}

async function main(): Promise<void> {
  let args: ServeArgs;
  try {
    args = parseServeArgs(process.argv.slice(2));
  } catch {
    process.stderr.write(`${SERVE_USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  loadProjectEnv();
  const providers: Partial<Record<ProviderKind, () => LlmProvider>> = { dummy: createDummyProvider };
  const { apiKey, model } = readGeminiConfig(process.env);
  if (args.live) {
    if (apiKey === "" || model === "") {
      process.stderr.write("--live needs GEMINI_API_KEY and GEMINI_MODEL.\n");
      process.exitCode = 1;
      return;
    }
    providers.gemini = () => createGeminiProviderFromEnv(process.env);
  }
  const operatorToken = process.env.XENO_OPERATOR_TOKEN?.trim() ?? "";
  const mongoUri = process.env.XENO_MONGODB_URI?.trim() ?? "";
  let store: SessionStore;
  if (mongoUri === "") {
    store = createMemorySessionStore();
  } else {
    try {
      store = await createMongoSessionStore({
        uri: mongoUri,
        database: process.env.XENO_MONGODB_DB?.trim() || DEFAULT_MONGODB_DATABASE,
      });
    } catch {
      process.stderr.write("Could not connect to MongoDB (check XENO_MONGODB_URI).\n");
      process.exitCode = 1;
      return;
    }
  }
  const sessions = createSessionManager({
    providers,
    store,
    secrets: [apiKey, operatorToken, mongoUri].filter((value) => value !== ""),
  });
  const dashboardDirectory = existsSync(join(DASHBOARD_DIRECTORY, "index.html")) ? DASHBOARD_DIRECTORY : undefined;
  const server = createApiServer({
    sessions,
    operatorToken: operatorToken === "" ? undefined : operatorToken,
    dashboardDirectory,
  });
  server.listen(args.port, "127.0.0.1", () => {
    process.stdout.write(
      [
        `XENO API listening on http://127.0.0.1:${args.port}`,
        dashboardDirectory === undefined
          ? "Dashboard: not built (run npm run build:web)"
          : `Dashboard: http://127.0.0.1:${args.port}/dashboard/`,
        `Providers: ${Object.keys(providers).join(", ")}`,
        `Evaluator routes: ${operatorToken === "" ? "disabled (set XENO_OPERATOR_TOKEN)" : "enabled"}`,
        `Session storage: ${store.kind === "mongodb" ? "MongoDB" : "memory (set XENO_MONGODB_URI to persist)"}`,
      ].join("\n") + "\n",
    );
  });
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void main();
}
