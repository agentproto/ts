import { describe, expect, it } from "vitest"

import type { Device, SessionDescriptor } from "../client/types.js"
import {
  buildDeviceSessionRows,
  buildDevicesWebviewModel,
  canManageDevice,
  nextExpandedIds,
  type DeviceSessionsState,
} from "./devicesWebview.logic.js"

const NOW = Date.parse("2026-09-28T12:00:00.000Z")

function device(overrides: Partial<Device> = {}): Device {
  return {
    fingerprint: "fp-1",
    name: "Jeremy's Phone",
    role: "client",
    kind: "browser",
    rendezvous: "wss://relay.example/rv/1",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastSeen: new Date(NOW - 5 * 60_000).toISOString(),
    online: true,
    ...overrides,
  }
}

function session(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    status: "running",
    command: "claude",
    pid: 1,
    startedAt: new Date(NOW - 60_000).toISOString(),
    workspaceSlug: "ws",
    ...overrides,
  } as SessionDescriptor
}

describe("buildDevicesWebviewModel", () => {
  it("always leads with a synthetic this-machine row", () => {
    const model = buildDevicesWebviewModel({
      hostname: "jeremys-mac",
      daemonVersion: "0.42.0",
      localSessionCount: 3,
      devices: [],
      expandedIds: new Set(),
      sessionsByDevice: new Map(),
      now: NOW,
    })
    expect(model.rows).toHaveLength(1)
    const row = model.rows[0]!
    expect(row.id).toBe("this-machine")
    expect(row.isThisMachine).toBe(true)
    expect(row.name).toBe("jeremys-mac")
    expect(row.kindLabel).toBe("daemon v0.42.0")
    expect(row.detail).toBe("3 sessions")
    expect(row.online).toBe(true)
    expect(row.expandable).toBe(false)
  })

  it("singularizes the this-machine session count", () => {
    const model = buildDevicesWebviewModel({
      hostname: "h",
      daemonVersion: undefined,
      localSessionCount: 1,
      devices: [],
      expandedIds: new Set(),
      sessionsByDevice: new Map(),
      now: NOW,
    })
    expect(model.rows[0]!.detail).toBe("1 session")
    expect(model.rows[0]!.kindLabel).toBe("daemon")
  })

  it("shapes a client device row: role/kind labels, online dot, relative last-seen", () => {
    const model = buildDevicesWebviewModel({
      hostname: "h",
      daemonVersion: "1.0.0",
      localSessionCount: 0,
      devices: [device()],
      expandedIds: new Set(),
      sessionsByDevice: new Map(),
      now: NOW,
    })
    const row = model.rows[1]!
    expect(row.isThisMachine).toBe(false)
    expect(row.roleLabel).toBe("Client")
    expect(row.kindLabel).toBe("browser")
    expect(row.online).toBe(true)
    expect(row.lastSeenLabel).toBe("5 mins ago")
    expect(row.expandable).toBe(false)
    expect(row.fingerprint).toBe("fp-1")
  })

  it("marks only a host-role device expandable — a client pairing has nothing to expand into", () => {
    const model = buildDevicesWebviewModel({
      hostname: "h",
      daemonVersion: undefined,
      localSessionCount: 0,
      devices: [device({ role: "client" }), device({ fingerprint: "fp-2", role: "host", kind: "daemon" })],
      expandedIds: new Set(),
      sessionsByDevice: new Map(),
      now: NOW,
    })
    const [, clientRow, hostRow] = model.rows
    expect(clientRow!.expandable).toBe(false)
    expect(hostRow!.roleLabel).toBe("Host")
    expect(hostRow!.expandable).toBe(true)
  })

  it("surfaces host-scoped and legacy flags as booleans", () => {
    const model = buildDevicesWebviewModel({
      hostname: "h",
      daemonVersion: undefined,
      localSessionCount: 0,
      devices: [device({ scope: "host", legacy: true })],
      expandedIds: new Set(),
      sessionsByDevice: new Map(),
      now: NOW,
    })
    const row = model.rows[1]!
    expect(row.hostScoped).toBe(true)
    expect(row.legacy).toBe(true)
  })

  it("includes provider/sandboxId in a host's detail line when self-reported", () => {
    const model = buildDevicesWebviewModel({
      hostname: "h",
      daemonVersion: undefined,
      localSessionCount: 0,
      devices: [
        device({ fingerprint: "fp-host", role: "host", kind: "daemon", provider: "modal", sandboxId: "sbx-9" }),
      ],
      expandedIds: new Set(),
      sessionsByDevice: new Map(),
      now: NOW,
    })
    expect(model.rows[1]!.detail).toBe("modal · sbx-9 · fp-host")
  })

  it("sorts online devices before offline ones, then alphabetically", () => {
    const model = buildDevicesWebviewModel({
      hostname: "h",
      daemonVersion: undefined,
      localSessionCount: 0,
      devices: [
        device({ fingerprint: "fp-b", name: "Bravo", online: false }),
        device({ fingerprint: "fp-a", name: "Alpha", online: true }),
        device({ fingerprint: "fp-c", name: "Charlie", online: true }),
      ],
      expandedIds: new Set(),
      sessionsByDevice: new Map(),
      now: NOW,
    })
    expect(model.rows.slice(1).map(r => r.name)).toEqual(["Alpha", "Charlie", "Bravo"])
  })

  it("attaches a loaded sessions state only to an expanded host row", () => {
    const host = device({ fingerprint: "fp-host", role: "host", kind: "daemon" })
    const model = buildDevicesWebviewModel({
      hostname: "h",
      daemonVersion: undefined,
      localSessionCount: 0,
      devices: [host],
      expandedIds: new Set(["fp-host"]),
      sessionsByDevice: new Map<string, DeviceSessionsState>([["fp-host", { status: "loaded", sessions: [session({ busy: true })] }]]),
      now: NOW,
    })
    const row = model.rows[1]!
    expect(row.sessions).toEqual({
      status: "loaded",
      rows: [{ id: "s1", name: "agent-cli · s1", status: "working", ageLabel: "1 min ago" }],
    })
  })

  it("omits sessions state for a collapsed host even when a cached entry exists", () => {
    const host = device({ fingerprint: "fp-host", role: "host", kind: "daemon" })
    const model = buildDevicesWebviewModel({
      hostname: "h",
      daemonVersion: undefined,
      localSessionCount: 0,
      devices: [host],
      expandedIds: new Set(),
      sessionsByDevice: new Map<string, DeviceSessionsState>([["fp-host", { status: "loaded", sessions: [session()] }]]),
      now: NOW,
    })
    expect(model.rows[1]!.sessions).toBeUndefined()
  })

  it("passes through a loading/error sessions state verbatim", () => {
    const host = device({ fingerprint: "fp-host", role: "host", kind: "daemon" })
    const loadingModel = buildDevicesWebviewModel({
      hostname: "h",
      daemonVersion: undefined,
      localSessionCount: 0,
      devices: [host],
      expandedIds: new Set(["fp-host"]),
      sessionsByDevice: new Map<string, DeviceSessionsState>([["fp-host", { status: "loading" }]]),
      now: NOW,
    })
    expect(loadingModel.rows[1]!.sessions).toEqual({ status: "loading" })

    const errorModel = buildDevicesWebviewModel({
      hostname: "h",
      daemonVersion: undefined,
      localSessionCount: 0,
      devices: [host],
      expandedIds: new Set(["fp-host"]),
      sessionsByDevice: new Map<string, DeviceSessionsState>([["fp-host", { status: "error", message: "offline" }]]),
      now: NOW,
    })
    expect(errorModel.rows[1]!.sessions).toEqual({ status: "error", message: "offline" })
  })
})

describe("buildDeviceSessionRows", () => {
  it("orders sessions by urgency — needs-you before working before done", () => {
    const rows = buildDeviceSessionRows(
      [
        session({ id: "done1", status: "exited", exitCode: 0, turnsCompleted: 1 }),
        session({ id: "working1", busy: true }),
        session({ id: "needsyou1", awaitingInput: true }),
      ],
      NOW,
    )
    expect(rows.map(r => r.id)).toEqual(["needsyou1", "working1", "done1"])
  })

  it("formats each row's name/status/age from the shared session classifier", () => {
    const rows = buildDeviceSessionRows(
      [session({ id: "s9", busy: true, startedAt: new Date(NOW - 3600_000).toISOString() })],
      NOW,
    )
    expect(rows).toEqual([{ id: "s9", name: "agent-cli · s9", status: "working", ageLabel: "1 hr ago" }])
  })
})

describe("nextExpandedIds", () => {
  it("adds an id not yet present", () => {
    const next = nextExpandedIds(new Set(), "a")
    expect([...next]).toEqual(["a"])
  })

  it("removes an id already present — toggling twice is a no-op", () => {
    const once = nextExpandedIds(new Set(), "a")
    const twice = nextExpandedIds(once, "a")
    expect([...twice]).toEqual([])
  })

  it("never mutates the input set", () => {
    const current = new Set(["a"])
    nextExpandedIds(current, "b")
    expect([...current]).toEqual(["a"])
  })
})

describe("canManageDevice", () => {
  it("is false for the synthetic this-machine row", () => {
    expect(canManageDevice({ isThisMachine: true })).toBe(false)
  })

  it("is true for a real device row", () => {
    expect(canManageDevice({ isThisMachine: false })).toBe(true)
  })
})
