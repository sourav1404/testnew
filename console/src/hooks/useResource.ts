import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "../api/client.js";

export type ResourceState<T> =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: T; error: null }
  | { status: "error"; data: T | null; error: ApiError };

export interface Resource<T> extends Record<string, unknown> {
  state: ResourceState<T>;
  /** Refetch now. Returned so a mutation can pull the truth back immediately. */
  reload: () => Promise<void>;
  /** True while a background refetch is in flight over already-rendered data. */
  revalidating: boolean;
}

export interface UseResourceOptions {
  /** Poll interval in ms. 0 disables polling. */
  pollMs?: number;
  /** Skip fetching entirely, e.g. when the actor lacks the permission. */
  enabled?: boolean;
}

/**
 * Server state, deliberately without a cache.
 *
 * The brief requires that "a fresh page load reflects true current backend
 * state, not cached/optimistic-only data", and that availability at sales-order
 * time is "live, not stale". A normalised client cache would fight both: it
 * would happily serve a figure another session has already invalidated.
 *
 * So the rules here are:
 *  - every mount fetches;
 *  - a mutation calls reload() rather than patching local state;
 *  - the window regaining focus revalidates, because the operator has probably
 *    been looking at another tab or another session;
 *  - contended views poll, because nobody watches a screen and presses refresh.
 *
 * The cost is more requests. That is the right trade for a screen whose whole
 * job is to tell an operator whether stock is actually there.
 */
export function useResource<T>(
  path: string | null,
  token: string,
  opts: UseResourceOptions = {},
): Resource<T> {
  const { pollMs = 0, enabled = true } = opts;
  const [state, setState] = useState<ResourceState<T>>({ status: "loading", data: null, error: null });
  const [revalidating, setRevalidating] = useState(false);
  // Held in a ref so reload() is stable and effects do not re-run on each render.
  const latest = useRef<{ path: string | null; token: string }>({ path, token });
  latest.current = { path, token };
  const inFlight = useRef<AbortController | null>(null);

  const fetchNow = useCallback(async (background: boolean) => {
    const { path: p, token: t } = latest.current;
    if (!p) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    if (background) setRevalidating(true);
    try {
      const { data } = await request<T>(p, { token: t, signal: controller.signal });
      setState({ status: "ready", data, error: null });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const apiError = err instanceof ApiError
        ? err
        : new ApiError(0, "unknown", err instanceof Error ? err.message : String(err));
      // Keep whatever was on screen and mark it stale, rather than blanking a
      // table the operator was reading because one poll failed.
      setState((prev) => ({ status: "error", data: prev.data, error: apiError }));
    } finally {
      if (background) setRevalidating(false);
    }
  }, []);

  const reload = useCallback(() => fetchNow(true), [fetchNow]);

  useEffect(() => {
    if (!enabled || !path) {
      setState({ status: "ready", data: null as T, error: null });
      return;
    }
    setState({ status: "loading", data: null, error: null });
    void fetchNow(false);
    return () => inFlight.current?.abort();
  }, [path, token, enabled, fetchNow]);

  useEffect(() => {
    if (!enabled || !path || pollMs <= 0) return;
    const id = window.setInterval(() => void fetchNow(true), pollMs);
    return () => window.clearInterval(id);
  }, [enabled, path, pollMs, fetchNow]);

  useEffect(() => {
    if (!enabled || !path) return;
    const onFocus = () => void fetchNow(true);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, path, fetchNow]);

  return { state, reload, revalidating };
}
