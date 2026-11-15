/**
 * The account-health surface over MCP: `account_health_list`,
 * `account_health_clear`, `account_slots_prefer`, the per-account health in
 * `account_slots_list`, and the `accountHealth` summary of `daemon_health`.
 * A real in-memory MCP client drives the tools.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { createAccountHealthStore, type AccountHealthStore } from "../account-health.js"
import { registerAccountHealthTools, summarizeAccountHealth } from "../account-health-tools.js"
import { registerAccountSlotTools } from "../account-slot-tools.js"
import { registerDaemonHealthTools } from "../daemon-health-tools.js"
import type { AccountSlotPreferPlan, AccountSlots } from "../account-slots.js"
import type { SessionDescriptor } from "../sessions.js"

const T0 = Date.parse("2026-11-15T10:00:00Z")
const H = 3_600_000

function textOf(result: unknown): string {
  return (result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? "{}"
}

describe("account health MCP tools", () => {
  let dir: string
  let store: AccountHealthStore
  let slots: AccountSlots
  let written: AccountSlotPreferPlan | undefined
  let sessions: SessionDescriptor[]
  const restarts: Array<{ id: string; access: { profileRef: string } }> = []
  let client: Client

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agp-health-tools-"))
    store = createAccountHealthStore({ dir, now: () => T0 })
    slots = { "opencode-go": ["ws01", "ws003", "hodl"], "claude-primary": "sub-a" }
    written = undefined
    restarts.length = 0
    sessions = [
      {
        id: "s-ws01",
        kind: "agent-cli",
        status: "running",
        accessSlot: "opencode-go",
        accessProfile: { profileRef: "ws01" },
      } as SessionDescriptor,
    ]
    const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
    registerAccountHealthTools(server, {
      store,
      loadAccountSlots: async () => slots,
      getAuthProfile: async id => ({ endpoint: id === "sub-a" ? "anthropic" : "opencode-go" }),
      readQuota: async ref =>
        ref === "sub-a"
          ? {
              profileRef: "sub-a",
              fetchedAt: "2026-11-15T09:00:00.000Z",
              windows: { "5h": { window: "5h", remaining: 0, resetsAt: "2026-11-15T14:00:00.000Z", basis: "provider" } },
            }
          : undefined,
    })
    registerAccountSlotTools(server, {
      registry: { list: () => sessions },
      loadAccountSlots: async () => slots,
      getAuthProfile: async () => ({}),
      accountHealth: store,
      applyPrefer: async plan => {
        written = plan
      },
      restartSession: async (prev, overrides) => {
        restarts.push({ id: prev.id, access: overrides.access })
        return { id: `${prev.id}-next` }
      },
    })
    registerDaemonHealthTools(server, {
      workspace: dir,
      registered: [],
      startedAt: T0,
      resumeSessionsOnBoot: false,
      idleReapAfterMs: 0,
      accountHealth: () => summarizeAccountHealth(store),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    client = new Client({ name: "test-client", version: "0" })
    await client.connect(clientTransport)
  })
  afterEach(async () => {
    await client.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    JSON.parse(textOf(await client.callTool({ name, arguments: args })))

  it("account_health_list shows every known account: closed first, with until, source, reason and the quota", async () => {
    await store.mark("ws01", { reason: "Insufficient balance", until: T0 + 30 * H, untilBasis: "observed" })
    await store.mark("ws003", { reason: "402" }) // backoff
    const { accounts } = await call("account_health_list")
    expect(accounts.map((a: { profileRef: string }) => a.profileRef)).toEqual(["ws003", "ws01", "hodl", "sub-a"])
    expect(accounts[0]).toMatchObject({ state: "exhausted", untilBasis: "estimated", strikes: 1, slots: ["opencode-go"] })
    expect(accounts[1]).toMatchObject({ state: "exhausted", untilBasis: "observed", until: new Date(T0 + 30 * H).toISOString() })
    expect(accounts.find((a: { profileRef: string }) => a.profileRef === "hodl")).toMatchObject({ state: "ok" })
    expect(accounts.find((a: { profileRef: string }) => a.profileRef === "sub-a").quota.windows["5h"]).toMatchObject({ remaining: 0 })
  })

  it("account_health_clear reopens an account and says whether there was an entry; a slot is refused", async () => {
    await store.mark("ws01", { reason: "402" })
    expect(await call("account_health_clear", { profileRef: "ws01" })).toEqual({ profileRef: "ws01", cleared: true })
    expect(await call("account_health_clear", { profileRef: "ws01" })).toEqual({ profileRef: "ws01", cleared: false })
    const refused = await client.callTool({ name: "account_health_clear", arguments: { profileRef: "slot:opencode-go" } })
    expect(refused.isError).toBe(true)
  })

  it("account_slots_list carries each slot account's health", async () => {
    await store.mark("ws01", { reason: "402", until: T0 + 4 * H, untilBasis: "observed" })
    const { slots: rows } = await call("account_slots_list")
    const slot = rows.find((r: { slot: string }) => r.slot === "opencode-go")
    expect(slot.profileRef).toBe("ws003")
    expect(slot.accounts[0]).toMatchObject({ profileRef: "ws01", health: { state: "exhausted" } })
  })

  it("account_slots_prefer reorders the slot, and with moveAlive restarts sessions off the old head", async () => {
    const dry = await call("account_slots_prefer", { slot: "opencode-go", profile: "hodl", dryRun: true, moveAlive: true })
    expect(dry).toMatchObject({ dryRun: true, before: ["ws01", "ws003", "hodl"], after: ["hodl", "ws01", "ws003"] })
    expect(dry.moved).toEqual([{ from: "s-ws01", label: "s-ws01" }])
    expect(written).toBeUndefined()

    const real = await call("account_slots_prefer", { slot: "opencode-go", profile: "hodl", moveAlive: true })
    expect(written?.after["opencode-go"]).toEqual(["hodl", "ws01", "ws003"])
    expect(real.moved).toEqual([{ from: "s-ws01", to: "s-ws01-next", label: "s-ws01" }])
    expect(restarts).toEqual([{ id: "s-ws01", access: { profileRef: "slot:opencode-go" } }])
  })

  it("daemon_health summarizes the closed accounts, [] when none", async () => {
    expect((await call("daemon_health")).accountHealth).toEqual([])
    await store.mark("ws01", { reason: "402", until: T0 + 30 * H, untilBasis: "observed" })
    const body = await call("daemon_health")
    expect(body.accountHealth).toEqual([
      { profileRef: "ws01", until: new Date(T0 + 30 * H).toISOString(), untilBasis: "observed", reason: "402" },
    ])
  })
})
