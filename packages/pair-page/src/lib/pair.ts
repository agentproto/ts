/**
 * Shared by the pages and the pairing service worker (src/sw.ts): keep it
 * free of DOM-only imports.
 *
 * Layout (AIP-59 §5): one service worker registration per paired daemon,
 * scoped to `/d/<id>/` where `<id>` is the daemon fingerprint (16 hex).
 * Everything under that scope is proxied to the daemon through the E2E
 * rendezvous tunnel, so the Control Center loads from the daemon itself at
 * `/d/<id>/apps/@agentik/session-chat/ui/`. `/d/<id>` (no trailing slash) is
 * outside the scope: it is this bundle's own status page.
 */

/** The bundled worker (scripts/build.mjs → dist/pair-sw.js). Served from the
 *  root, so its default max scope `/` covers every `/d/<id>/`. */
export const PAIR_SW_URL = "/pair-sw.js"

/** Daemon path of the Control Center UI. */
export const CONTROL_CENTER_PATH = "/apps/@agentik/session-chat/ui/"

/** A daemon identity fingerprint (`identityFingerprint`): the first 16 hex
 *  chars of sha256 over the daemon's X25519 public key, lowercase. */
export const FINGERPRINT_RE = /^[0-9a-f]{16}$/

export function isPairingId(id: string | undefined | null): id is string {
  return typeof id === "string" && FINGERPRINT_RE.test(id)
}

/** `/d/<id>/`: the worker scope, and the prefix it strips before a request
 *  goes to the daemon. */
export function pairingScope(id: string): string {
  return `/d/${id}/`
}

/** `/d/<id>`: the status page (outside the worker scope). */
export function statusPath(id: string): string {
  return `/d/${id}`
}

export function controlCenterUrl(id: string): string {
  return `/d/${id}${CONTROL_CENTER_PATH}`
}

/** Tunnel state as the worker reports it: the pair-client `ConnectionState`
 *  (`outdated` = the pairing predates the current pairing protocol), plus
 *  `not_paired` when no credential is stored for the scope. */
export type PairState = "connecting" | "open" | "offline" | "revoked" | "closed" | "not_paired" | "outdated"

/** The offer or the stored credential predates the current pairing protocol
 *  (pair-client's `protocol_outdated`, the daemon's `pairing_protocol_outdated`
 *  underneath): it can never work again, only a fresh pairing can. */
export function isOutdatedPairingError(err: unknown): boolean {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 4; depth++) {
    const { code, cause } = e as { code?: unknown; cause?: unknown }
    if (code === "protocol_outdated" || code === "pairing_protocol_outdated") return true
    e = cause
  }
  return false
}

/** Page → worker. */
export type PairWorkerRequest =
  | { type: "agentproto-pair:status" }
  | { type: "agentproto-pair:reconnect" }
  /** Drop the worker's client so the next request reconnects with the stored
   *  credential (sent after a re-pair replaced it). */
  | { type: "agentproto-pair:reset" }

/** Worker → page. */
export interface PairWorkerStatus {
  type: "agentproto-pair:state"
  id: string
  state: PairState
  daemonName?: string
  error?: { code: string; message: string }
}

export function isPairWorkerStatus(data: unknown): data is PairWorkerStatus {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "agentproto-pair:state"
  )
}
