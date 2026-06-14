/**
 * Internal HTTP helpers — not part of the public API.
 *
 * Every network call in this package (discovery, the claim ceremony, token
 * refresh) must be bounded: a hung or slow server MUST NOT stall the CLI
 * indefinitely. `deadlineSignal` combines an optional caller `AbortSignal`
 * with a timeout into one signal to hand to `fetch`.
 *
 * Implemented with a plain `AbortController` + `setTimeout` rather than
 * `AbortSignal.any`/`AbortSignal.timeout` so it works on every runtime that
 * ships `fetch`, without assuming a specific Node minor.
 */

/** Default per-request timeout. Discovery and token calls are small JSON
 *  round-trips; 10s is generous without hanging an interactive CLI. */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000

/**
 * AIP-50 §Security: discovery and auth requests MUST use HTTPS, to defeat
 * MITM/TOCTOU on the `.well-known` and token endpoints. Loopback http is
 * allowed — it isn't network-exposed — so local development against a dev
 * server keeps working. Throws on any other insecure URL.
 */
export function assertSecureUrl(url: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`invalid URL: ${url}`)
  }
  if (u.protocol === "https:") return
  const host = u.hostname
  const isLoopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  if (u.protocol === "http:" && isLoopback) return
  throw new Error(
    `insecure URL '${url}' — AIP-50 requires HTTPS for discovery/auth ` +
      `(loopback http is allowed for local development).`,
  )
}

export interface DeadlineHandle {
  /** Signal to pass to `fetch(url, { signal })`. */
  signal: AbortSignal
  /** Cancel the timer + detach the outer listener once the request settles.
   *  ALWAYS call this in a `finally` to avoid a dangling timer/listener. */
  clear: () => void
}

/**
 * Build an `AbortSignal` that fires when EITHER the timeout elapses or the
 * caller's `outer` signal aborts.
 */
export function deadlineSignal(
  timeoutMs: number,
  outer?: AbortSignal,
): DeadlineHandle {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort(outer?.reason)

  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason)
    else outer.addEventListener("abort", onAbort, { once: true })
  }

  const timer = setTimeout(
    () => ctrl.abort(new Error(`request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  )
  // Don't let a pending timeout keep the process alive on its own.
  if (typeof timer !== "number") timer.unref()

  return {
    signal: ctrl.signal,
    clear: () => {
      clearTimeout(timer)
      outer?.removeEventListener("abort", onAbort)
    },
  }
}

/** `fetch` bounded by `deadlineSignal`. Merges any caller-supplied
 *  `init.signal` with the timeout. */
export async function fetchWithDeadline(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<Response> {
  const { signal, clear } = deadlineSignal(timeoutMs, init.signal ?? undefined)
  try {
    return await fetch(url, { ...init, signal })
  } finally {
    clear()
  }
}
