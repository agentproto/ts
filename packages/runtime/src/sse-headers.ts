/**
 * One set of response headers for every SSE route the daemon serves, so a
 * proxy-hardening change lands everywhere at once instead of drifting across
 * per-route copies.
 *
 * - `cache-control: no-cache, no-transform` — `no-transform` forbids an
 *   intermediary from compressing/rewriting the body (a gzip step buffers).
 * - `x-accel-buffering: no` — the nginx-family opt-out from response
 *   buffering, honoured by many reverse proxies.
 *
 * What these headers can NOT fix: a Cloudflare *quick* tunnel
 * (`*.trycloudflare.com`, the `quick` remote provider). Cloudflare documents
 * that quick tunnels do not support Server-Sent Events, and in practice the
 * edge holds the whole body of any streamed response until it ends — no
 * header, content-type or padding changes that. Clients reaching the daemon
 * through a quick tunnel have to fall back to polling
 * `GET /sessions/:id/events?since=`.
 */

import type { ServerResponse } from "node:http"

export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
})

/** `res.writeHead(200, …)` with the shared SSE headers plus any route extras. */
export function writeSseHead(
  res: ServerResponse,
  extra: Record<string, string> = {},
): void {
  res.writeHead(200, { ...SSE_HEADERS, ...extra })
}
