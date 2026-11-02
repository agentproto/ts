import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runSandbox, SANDBOX_EXEC_INFRA_EXIT, type SandboxExecCliDeps } from "../commands/sandbox.js"

function captureOutput() {
  const stdout: string[] = []
  const stderr: string[] = []
  const o = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (stdout.push(String(c)), true))
  const e = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (stderr.push(String(c)), true))
  return {
    out: () => stdout.join(""),
    err: () => stderr.join(""),
    restore: () => (o.mockRestore(), e.mockRestore()),
  }
}

const found = { found: { url: "http://127.0.0.1:18790", token: "tok" }, stale: [] }

const report = {
  ok: true,
  provider: "computer",
  slots: [
    { slot: "a", publicIp: "203.0.113.1", computers: 2, cooling: [] },
    {
      slot: "b",
      publicIp: "203.0.113.2",
      computers: 1,
      cooling: [
        { publicIp: "203.0.113.2", model: "opencode/big-pickle", errorClass: "usage-limit", until: "2026-01-01T01:00:00.000Z", remainingMs: 3_540_000 },
      ],
    },
  ],
  cooldowns: [
    { publicIp: "203.0.113.2", model: "opencode/big-pickle", errorClass: "usage-limit", until: "2026-01-01T01:00:00.000Z", remainingMs: 3_540_000 },
    { publicIp: "198.51.100.9", model: "opencode/big-pickle", errorClass: "rate-limit", until: "2026-01-01T00:10:00.000Z", remainingMs: 540_000 },
  ],
}

function deps(response: { status: number; body: unknown }) {
  const get = vi.fn(async (_url: string, _token?: string) => response)
  const post = vi.fn(async (_url: string, _body: unknown, _token?: string) => response)
  const d: SandboxExecCliDeps = { discover: async () => found, get, post }
  return { d, get, post }
}

let cap: ReturnType<typeof captureOutput>
beforeEach(() => {
  cap = captureOutput()
})
afterEach(() => cap.restore())

describe("agentproto sandbox egress-health", () => {
  it("lists slots, IPs and active cooldowns from GET /sandboxes/egress-health", async () => {
    const { d, get, post } = deps({ status: 200, body: report })
    expect(await runSandbox(["egress-health"], undefined, d)).toBe(0)
    expect(get).toHaveBeenCalledWith("http://127.0.0.1:18790/sandboxes/egress-health", "tok")
    expect(post).not.toHaveBeenCalled()
    const out = cap.out()
    expect(out).toContain("egress pool: computer")
    expect(out).toMatch(/a\s+203\.0\.113\.1\s+2 boxes/)
    expect(out).toMatch(/b\s+203\.0\.113\.2\s+1 box\n/)
    expect(out).toContain("cooling opencode/big-pickle [usage-limit] 59m left")
    expect(out).toContain("(not in pool) 198.51.100.9 cooling opencode/big-pickle [rate-limit] 9m left")
  })

  it("passes --provider and --model as query params", async () => {
    const { d, get } = deps({ status: 200, body: report })
    await runSandbox(["egress-health", "--provider", "computer", "--model", "opencode/big-pickle"], undefined, d)
    expect(get.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:18790/sandboxes/egress-health?provider=computer&model=opencode%2Fbig-pickle",
    )
  })

  it("--json prints the daemon response verbatim", async () => {
    const { d } = deps({ status: 200, body: report })
    expect(await runSandbox(["egress-health", "--json"], undefined, d)).toBe(0)
    expect(JSON.parse(cap.out())).toEqual(report)
  })

  it("--probe posts to the probe route and exits 1 when a slot is still capped", async () => {
    const probe = {
      ok: true,
      provider: "computer",
      model: "opencode/big-pickle",
      adapter: "opencode",
      results: [
        { slot: "a", publicIp: "203.0.113.1", verdict: "ok", detail: "answered", cleared: 1 },
        { slot: "b", publicIp: "203.0.113.2", verdict: "ko", detail: "Free usage limit reached" },
      ],
    }
    const { d, get, post } = deps({ status: 200, body: probe })
    const code = await runSandbox(["egress-health", "--probe", "opencode/big-pickle", "--adapter", "opencode"], undefined, d)
    expect(code).toBe(1)
    expect(get).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/sandboxes/egress-health/probe",
      { model: "opencode/big-pickle", adapter: "opencode" },
      "tok",
    )
    expect(cap.out()).toMatch(/a\s+203\.0\.113\.1\s+OK\s+answered \(cleared 1\)/)
    expect(cap.out()).toMatch(/b\s+203\.0\.113\.2\s+KO/)
  })

  it("--probe exits 0 when every slot answers", async () => {
    const probe = {
      ok: true,
      provider: "computer",
      model: "m",
      adapter: "opencode",
      results: [{ slot: "a", publicIp: "203.0.113.1", verdict: "ok", detail: "answered" }],
    }
    const { d } = deps({ status: 200, body: probe })
    expect(await runSandbox(["egress-health", "--probe", "m"], undefined, d)).toBe(0)
  })

  it("rejects bad flag combinations with exit 2 before contacting the daemon", async () => {
    const { d, get, post } = deps({ status: 200, body: report })
    expect(await runSandbox(["egress-health", "--adapter", "opencode"], undefined, d)).toBe(2)
    expect(await runSandbox(["egress-health", "--probe", "m", "--model", "m"], undefined, d)).toBe(2)
    expect(await runSandbox(["egress-health", "--bogus"], undefined, d)).toBe(2)
    expect(get).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it("surfaces a daemon error and a missing daemon as an infra failure", async () => {
    const { d } = deps({
      status: 501,
      body: { ok: false, code: "egress_pool_unsupported", message: 'provider "e2b" has no egress address pool' },
    })
    expect(await runSandbox(["egress-health", "--provider", "e2b"], undefined, d)).toBe(SANDBOX_EXEC_INFRA_EXIT)
    expect(cap.err()).toContain("[egress_pool_unsupported]")

    const none: SandboxExecCliDeps = { discover: async () => ({ found: null, stale: [] }) as never }
    expect(await runSandbox(["egress-health"], undefined, none)).toBe(SANDBOX_EXEC_INFRA_EXIT)
    expect(cap.err()).toContain("no live daemon found")
  })
})
