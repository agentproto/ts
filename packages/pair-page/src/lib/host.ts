/**
 * Which daemon this origin serves, as the page and its service worker see it
 * (AIP-59 §5.8). No DOM-only imports: the worker uses it too.
 *
 * The rule is host-agnostic on purpose: an origin whose FIRST DNS label is a
 * daemon fingerprint belongs to that daemon, whatever the domain under it
 * (`<fp>.agentproto.cloud` in production, `<fp>.localhost` in a local test).
 * Which hosts are served at all is the edge Worker's call (src/edge.ts); it
 * answers 404 for anything that isn't a daemon origin or a configured preview
 * host, so any other host the page runs on is a preview.
 */

import type { CredentialStore, PairCredential } from "@agentproto/pair-client"
import { isPairingId } from "./pair"

export type PageMode =
  /** `<fingerprint>.<domain>`: this origin belongs to that one daemon. */
  | { kind: "daemon"; fingerprint: string }
  /** A preview host (workers.dev, localhost): every pairing made here shares
   *  the origin. For testing only; the page labels it. */
  | { kind: "preview" }

export function pageMode(hostname: string): PageMode {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".")
  const first = labels[0]
  // Case-insensitive, as §5.8 compares it (browsers already lowercase hosts).
  return labels.length >= 2 && isPairingId(first) ? { kind: "daemon", fingerprint: first } : { kind: "preview" }
}

/** The origin of daemon `fingerprint`'s own page, next to the current daemon
 *  origin: same scheme, domain and port, first label swapped. */
export function daemonOrigin(fingerprint: string, current: { protocol: string; hostname: string; port: string }): string {
  const rest = current.hostname.split(".").slice(1).join(".")
  return `${current.protocol}//${fingerprint}.${rest}${current.port ? `:${current.port}` : ""}`
}

export class ForeignDaemonError extends Error {
  readonly code = "foreign_daemon"
}

/**
 * On a daemon origin, a view of `store` that holds that daemon only (§5.8: the
 * page and its worker MUST NOT store or use a credential for any other
 * fingerprint). Other ids read as absent, and are never written. On a preview
 * host, `store` unchanged.
 */
export function scopeCredentialStore(store: CredentialStore, mode: PageMode): CredentialStore {
  if (mode.kind === "preview") return store
  const allowed = mode.fingerprint
  const mine = (c: PairCredential | undefined): c is PairCredential =>
    !!c && c.id === allowed && c.fingerprint === allowed
  return {
    async get(id) {
      const c = id === allowed ? await store.get(id) : undefined
      return mine(c) ? c : undefined
    },
    async put(credential) {
      const { fingerprint } = credential
      if (!mine(credential)) {
        throw new ForeignDaemonError(`this origin only holds the pairing for daemon ${allowed}, not ${fingerprint}`)
      }
      await store.put(credential)
    },
    async delete(id) {
      return id === allowed ? store.delete(id) : false
    },
    async list() {
      return (await store.list()).filter(mine)
    },
  }
}
