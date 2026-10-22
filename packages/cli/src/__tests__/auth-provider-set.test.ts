/**
 * `agentproto auth provider set` must finish the job: store the key, write
 * the `defaults.adapters.<slug>.auth` block the spawn resolver requires, and
 * ask a running daemon to reload the provider store.
 *
 * Before this, the key was stored but ignored with a message asking the user
 * to hand-edit JSON (“providers.json already has a stored key … ignored
 * until that block exists”), and a daemon restart was left as an exercise.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runAuth } from "../commands/auth.js"

interface Config {
  defaults?: {
    adapters?: Record<string, { auth?: { mode?: string } }>
  }
  adapters?: string[]
}

describe("agentproto auth provider set — writes adapter auth defaults", () => {
  let home: string
  let prevHome: string | undefined
  let prevAgentprotoHome: string | undefined
  let prevDaemonUrl: string | undefined

  beforeEach(() => {
    prevHome = process.env.HOME
    prevAgentprotoHome = process.env.AGENTPROTO_HOME
    prevDaemonUrl = process.env.AGENTPROTO_DAEMON_URL
    home = mkdtempSync(join(tmpdir(), "agentproto-provider-set-"))
    process.env.HOME = home
    process.env.AGENTPROTO_HOME = join(home, ".agentproto")
    // Do not discover the developer's real daemon: point at a dead port so
    // the reload attempt fails fast without touching anything.
    process.env.AGENTPROTO_DAEMON_URL = "http://127.0.0.1:1"
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevAgentprotoHome === undefined) delete process.env.AGENTPROTO_HOME
    else process.env.AGENTPROTO_HOME = prevAgentprotoHome
    if (prevDaemonUrl === undefined) delete process.env.AGENTPROTO_DAEMON_URL
    else process.env.AGENTPROTO_DAEMON_URL = prevDaemonUrl
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function readConfig(): Config {
    return JSON.parse(
      readFileSync(join(home, ".agentproto", "config.json"), "utf8"),
    ) as Config
  }

  function writeConfig(cfg: Config): void {
    mkdirSync(join(home, ".agentproto"), { recursive: true })
    writeFileSync(
      join(home, ".agentproto", "config.json"),
      `${JSON.stringify(cfg, null, 2)}\n`,
    )
  }

  function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        lines.push(String(chunk))
        return true
      })
    return { lines, restore: () => spy.mockRestore() }
  }

  it("writes the api-key block for the canonical adapter (anthropic → claude-code)", async () => {
    const io = captureStdout()

    const code = await runAuth([
      "provider",
      "set",
      "anthropic",
      "sk-ant-test",
    ])

    expect(code).toBe(0)
    expect(readConfig().defaults?.adapters?.["claude-code"]?.auth?.mode).toBe(
      "api-key",
    )
    expect(io.lines.join("")).toMatch(/api-key auth enabled for claude-code/)
    io.restore()
  })

  it("honors an explicit --adapter slug", async () => {
    const io = captureStdout()

    const code = await runAuth([
      "provider",
      "set",
      "anthropic",
      "sk-ant-test",
      "--adapter",
      "opencode",
    ])

    expect(code).toBe(0)
    expect(readConfig().defaults?.adapters?.["opencode"]?.auth?.mode).toBe(
      "api-key",
    )
    io.restore()
  })

  it("never flips an explicit subscription choice to api-key", async () => {
    writeConfig({
      defaults: {
        adapters: { "claude-code": { auth: { mode: "subscription" } } },
      },
    })
    const io = captureStdout()

    const code = await runAuth(["provider", "set", "anthropic", "sk-ant-test"])

    expect(code).toBe(0)
    expect(readConfig().defaults?.adapters?.["claude-code"]?.auth?.mode).toBe(
      "subscription",
    )
    expect(io.lines.join("")).toMatch(/kept the existing auth mode/)
    io.restore()
  })
})
