/**
 * A native-TUI terminal (`claude`, `codex`, `opencode` in a PTY) carries
 * model / tokens / cost on its descriptor once linked to its provider
 * conversation, via the injected harness readers — the same fields an
 * agent-cli session has — plus the value-vs-paid split.
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry } from "../sessions.js"
import type { PtyFactory, SessionsRegistry } from "../sessions.js"
import type { TerminalUsageReader } from "../terminal-usage.js"

function ptyHarness(): { factory: PtyFactory; exit: () => void } {
  let onExit: ((e: { exitCode: number; signal?: number }) => void) | undefined
  const factory: PtyFactory = () => ({
    pid: 4242,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      onExit = cb
    },
  })
  return { factory, exit: () => onExit?.({ exitCode: 0 }) }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor: condition not met in time")
    await new Promise(r => setTimeout(r, 15))
  }
}

describe("terminal usage capture", () => {
  let home: string | undefined
  let registry: SessionsRegistry | undefined
  let prevHome: string | undefined

  afterEach(() => {
    registry?.shutdown()
    registry = undefined
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
  })

  function setup(readers?: Record<string, TerminalUsageReader>) {
    prevHome = process.env.HOME
    home = mkdtempSync(join(tmpdir(), "term-usage-"))
    process.env.HOME = home
    const h = ptyHarness()
    registry = createSessionsRegistry({
      bucketsRoot: join(home, ".agentproto", "workspaces"),
      workspacesConfigPath: join(home, ".agentproto", "workspaces.json"),
      transcriptDir: join(home, ".agentproto", "sessions"),
      spawnPty: h.factory,
      usageRefreshIntervalMs: 20,
      ...(readers ? { terminalUsageReaders: readers } : {}),
    })
    return { registry, h }
  }

  it("claude TUI: model + tokens from the transcript, cost priced from the catalog, subscription pays 0", async () => {
    const { registry } = setup({
      "claude-code": async () => ({
        model: "claude-sonnet-5-5",
        tokensIn: 1000,
        tokensOut: 500,
        cacheReadTokens: 2000,
        billing: "subscription",
      }),
    })
    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd: "/fake/proj",
      argv: ["claude", "--resume", "0e483f81-1a44-4bec-9667-b37158450296"],
      cols: 80,
      rows: 24,
    })
    await waitFor(() => registry.get(desc.id)?.tokensIn !== undefined)
    const live = registry.get(desc.id)!
    expect(live.model).toBe("claude-sonnet-5-5")
    expect(live.tokensOut).toBe(500)
    expect(live.cacheReadTokens).toBe(2000)
    expect(live.usageSource).toBe("computed")
    expect(live.costUsd).toBeGreaterThan(0)
    expect(live.billing).toBe("subscription")
    expect(live.paidCostUsd).toBe(0)
  })

  it("metered billing: paidCostUsd equals the value", async () => {
    const { registry } = setup({
      opencode: async () => ({
        model: "claude-sonnet-5-5",
        tokensIn: 100_000,
        tokensOut: 10_000,
        billing: "api-key",
      }),
    })
    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd: "/fake/metered",
      argv: ["opencode", "-s", "ses_metered"],
      cols: 80,
      rows: 24,
    })
    await waitFor(() => registry.get(desc.id)?.costUsd !== undefined)
    const live = registry.get(desc.id)!
    expect(live.costUsd).toBeGreaterThan(0)
    expect(live.paidCostUsd).toBe(live.costUsd)
  })

  it("opencode TUI: harness-reported cost wins and is tagged adapter", async () => {
    const { registry } = setup({
      opencode: async () => ({
        model: "opencode/claude-sonnet-5-5",
        costUsd: 0.42,
        tokensIn: 10,
        tokensOut: 5,
        billing: "api-key",
      }),
    })
    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd: "/fake/oc",
      argv: ["opencode", "-s", "ses_abc"],
      cols: 80,
      rows: 24,
    })
    await waitFor(() => registry.get(desc.id)?.costUsd !== undefined)
    const live = registry.get(desc.id)!
    expect(live.costUsd).toBe(0.42)
    expect(live.usageSource).toBe("adapter")
    expect(live.billing).toBe("api-key")
    expect(live.paidCostUsd).toBe(0.42)
  })

  it("a last read lands when the terminal exits, and the poller stops", async () => {
    let calls = 0
    let tokens = 10
    const { registry, h } = setup({
      opencode: async () => {
        calls++
        return { model: "opencode-go/glm-5.3-flash", tokensIn: tokens, tokensOut: 1, billing: "subscription" }
      },
    })
    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd: "/fake/oc2",
      argv: ["opencode", "-s", "ses_exit"],
      cols: 80,
      rows: 24,
    })
    await waitFor(() => registry.get(desc.id)?.tokensIn === 10)
    tokens = 99
    h.exit()
    await waitFor(() => registry.get(desc.id)?.tokensIn === 99)
    const after = calls
    await new Promise(r => setTimeout(r, 80))
    expect(calls).toBe(after)
  })

  it("no injected reader (or a plain shell): no usage fields, nothing polled", async () => {
    const { registry } = setup()
    const tui = registry.spawnPty({
      workspaceSlug: "default",
      cwd: "/fake/a",
      argv: ["opencode", "-s", "ses_none"],
      cols: 80,
      rows: 24,
    })
    const shell = registry.spawnPty({ workspaceSlug: "default", cwd: "/fake/b", argv: ["bash"], cols: 80, rows: 24 })
    await new Promise(r => setTimeout(r, 80))
    expect(registry.get(tui.id)?.tokensIn).toBeUndefined()
    expect(registry.get(shell.id)?.costUsd).toBeUndefined()
  })
})
