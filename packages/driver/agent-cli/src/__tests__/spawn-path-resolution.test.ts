import { describe, it, expect, vi, afterEach } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { delimiter, dirname, join } from "node:path"
import { existsSync } from "node:fs"
import type { AgentCliDefinition } from "../types.js"

/**
 * Regression coverage for the 2026-08-30 codex spawn failure: `agent_start`
 * for an npx-based adapter on a daemon whose PATH lacks the nvm bin dir
 * failed with `spawn npx ENOENT`. Two distinct causes produce that exact
 * error string, and the fix addresses both:
 *
 *  1. PATH genuinely missing the Node bin dir (launchd daemon). `npx` ships
 *     as a `#!/usr/bin/env node` script SIBLING to the node binary in every
 *     install layout, so `resolveSpawnBin` now resolves `npx`/`npm` relative
 *     to `process.execPath`, and `ensureExecDirOnPath` appends that dir to
 *     the child env's PATH (the shebang — and npx's own child `node` spawns
 *     — resolve off the CHILD's PATH, so an absolute bin path alone is not
 *     enough).
 *
 *  2. A nonexistent session cwd — Node reports that as the byte-identical
 *     `spawn <bin> ENOENT`, masquerading as a missing binary. The spawn
 *     failure handler now probes the cwd and names the real cause in the
 *     rejection instead of the (wrong) PATH hint.
 */

const spawnCalls: Array<{
  bin: string
  args: string[]
  opts: { cwd?: string; env?: Record<string, string> }
}> = []
let nextSpawnError: Error | undefined

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(),
  })
  const failure = nextSpawnError
  queueMicrotask(() => {
    if (failure) child.emit("error", failure)
    else child.emit("spawn")
  })
  return child
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(
    (bin: string, args: string[], opts: { cwd?: string; env?: Record<string, string> }) => {
      spawnCalls.push({ bin, args, opts })
      return fakeChild()
    },
  ),
}))

vi.mock("../protocol/acp-client.js", () => ({
  createAcpProtocolArm: vi.fn(() => ({
    sessionId: "acp-sess-1",
    async connect() {},
    async send() {},
    async *events() {},
    async cancel() {},
    async close() {},
  })),
}))

import { createAgentCliRuntime, resolveSpawnBin } from "../define-agent-cli.js"

const npxDef: AgentCliDefinition = {
  name: "codex",
  id: "codex",
  description: "fake",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "@agentclientprotocol/codex-acp@1.1.14"],
  install: [
    { method: "npm", package: "@agentclientprotocol/codex-acp@1.1.14", global: true },
  ],
  version_check: {
    cmd: "npm view @agentclientprotocol/codex-acp@1.1.14 version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: "=1.1.14",
    timeout_ms: 5000,
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./codex-acp.ACP.md",
} as AgentCliDefinition

const execDir = dirname(process.execPath)

afterEach(() => {
  spawnCalls.length = 0
  nextSpawnError = undefined
  vi.unstubAllEnvs()
})

describe("resolveSpawnBin — execPath-relative resolution", () => {
  it("resolves 'node' to process.execPath", () => {
    expect(resolveSpawnBin("node")).toBe(process.execPath)
  })

  it("resolves 'npx' to the sibling of execPath when it exists", () => {
    const resolved = resolveSpawnBin("npx", {
      execPath: "/opt/nvm/versions/node/v22.0.0/bin/node",
      exists: () => true,
    })
    expect(resolved).toBe(join("/opt/nvm/versions/node/v22.0.0/bin", "npx"))
  })

  it("falls back to bare 'npx' (PATH lookup) when no sibling exists", () => {
    const resolved = resolveSpawnBin("npx", {
      execPath: "/opt/trimmed/node",
      exists: () => false,
    })
    expect(resolved).toBe("npx")
  })

  it("resolves 'npm' the same way", () => {
    const resolved = resolveSpawnBin("npm", {
      execPath: "/opt/nvm/versions/node/v22.0.0/bin/node",
      exists: () => true,
    })
    expect(resolved).toBe(join("/opt/nvm/versions/node/v22.0.0/bin", "npm"))
  })

  it("leaves every other bin to PATH lookup, never probing the filesystem", () => {
    const exists = vi.fn(() => true)
    expect(resolveSpawnBin("hermes", { exists })).toBe("hermes")
    expect(resolveSpawnBin("gemini", { exists })).toBe("gemini")
    expect(exists).not.toHaveBeenCalled()
  })
})

describe("start() — child PATH always reaches the running node's bin dir", () => {
  it("appends the execPath dir when the daemon's PATH lacks it (launchd case)", async () => {
    vi.stubEnv("PATH", "/usr/bin:/bin")
    await createAgentCliRuntime(npxDef).start({ cwd: "/tmp" })
    const childPath = spawnCalls[0]?.opts.env?.PATH ?? ""
    expect(childPath.split(delimiter)).toContain(execDir)
    // Appended, not prepended — the daemon's own PATH entries stay first.
    expect(childPath.startsWith("/usr/bin")).toBe(true)
  })

  it("keeps an operator-supplied PATH first and only appends the fallback", async () => {
    await createAgentCliRuntime(npxDef).start({
      cwd: "/tmp",
      env: { PATH: "/custom/toolchain/bin" },
    })
    const childPath = spawnCalls[0]?.opts.env?.PATH ?? ""
    expect(childPath.split(delimiter)[0]).toBe("/custom/toolchain/bin")
    expect(childPath.split(delimiter)).toContain(execDir)
  })

  it("does not duplicate the execPath dir when PATH already has it", async () => {
    vi.stubEnv("PATH", `/usr/bin${delimiter}${execDir}`)
    await createAgentCliRuntime(npxDef).start({ cwd: "/tmp" })
    const parts = (spawnCalls[0]?.opts.env?.PATH ?? "").split(delimiter)
    expect(parts.filter(p => p === execDir)).toHaveLength(1)
  })

  it.runIf(existsSync(join(execDir, "npx")))(
    "spawns npx via its absolute execPath-sibling, not a PATH-dependent lookup",
    async () => {
      await createAgentCliRuntime(npxDef).start({ cwd: "/tmp" })
      expect(spawnCalls[0]?.bin).toBe(join(execDir, "npx"))
    },
  )
})

describe("spawn ENOENT — missing cwd is disambiguated from a missing binary", () => {
  it("names the nonexistent cwd instead of the PATH hint", async () => {
    nextSpawnError = Object.assign(new Error("spawn npx ENOENT"), {
      code: "ENOENT",
      syscall: "spawn npx",
      path: "npx",
    })
    const call = createAgentCliRuntime(npxDef).start({
      cwd: "/nonexistent-agentproto-cwd-e2e",
    })
    await expect(call).rejects.toThrow(
      /cwd '\/nonexistent-agentproto-cwd-e2e' does not exist/,
    )
    await expect(call).rejects.not.toThrow(/daemon's PATH/)
  })

  it("keeps the PATH hint when the cwd exists (genuine missing-binary ENOENT)", async () => {
    nextSpawnError = Object.assign(new Error("spawn npx ENOENT"), {
      code: "ENOENT",
      syscall: "spawn npx",
      path: "npx",
    })
    const call = createAgentCliRuntime(npxDef).start({ cwd: "/tmp" })
    await expect(call).rejects.toThrow(/daemon's PATH.*which npx.*agentproto daemon restart/s)
    await expect(call).rejects.not.toThrow(/does not exist/)
  })
})
