/**
 * Device registry — a read view over `PairingRegistry` (+, when wired,
 * `HostRegistry`) that presents each pairing/host as a "device" (DEVICES-PLAN
 * PR-A, hosts added PR-C). A paired CLIENT (today's `pair_offer`/`pair
 * accept`) gets `role: "client"`; a registered HOST (`pair offer --host` +
 * `devices add`, host-registry.ts) gets `role: "host"`.
 *
 * This is deliberately a thin computed view, not a second store: renaming
 * and revoking a client device mutate the same `pairings.json`
 * `PairingRegistry` already owns; a host device mutates the same
 * `hosts.json` `HostRegistry` — so `pair_*`/`/pairings` and
 * `device_*`/`/devices` are two surfaces over the same two sources of truth.
 */

import type { PairingRegistry, PairingRecord } from "./pairing-registry.js"
import { isSessionsPath, type HostRegistry, type HostRecord, type ForwardHttpRequest, type ForwardHttpResponse } from "./host-registry.js"

export type DeviceRole = "client" | "host"
export type DeviceKind = "browser" | "cli" | "daemon"

export interface Device {
  fingerprint: string
  name: string
  role: DeviceRole
  kind: DeviceKind
  rendezvous: string
  createdAt: string
  lastSeen: string
  /** A channel (offer or reconnect) is served for this device right now
   *  (client), or for a host: a forward/snapshot is in flight or one reached
   *  it within the online grace window (a background poll keeps that fresh
   *  for joined hosts) — see host-registry.ts's "Online tracking". */
  online: boolean
  /** A pair/v1 pairing: listed and revocable, but can't connect until
   *  re-paired — see `PairingRecord.legacy`. */
  legacy?: true
  /** Set when this device's pairing/host record was granted under a
   *  HOST-scoped offer (`agentproto pair offer --host`) — see
   *  offer-url.ts's "Offer scope". Surfaced from either side of a pairing so
   *  a user can see, from EITHER daemon, which of their pairings/hosts grant
   *  host control. */
  scope?: "host"
  /** Self-reported by a host at join time (SANDBOX-VISIBILITY-JOIN) — see
   *  `HostRecord.provider`/`sandboxId`/`labels`. Absent for a client device. */
  provider?: string
  sandboxId?: string
  labels?: Record<string, string>
  /** Host only: when this daemon last tried to reach it, and why the most
   *  recent attempt failed (absent when the last attempt succeeded). */
  lastProbeAt?: string
  lastError?: string
  /** Host only: a join-added (CI) host that is gone — said goodbye or was
   *  unreachable past the TTL. Hidden from `list()` unless `includeEnded`. */
  ended?: true
  endedAt?: string
  /** Host only: a manually added host unreachable past the TTL. Still listed,
   *  never auto-deleted. */
  stale?: true
}

export interface ListDevicesOptions {
  /** Include ended (gone) join-added hosts, which `list()` hides by default. */
  includeEnded?: boolean
}

export interface DeviceRegistry {
  /** Every known device, minus ended join-added hosts unless
   *  `includeEnded`. Read-only. */
  list(opts?: ListDevicesOptions): Promise<Device[]>
  /** Rename a device (fingerprint or current name) to a new label. Tries the
   *  pairing registry first, then the host registry. Returns false when
   *  nothing matched. */
  rename(idOrName: string, newName: string): Promise<boolean>
  /** Drop a device by fingerprint or name — same effect as `pair revoke` for
   *  a client device, `devices revoke`-of-a-host for a host device. Tries
   *  the pairing registry first, then the host registry. Returns false when
   *  nothing matched. */
  revoke(idOrName: string): Promise<boolean>
  /** Register a host from an offer URL (delegates to `HostRegistry.add`).
   *  Rejects if no `HostRegistry` was wired into this device registry. */
  add(offerUrl: string, name?: string): Promise<{ fingerprint: string; name: string; rendezvousUrl: string }>
  /**
   * Forward one HTTP request to a HOST device on demand (delegates to
   * `HostRegistry.forwardHttp`) — the basis for `device_sessions`. Rejects
   * if no `HostRegistry` was wired, or if `idOrName` doesn't match a host.
   *
   * For a GET `/sessions*` request specifically (SANDBOX-VISIBILITY-JOIN
   * #3): if the live forward fails (most commonly the host is offline —
   * an ephemeral CI box's ~3min lifetime is well within normal
   * `device_sessions` polling cadence), falls back to
   * `HostRegistry.getSessionsSnapshot` — the last successful response for
   * that EXACT path, `stale: true`, with a `capturedAt` timestamp — instead
   * of throwing. Still throws if there's no snapshot to fall back to, or
   * for any other path (exec, device-inference, …), where serving stale
   * data silently would be actively wrong.
   */
  forwardHttp(idOrName: string, req: ForwardHttpRequest): Promise<ForwardHttpResponse>
}

/**
 * Best-effort device kind from the client's self-reported name. No wire
 * field carries a real client-kind hint yet — pair/v2's `clientName` is the
 * only signal the handshake exchanges — but both shipped clients default
 * that name to a recognisable shape: `browser@<host>` (or bare `browser`)
 * for the web pair page (`pair-client/src/pair.ts`), `<user>@<host>` for the
 * CLI (`cli/src/util/pair-transport.ts`). A user-supplied `--name` overrides
 * the default and loses the signal — acceptable for a hint, not an identity.
 */
function inferKind(name: string): DeviceKind {
  return /^browser(@|$)/i.test(name) ? "browser" : "cli"
}

function toDevice(record: PairingRecord, online: boolean): Device {
  return {
    fingerprint: record.fingerprint,
    name: record.name,
    role: "client",
    kind: inferKind(record.name),
    rendezvous: record.rendezvousUrl,
    createdAt: record.createdAt,
    lastSeen: record.lastSeen,
    online,
    ...(record.legacy ? { legacy: true } : {}),
    ...(record.scope ? { scope: record.scope } : {}),
  }
}

/** A registered host is always `kind: "daemon"` — the other side of a
 *  reverse pairing is, by construction, an agentproto daemon (never a
 *  browser). A host is always `scope: "host"` by construction: `add()`
 *  refuses anything else. */
function toHostDevice(record: HostRecord, online: boolean): Device {
  return {
    fingerprint: record.fingerprint,
    name: record.name,
    role: "host",
    kind: "daemon",
    rendezvous: record.rendezvousUrl,
    createdAt: record.createdAt,
    lastSeen: record.lastSeen,
    online,
    ...(record.legacy ? { legacy: true } : {}),
    scope: "host",
    ...(record.provider ? { provider: record.provider } : {}),
    ...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
    ...(record.labels ? { labels: record.labels } : {}),
    ...(record.lastProbeAt ? { lastProbeAt: record.lastProbeAt } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
    ...(record.ended ? { ended: true as const, ...(record.endedAt ? { endedAt: record.endedAt } : {}) } : {}),
    ...(record.stale ? { stale: true as const } : {}),
  }
}

export function createDeviceRegistry(pairing: PairingRegistry, hosts?: HostRegistry): DeviceRegistry {
  return {
    async list(opts) {
      const records = await pairing.list()
      const devices = records.map(r => toDevice(r, pairing.isOnline(r.fingerprint)))
      if (hosts) {
        const hostRecords = await hosts.list()
        devices.push(
          ...hostRecords
            .filter(r => opts?.includeEnded || !r.ended)
            .map(r => toHostDevice(r, hosts.isOnline(r.fingerprint))),
        )
      }
      return devices
    },
    async rename(idOrName, newName) {
      if (await pairing.rename(idOrName, newName)) return true
      if (hosts) return hosts.rename(idOrName, newName)
      return false
    },
    async revoke(idOrName) {
      if (await pairing.revoke(idOrName)) return true
      if (hosts) return hosts.revoke(idOrName)
      return false
    },
    async add(offerUrl, name) {
      if (!hosts) {
        throw new Error(
          "this daemon has no host registry wired — devices add is unavailable (internal " +
            "configuration issue, not a user error)",
        )
      }
      return hosts.add(offerUrl, name)
    },
    async forwardHttp(idOrName, req) {
      if (!hosts) {
        throw new Error(
          "this daemon has no host registry wired — device sessions is unavailable (internal " +
            "configuration issue, not a user error)",
        )
      }
      try {
        return await hosts.forwardHttp(idOrName, req)
      } catch (err) {
        if (req.method !== "GET" || !isSessionsPath(req.path)) throw err
        const snapshot = hosts.getSessionsSnapshot(idOrName, req.path)
        if (!snapshot) throw err
        return snapshot
      }
    },
  }
}
