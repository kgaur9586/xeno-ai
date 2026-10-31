/**
 * Thin client for the XENO HTTP API.
 *
 * The operator token is passed per call and never stored by the client.
 * Errors carry only the server's fixed code and message.
 */
import type {
  AnyObservation,
  AnyWorldDescription,
  CreateSessionBody,
  OperatorSessionView,
  PublicSessionView,
  PublicWorld,
  StoredEvaluation,
  TranscriptEntry,
} from "./types.js";

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export interface StepResponse {
  turnsRun: number;
  session: PublicSessionView;
  entries: TranscriptEntry[];
}

export interface ApiClient {
  worlds(): Promise<PublicWorld[]>;
  listSessions(): Promise<PublicSessionView[]>;
  createSession(body: CreateSessionBody): Promise<PublicSessionView>;
  getSession(id: string): Promise<PublicSessionView>;
  deleteSession(id: string): Promise<void>;
  world(id: string): Promise<AnyWorldDescription>;
  observations(id: string): Promise<AnyObservation[]>;
  transcript(id: string): Promise<TranscriptEntry[]>;
  step(id: string, turns: number): Promise<StepResponse>;
  evaluate(id: string, token: string): Promise<StoredEvaluation>;
  operatorView(id: string, token: string): Promise<OperatorSessionView>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createApiClient(base = "", fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init)): ApiClient {
  async function request<T>(method: string, path: string, options: { body?: unknown; token?: string } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.token !== undefined) {
      headers.authorization = `Bearer ${options.token}`;
    }
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const json: unknown = text === "" ? null : JSON.parse(text);
    if (!response.ok) {
      const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiClientError(response.status, error?.code ?? "UNKNOWN", error?.message ?? "Request failed.");
    }
    return json as T;
  }

  const session = (id: string) => `/sessions/${encodeURIComponent(id)}`;

  return {
    worlds: async () => (await request<{ worlds: PublicWorld[] }>("GET", "/worlds")).worlds,
    listSessions: async () => (await request<{ sessions: PublicSessionView[] }>("GET", "/sessions")).sessions,
    createSession: async (body) =>
      (await request<{ session: PublicSessionView }>("POST", "/sessions", { body })).session,
    getSession: async (id) => (await request<{ session: PublicSessionView }>("GET", session(id))).session,
    deleteSession: async (id) => {
      await request<null>("DELETE", session(id));
    },
    world: async (id) => (await request<{ world: AnyWorldDescription }>("GET", `${session(id)}/world`)).world,
    observations: async (id) =>
      (await request<{ observations: AnyObservation[] }>("GET", `${session(id)}/observations`)).observations,
    transcript: async (id) =>
      (await request<{ entries: TranscriptEntry[] }>("GET", `${session(id)}/transcript`)).entries,
    step: (id, turns) => request<StepResponse>("POST", `${session(id)}/steps`, { body: { turns } }),
    evaluate: async (id, token) =>
      (
        await request<{ evaluation: StoredEvaluation }>("POST", `/evaluator${session(id)}/evaluations`, {
          body: {},
          token,
        })
      ).evaluation,
    operatorView: async (id, token) =>
      (await request<{ session: OperatorSessionView }>("GET", `/evaluator${session(id)}`, { token })).session,
  };
}
