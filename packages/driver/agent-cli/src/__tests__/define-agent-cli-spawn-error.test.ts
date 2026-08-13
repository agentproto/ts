import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { AgentCliDefinition } from "../types.js"

/**
 * Regression coverage for the 2026-08-11 daemon crash: a launchd-started
 * daemon's minimal PATH doesn't contain `node` (no interactive-shell nvm
 * setup), so `spawn("node", ...)` for the mastra-agent adapter failed with
 * ENOENT. Nothing in the spawn chain listened for the ChildProcess's
 * 'error' event, so Node threw it as an UNHANDLED exception and crashed the
 * whole daemon process — every session on the box, not just the one
 * `app_run` call that triggered it.
 *
 * `createAgentCliRuntime(...).start()` must now:
 *   1. Resolve a manifest `bin: "node"` to `process.execPath`, sidestepping
 *      PATH lookup entirely for the one bin value that always means "this
 *      runtime" (see `resolveSpawnBin`).
 *   2. Turn a spawn failure into a normal rejected promise — never an
 *      unhandled 'error' event — so the caller (`session-spawn.ts` /
 *      `app_run`) can report it as a clean `{ok:false, message}` result
 *      instead of the process dying.
 */

let nextSpawnError: Error | undefined
let nextSpawnStderr: string | undefined
const spawnCalls: Array<{ bin: string; args: string[] }> = []
const protocolArms: Array<{ sessionId: string; _stderrTail?: () => string }> = []

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(),
  })
  const failure = nextSpawnError
  queueMicrotask(() => {
    if (failure) child.emit("error", failure)
    else {
      child.emit("spawn")
      queueMicrotask(() => {
        if (nextSpawnStderr) child.stderr.write(nextSpawnStderr)
      })
    }
  })
  return child
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    spawnCalls.push({ bin, args })
    return fakeChild()
  }),
}))

vi.mock("../protocol/acp-client.js", () => ({
  createAcpProtocolArm: vi.fn(() => {
    const arm = {
      sessionId: "acp-sess-1",
      async connect() {},
      async send() {},
      async *events() {},
      async cancel() {},
      async close() {},
    }
    protocolArms.push(arm)
    return arm
  }),
}))

import { createAgentCliRuntime } from "../define-agent-cli.js"

const nodeBinDef: AgentCliDefinition = {
  name: "mastra-agent",
  id: "mastra-agent",
  description: "fake",
  version: "0.1.0",
  bin: "node",
  bin_args: ["/fake/cli.mjs", "acp"],
  install: [{ method: "npm", package: "@agentproto/adapter-mastra-agent", global: true }],
  version_check: {
    cmd: "node --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=20.9.0",
    timeout_ms: 5000,
  },
  sandbox: "in-process",
  protocol: "acp",
  acp: "./mastra-agent.ACP.md",
} as AgentCliDefinition

describe("createAgentCliRuntime(...).start() — spawn failure never crashes the process", () => {
  it("rejects start() cleanly instead of letting the child's 'error' event go unhandled", async () => {
    nextSpawnError = Object.assign(new Error("spawn node ENOENT"), {
      code: "ENOENT",
      syscall: "spawn node",
      path: "node",
    })

    // If define-agent-cli.ts didn't attach an 'error' listener before this
    // await, Node would throw the child's 'error' event as an unhandled
    // exception here and crash the whole test process — not just fail this
    // assertion. Getting a rejected promise back IS the fix.
    await expect(createAgentCliRuntime(nodeBinDef).start({ cwd: "/tmp" })).rejects.toThrow(
      /spawn node ENOENT/,
    )

    nextSpawnError = undefined
  })

  it("names the adapter and the resolved command in the rejection message", async () => {
    nextSpawnError = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" })
    await expect(createAgentCliRuntime(nodeBinDef).start({ cwd: "/tmp" })).rejects.toThrow(
      /mastra-agent/,
    )
    nextSpawnError = undefined
  })

  it("appends an actionable PATH hint for ENOENT spawn failures", async () => {
    nextSpawnError = Object.assign(new Error("spawn node ENOENT"), {
      code: "ENOENT",
      syscall: "spawn node",
      path: "node",
    })
    await expect(createAgentCliRuntime(nodeBinDef).start({ cwd: "/tmp" })).rejects.toThrow(
      /was not found on the daemon's PATH.*agentproto daemon restart/s,
    )
    nextSpawnError = undefined
  })

  it("does not append the PATH hint for a non-ENOENT spawn failure (e.g. EACCES)", async () => {
    nextSpawnError = Object.assign(new Error("spawn node EACCES"), {
      code: "EACCES",
      syscall: "spawn node",
      path: "node",
    })
    const call = createAgentCliRuntime(nodeBinDef).start({ cwd: "/tmp" })
    await expect(call).rejects.toThrow(/spawn node EACCES/)
    await expect(call).rejects.not.toThrow(/daemon's PATH/)
    nextSpawnError = undefined
  })

  it("resolves a bare 'node' bin to process.execPath, not a PATH-dependent lookup", async () => {
    nextSpawnError = undefined
    spawnCalls.length = 0
    await createAgentCliRuntime(nodeBinDef).start({ cwd: "/tmp" })
    expect(spawnCalls[0]?.bin).toBe(process.execPath)
    expect(spawnCalls[0]?.bin).not.toBe("node")
  })

  it("succeeds normally when the spawn does not fail", async () => {
    nextSpawnError = undefined
    const session = await createAgentCliRuntime(nodeBinDef).start({ cwd: "/tmp" })
    expect(session.sessionId).toBe("acp-sess-1")
  })

  it("still starts when Codex reports an available update on stderr", async () => {
    nextSpawnError = undefined
    nextSpawnStderr = "✨ Update available! 0.145.0 -> 0.146.0\n"
    protocolArms.length = 0

    await expect(
      createAgentCliRuntime({
        ...nodeBinDef,
        id: "codex",
        name: "codex",
        bin: "npx",
        bin_args: ["-y", "@agentclientprotocol/codex-acp@1.1.14"],
      }).start({ cwd: "/tmp" }),
    ).resolves.toMatchObject({ sessionId: "acp-sess-1" })

    expect(protocolArms.at(-1)?._stderrTail?.()).toContain(
      "Update available! 0.145.0 -> 0.146.0",
    )
    nextSpawnStderr = undefined
  })
})
