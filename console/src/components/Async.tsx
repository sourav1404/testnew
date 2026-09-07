import type { ReactNode } from "react";
import type { ApiError } from "../api/client.js";
import type { ResourceState } from "../hooks/useResource.js";

/**
 * One place where loading, empty, error and stale-but-readable are decided, so
 * every view gets the same four states instead of each one inventing its own
 * happy path plus a spinner.
 */
interface AsyncProps<T> {
  state: ResourceState<T>;
  /** Called with data. Return null to mean "this is empty". */
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  onRetry?: () => void;
  /** Shown while a background refetch runs over data already on screen. */
  revalidating?: boolean;
}

export function Async<T>({ state, children, empty, onRetry, revalidating }: AsyncProps<T>) {
  // An error while data is already on screen keeps the data and warns, rather
  // than blanking a table the operator was reading because one poll failed.
  const banner = state.status === "error"
    ? <ErrorBanner error={state.error} onRetry={onRetry} stale={state.data !== null} />
    : null;

  if (state.status === "loading") return <Skeleton />;

  const rendered = state.data === null ? null : children(state.data);
  const isEmpty = rendered === null
    || (Array.isArray(state.data) && state.data.length === 0);

  return (
    <>
      {banner}
      {revalidating ? <p className="revalidating" role="status">refreshing…</p> : null}
      {isEmpty ? (empty ?? <Empty />) : rendered}
    </>
  );
}

export function Skeleton() {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">Loading</span>
      {[0, 1, 2].map((i) => <div key={i} className="skeleton-row" />)}
    </div>
  );
}

export function Empty({ children }: { children?: ReactNode }) {
  return <p className="empty">{children ?? "Nothing here yet."}</p>;
}

export function ErrorBanner(
  { error, onRetry, stale }: { error: ApiError; onRetry?: () => void; stale?: boolean },
) {
  const detail = Object.entries(error.detail)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object");
  return (
    <div className="banner banner-error" role="alert" data-testid="error-banner">
      <div className="banner-head">
        <strong>{humanise(error.code)}</strong>
        <code className="status">{error.status || "network"}</code>
        {stale ? <span className="tag">showing last known data</span> : null}
      </div>
      {/* The server's own words. It knows why it refused; we do not paraphrase. */}
      <p>{error.message}</p>
      {detail.length > 0 ? (
        <dl className="detail">
          {detail.map(([k, v]) => (
            <div key={k}><dt>{humanise(k)}</dt><dd>{String(v)}</dd></div>
          ))}
        </dl>
      ) : null}
      {onRetry && error.retryable ? (
        <button type="button" onClick={onRetry}>Try again</button>
      ) : null}
    </div>
  );
}

export const humanise = (s: string): string =>
  s.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
