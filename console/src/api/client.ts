const BASE = (import.meta.env?.VITE_API_BASE as string | undefined) ?? "http://localhost:3000";

/**
 * A failure the operator can act on. The Stage 2 API answers errors as
 * `{ error, message, ...detail }` -- the detail carries things like
 * `ordered` / `already_received` / `attempted` on an over-receipt, or `available`
 * on an insufficient-stock refusal. All of it is kept, because "Request failed"
 * would throw away the only part the operator needs.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when re-issuing the identical request could plausibly succeed. */
  get retryable(): boolean {
    return this.status >= 500 || this.code === "serialization_failure" || this.code === "deadlock";
  }
}

export interface RequestOptions {
  token: string;
  method?: "GET" | "POST";
  body?: unknown;
  /** Sent as Idempotency-Key. Every mutating call in this console supplies one. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  data: T;
  /** The backend sets Idempotent-Replay so the UI can say "already applied". */
  replayed: boolean;
}

export async function request<T>(path: string, opts: RequestOptions): Promise<ApiResponse<T>> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: opts.method ?? "GET",
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    // A dead API and a 500 are different problems and want different words.
    throw new ApiError(0, "network_unreachable",
      `cannot reach the API at ${BASE}. Is the Stage 2 backend running?`);
  }

  const text = await res.text();
  const parsed: unknown = text ? safeJson(text) : null;

  if (!res.ok) {
    const body = (parsed ?? {}) as Record<string, unknown>;
    const { error, message, ...detail } = body;
    throw new ApiError(
      res.status,
      typeof error === "string" ? error : `http_${res.status}`,
      typeof message === "string" ? message : res.statusText,
      detail,
    );
  }
  return { data: parsed as T, replayed: res.headers.get("idempotent-replay") === "true" };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch { return { error: "bad_response", message: text.slice(0, 200) }; }
}

/** Mutations get a fresh key per attempt of a distinct action, so a
 *  double-clicked button replays instead of receiving stock twice. */
export const newIdempotencyKey = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
