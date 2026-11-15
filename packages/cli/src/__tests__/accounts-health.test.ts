/**
 * `agentproto accounts health|prefer|slots`, ../commands/accounts.ts, with the
 * daemon MCP client mocked (`app-serve.js`): the verbs are thin wrappers over
 * the `account_health_*` and `account_slots_*` tools.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runAccounts } from "../commands/accounts.js"

const calls: Array<{ name: string; arguments: Record<string, unknown> }> = []
let replies: Record<string, unknown> = {}

vi.mock("../app-serve.js", () => ({
  resolveDaemonMcpUrl: async () => "http://127.0.0.1:1/mcp",
  createDaemonMcpClientGetter: () => async () => ({
    callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
      calls.push(req)
      return { content: [{ type: "text", text: JSON.stringify(replies[req.name] ?? {}) }] }
    },
    close: async () => {},
  }),
}))

describe("agentproto accounts health / prefer / slots", () => {
  let out: string[]
  let err: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let outSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errSpy: any

  beforeEach(() => {
    calls.length = 0
    replies = {}
    out = []
    err = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => (out.push(String(c)), true)) as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => (err.push(String(c)), true)) as any)
  })
  afterEach(() => {
    outSpy.mockRestore()
    errSpy.mockRestore()
  })

  it("health lists each account with its state, until, source and reason", async () => {
    replies.account_health_list = {
      accounts: [
        {
          profileRef: "opencode-ws01",
          state: "exhausted",
          until: "2026-11-16T19:00:00.000Z",
          untilBasis: "observed",
          reason: "usage limit reached (weekly, resets in 1d 9h)",
          strikes: 1,
          slots: ["opencode-go"],
        },
        { profileRef: "opencode-hodl", state: "ok", slots: ["opencode-go"] },
      ],
    }
    expect(await runAccounts(["health"])).toBe(0)
    expect(calls).toEqual([{ name: "account_health_list", arguments: {} }])
    const text = out.join("")
    expect(text).toContain("opencode-ws01: exhausted until 2026-11-16T19:00:00.000Z (observed, strike 1) [slot opencode-go]")
    expect(text).toContain("opencode-hodl: ok [slot opencode-go]")
  })

  it("health --clear reopens an account through account_health_clear", async () => {
    replies.account_health_clear = { profileRef: "opencode-ws01", cleared: true }
    expect(await runAccounts(["health", "--clear", "opencode-ws01"])).toBe(0)
    expect(calls).toEqual([{ name: "account_health_clear", arguments: { profileRef: "opencode-ws01" } }])
    expect(out.join("")).toContain("opencode-ws01 reopened")
  })

  it("prefer puts an account at the head of a multi-account slot and passes the flags", async () => {
    replies.account_slots_prefer = {
      slot: "opencode-go",
      dryRun: true,
      before: ["a", "b"],
      after: ["b", "a"],
      moved: [{ from: "s1", label: "worker" }],
      failed: [],
    }
    expect(await runAccounts(["prefer", "opencode-go", "b", "--move-alive", "--dry-run"])).toBe(0)
    expect(calls).toEqual([
      { name: "account_slots_prefer", arguments: { slot: "opencode-go", profile: "b", moveAlive: true, dryRun: true } },
    ])
    expect(out.join("")).toContain("would order opencode-go: a, b -> b, a")
    expect(out.join("")).toContain("would restart s1 (worker) onto slot:opencode-go")
  })

  it("prefer without both arguments is a usage error", async () => {
    expect(await runAccounts(["prefer", "opencode-go"])).toBe(2)
    expect(calls).toEqual([])
  })

  it("slots prints a slot with several accounts with each account's health", async () => {
    replies.account_slots_list = {
      slots: [
        {
          slot: "opencode-go",
          profileRef: "b",
          accounts: [
            { profileRef: "a", health: { state: "exhausted", until: "2026-11-16T00:00:00.000Z", untilBasis: "estimated", reason: "402", strikes: 1 } },
            { profileRef: "b" },
          ],
          aliveSessions: [],
        },
      ],
    }
    expect(await runAccounts(["slots"])).toBe(0)
    const text = out.join("")
    expect(text).toContain("opencode-go (several accounts, spawns land on b)")
    expect(text).toContain("- a [exhausted until 2026-11-16T00:00:00.000Z]")
    expect(text).toContain("- b")
  })
})
