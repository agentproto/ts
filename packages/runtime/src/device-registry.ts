/**
 * Device registry — a read view over `PairingRegistry` that presents each
 * pairing as a "device" (DEVICES-PLAN PR-A). Today every device is a paired
 * CLIENT (today's `pair_offer`/`pair accept`); hosts (reverse pairing, PR-C)
 * join the same `list()` later with `role: "host"`.
 *
 * This is deliberately a thin computed view, not a second store: renaming
 * and revoking a device mutate the same `pairings.json` `PairingRegistry`
 * already owns, so `pair_*`/`/pairings` and `device_*`/`/devices` are two
 * surfaces over one source of truth.
 */

import type { PairingRegistry, PairingRecord } from "./pairing-registry.js"

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
  /** A channel (offer or reconnect) is served for this device right now. */
  online: boolean
  /** A pair/v1 pairing: listed and revocable, but can't connect until
   *  re-paired — see `PairingRecord.legacy`. */
  legacy?: true
}

export interface DeviceRegistry {
  /** Every known device. Read-only. */
  list(): Promise<Device[]>
  /** Rename a device (fingerprint or current name) to a new label. Returns
   *  false when nothing matched. */
  rename(idOrName: string, newName: string): Promise<boolean>
  /** Drop a device by fingerprint or name — same effect as `pair revoke`.
   *  Returns false when nothing matched. */
  revoke(idOrName: string): Promise<boolean>
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
  }
}

export function createDeviceRegistry(pairing: PairingRegistry): DeviceRegistry {
  return {
    async list() {
      const records = await pairing.list()
      return records.map(r => toDevice(r, pairing.isOnline(r.fingerprint)))
    },
    rename: (idOrName, newName) => pairing.rename(idOrName, newName),
    revoke: idOrName => pairing.revoke(idOrName),
  }
}
