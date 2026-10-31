/**
 * HTTP API for discovery sessions, built on `node:http` only.
 *
 * Investigation routes (everything outside `/evaluator/`) return only what an
 * agent could see or produce. Evaluator routes live under `/evaluator/`, need
 * the operator token as a bearer token, and are disabled when no token is
 * configured. They are the only routes that return scores, noise seeds, or
 * evaluation options.
 *
 * Every body and query string is validated with a strict Zod schema. Errors
 * use fixed codes and messages and never echo the request.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import type { z } from "zod";
import {
  API_ERRORS,
  ApiError,
  CreateSessionSchema,
  EmptyQuerySchema,
  EvaluateSchema,
  MAX_BODY_BYTES,
  RunStepsSchema,
  TranscriptQuerySchema,
  type ApiErrorCode,
} from "./schemas.js";
import type { SessionManager } from "./session-manager.js";

export interface ApiOptions {
  sessions: SessionManager;
  /** Enables the evaluator routes. Never returned or logged. */
  operatorToken?: string;
  /** Built dashboard (`dist-web`). When set, it is served under `/dashboard/`. */
  dashboardDirectory?: string;
}

const DASHBOARD_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const DASHBOARD_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

type Method = "GET" | "POST" | "DELETE";

interface RouteContext {
  params: string[];
  query: URLSearchParams;
  body: unknown;
}

interface Route {
  method: Method;
  pattern: RegExp;
  evaluatorOnly: boolean;
  handle(context: RouteContext): Promise<{ status: number; body?: unknown }> | { status: number; body?: unknown };
}

const SESSION_ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

export function createApiHandler(options: ApiOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const { sessions } = options;
  const tokenDigest = options.operatorToken ? digest(options.operatorToken) : null;

  const routes: Route[] = [
    publicRoute("GET", /^\/health$/, async ({ query }) => {
      parse(EmptyQuerySchema, queryObject(query));
      return { status: 200, body: { ok: true } };
    }),
    publicRoute("GET", /^\/worlds$/, async ({ query }) => {
      parse(EmptyQuerySchema, queryObject(query));
      return { status: 200, body: { worlds: sessions.worldIds().map((id) => sessions.publicWorld(id)) } };
    }),
    publicRoute("GET", /^\/sessions$/, async ({ query }) => {
      parse(EmptyQuerySchema, queryObject(query));
      return { status: 200, body: { sessions: await sessions.list() } };
    }),
    publicRoute("POST", /^\/sessions$/, async ({ query, body }) => {
      parse(EmptyQuerySchema, queryObject(query));
      return { status: 201, body: { session: await sessions.create(parse(CreateSessionSchema, body ?? {})) } };
    }),
    publicRoute("GET", new RegExp(`^/sessions/${SESSION_ID}$`), async ({ params, query }) => {
      parse(EmptyQuerySchema, queryObject(query));
      return { status: 200, body: { session: await sessions.view(params[0]!) } };
    }),
    publicRoute("DELETE", new RegExp(`^/sessions/${SESSION_ID}$`), async ({ params, query }) => {
      parse(EmptyQuerySchema, queryObject(query));
      await sessions.remove(params[0]!);
      return { status: 204 };
    }),
    publicRoute("GET", new RegExp(`^/sessions/${SESSION_ID}/world$`), async ({ params, query }) => {
      parse(EmptyQuerySchema, queryObject(query));
      return { status: 200, body: { world: await sessions.world(params[0]!) } };
    }),
    publicRoute("GET", new RegExp(`^/sessions/${SESSION_ID}/observations$`), async ({ params, query }) => {
      parse(EmptyQuerySchema, queryObject(query));
      return { status: 200, body: { observations: await sessions.observations(params[0]!) } };
    }),
    publicRoute("GET", new RegExp(`^/sessions/${SESSION_ID}/transcript$`), async ({ params, query }) => {
      const { from } = parse(TranscriptQuerySchema, queryObject(query));
      return { status: 200, body: await sessions.transcript(params[0]!, from) };
    }),
    publicRoute("POST", new RegExp(`^/sessions/${SESSION_ID}/steps$`), async ({ params, query, body }) => {
      parse(EmptyQuerySchema, queryObject(query));
      const { turns } = parse(RunStepsSchema, body ?? {});
      return { status: 200, body: await sessions.step(params[0]!, turns) };
    }),
    evaluatorRoute("POST", new RegExp(`^/evaluator/sessions/${SESSION_ID}/evaluations$`), async ({ params, query, body }) => {
      parse(EmptyQuerySchema, queryObject(query));
      const evaluation = parse(EvaluateSchema, body ?? {});
      return { status: 201, body: { evaluation: await sessions.evaluate(params[0]!, evaluation) } };
    }),
    evaluatorRoute("GET", new RegExp(`^/evaluator/sessions/${SESSION_ID}$`), async ({ params, query }) => {
      parse(EmptyQuerySchema, queryObject(query));
      return { status: 200, body: { session: await sessions.operatorView(params[0]!) } };
    }),
  ];

  function authorize(request: IncomingMessage): void {
    if (tokenDigest === null) {
      throw new ApiError("EVALUATOR_DISABLED");
    }
    const header = request.headers.authorization ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (match === null || !timingSafeEqual(digest(match[1]!), tokenDigest)) {
      throw new ApiError("UNAUTHORIZED");
    }
  }

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (options.dashboardDirectory !== undefined && /^\/dashboard(\/|$)/.test(url.pathname)) {
      serveDashboard(options.dashboardDirectory, url.pathname, request, response);
      return;
    }
    const matching = routes
      .map((route) => ({ route, match: route.pattern.exec(url.pathname) }))
      .filter((entry): entry is { route: Route; match: RegExpExecArray } => entry.match !== null);
    if (matching.length === 0) {
      if (url.pathname.startsWith("/evaluator/")) {
        authorize(request);
      }
      throw new ApiError("NOT_FOUND");
    }
    const entry = matching.find(({ route }) => route.method === request.method);
    if (matching[0]!.route.evaluatorOnly) {
      authorize(request);
    }
    if (entry === undefined) {
      response.setHeader("allow", [...new Set(matching.map(({ route }) => route.method))].join(", "));
      throw new ApiError("METHOD_NOT_ALLOWED");
    }
    const body = request.method === "POST" ? await readJsonBody(request) : await discardBody(request);
    const result = await entry.route.handle({ params: entry.match.slice(1), query: url.searchParams, body });
    send(response, result.status, result.body);
  }

  return (request, response) => {
    dispatch(request, response).catch((error: unknown) => {
      const code: ApiErrorCode =
        error instanceof ApiError ? error.code : isStorageError(error) ? "STORAGE_UNAVAILABLE" : "INTERNAL_ERROR";
      if (!response.headersSent) {
        send(response, API_ERRORS[code].status, { error: { code, message: API_ERRORS[code].message } });
      } else {
        response.end();
      }
    });
  };
}

/** Driver errors carry connection details, so only their class is inspected. */
function isStorageError(error: unknown): boolean {
  return error instanceof Error && /^Mongo/.test(error.name);
}

export function createApiServer(options: ApiOptions): Server {
  const server = createServer(createApiHandler(options));
  server.requestTimeout = 15 * 60 * 1000;
  return server;
}

/**
 * Serves `index.html` and flat files under `assets/`. File names are limited
 * to a safe character set, so a path can never leave the directory.
 */
function serveDashboard(directory: string, pathname: string, request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    throw new ApiError("METHOD_NOT_ALLOWED");
  }
  if (pathname === "/dashboard") {
    response.statusCode = 301;
    response.setHeader("location", "/dashboard/");
    response.end();
    return;
  }
  const asset = /^\/dashboard\/assets\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,127})$/.exec(pathname);
  const relative = pathname === "/dashboard/" ? "index.html" : asset ? join("assets", asset[1]!) : null;
  const type = relative === null ? undefined : DASHBOARD_TYPES[extname(relative)];
  if (relative === null || type === undefined) {
    throw new ApiError("NOT_FOUND");
  }
  let content: Buffer;
  try {
    content = readFileSync(join(directory, relative));
  } catch {
    throw new ApiError("NOT_FOUND");
  }
  response.statusCode = 200;
  response.setHeader("content-type", type);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-security-policy", DASHBOARD_POLICY);
  response.setHeader("cache-control", relative === "index.html" ? "no-store" : "public, max-age=31536000, immutable");
  response.end(request.method === "HEAD" ? undefined : content);
}

function publicRoute(method: Method, pattern: RegExp, handle: Route["handle"]): Route {
  return { method, pattern, evaluatorOnly: false, handle };
}

function evaluatorRoute(method: Method, pattern: RegExp, handle: Route["handle"]): Route {
  return { method, pattern, evaluatorOnly: true, handle };
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError("INVALID_REQUEST");
  }
  return result.data;
}

function queryObject(query: URLSearchParams): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const [key, value] of query) {
    if (Object.hasOwn(result, key)) {
      return null;
    }
    result[key] = value;
  }
  return result;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const text = await readBody(request);
  if (text.length === 0) {
    return undefined;
  }
  const type = request.headers["content-type"] ?? "";
  if (!/^application\/json(\s*;.*)?$/i.test(type)) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("INVALID_JSON");
  }
}

async function discardBody(request: IncomingMessage): Promise<undefined> {
  const text = await readBody(request);
  if (text.length > 0) {
    throw new ApiError("INVALID_REQUEST");
  }
  return undefined;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"] ?? "0");
    if (declared > MAX_BODY_BYTES) {
      request.resume();
      reject(new ApiError("BODY_TOO_LARGE"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        if (!rejected) {
          rejected = true;
          reject(new ApiError("BODY_TOO_LARGE"));
        }
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    request.on("error", () => {
      if (!rejected) {
        rejected = true;
        reject(new ApiError("INVALID_REQUEST"));
      }
    });
  });
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (body === undefined) {
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
