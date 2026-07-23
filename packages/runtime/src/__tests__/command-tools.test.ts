/**
 * Unit tests for command-tools.ts's session-based persistence wiring:
 *   - command_execute mints a kind:"command" session via
 *     registry.recordCommand and echoes its id back to the caller
 *   - the session's full result lands at its own events.jsonl
 *   - command_log_tail reads results back, by sessionId or by listing
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

// Control knob for the "no sandbox backend available" fail-closed path —
// `resolveCommandSandbox` is a pure platform probe (real sandbox-exec/bwrap),
// so the only way to exercise "configured but missing" portably is to mock
// it. `undefined` (the default) defers to the real probe; tests that need
// the missing-backend branch set it to `null`.
const sandboxOverride = vi.hoisted(() => ({
  backend: undefined as
    | undefined
    | null
    | { id: string; wrap: (argv: string[], policy: unknown) => string[] },
}))

vi.mock("@agentproto/command-sandbox", async importOriginal => {
  const actual =
    await importOriginal<typeof import("@agentproto/command-sandbox")>()
  return {
    ...actual,
    resolveCommandSandbox: () =>
      sandboxOverride.backend === undefined
        ? actual.resolveCommandSandbox()
        : sandboxOverride.backend,
  }
})

import { registerCommandTools } from "../command-tools.js"
import { COMMAND_SANDBOX_MODE_ENV } from "@agentproto/command-sandbox"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"

async function buildHarness(
  workspace: string,
  registry: SessionsRegistry,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerCommandTools(server, { workspace, registry })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return { client, close: () => client.close() }
}

function allowlist(workspace: string, commands: string[]): void {
  mkdirSync(join(workspace, ".agentproto"), { recursive: true })
  writeFileSync(
    join(workspace, ".agentproto", "allowed-commands.json"),
    JSON.stringify({ version: 1, commands }),
  )
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content
  return content?.[0]?.text ?? "{}"
}

/** `recordCommand`'s JSONL body write is fire-and-forget — the session
 *  descriptor (and its id) is available the instant command_execute
 *  returns, but the on-disk write it kicked off may not have landed yet.
 *  Tests that immediately read it back via command_log_tail poll until
 *  `isReady` accepts the result, instead of a fixed delay — a fixed 20ms
 *  sleep flakes under CI load (the write genuinely hasn't landed yet). */
async function pollUntil<T>(
  read: () => Promise<T>,
  isReady: (value: T) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (isReady(value)) return value
    if (Date.now() >= deadline) throw new Error("pollUntil timed out")
    await new Promise(res => setTimeout(res, 5))
  }
}

describe("command_execute → session-based persistence", () => {
  let workspace: string
  let registry: SessionsRegistry

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "command-tools-test-"))
    allowlist(workspace, ["node"])
    // persist:false skips writing sessions.json, but `persistPath` still
    // anchors the transcript-writer's base dir — omitting it would fall
    // back to the real `~/.agentproto/sessions`.
    registry = createSessionsRegistry({ persistPath: join(workspace, "sessions.json"), persist: false })
  })

  afterEach(() => {
    registry.shutdown()
    rmSync(workspace, { recursive: true, force: true })
  })

  it("mints a kind:\"command\" session and echoes its id back to the caller", async () => {
    const { client, close } = await buildHarness(workspace, registry)
    const result = await client.callTool({
      name: "command_execute",
      arguments: { command: "node", args: ["-e", "console.log('hello-from-test')"] },
    })
    expect(result.isError).toBeFalsy()
    const { sessionId, exitCode, stdout } = JSON.parse(textOf(result))
    expect(exitCode).toBe(0)
    expect(stdout).toContain("hello-from-test")

    const desc = registry.get(sessionId)
    expect(desc?.kind).toBe("command")
    expect(desc?.status).toBe("exited")
    expect(desc?.argv).toEqual(["node", "-e", "console.log('hello-from-test')"])

    await close()
  })

  it("defaults origin to \"command_execute\" when the caller doesn't pass one", async () => {
    const { client, close } = await buildHarness(workspace, registry)
    const result = await client.callTool({
      name: "command_execute",
      arguments: { command: "node", args: ["-e", "console.log('hi')"] },
    })
    const { sessionId } = JSON.parse(textOf(result))
    const desc = registry.get(sessionId)
    expect(desc?.origin).toBe("command_execute")
    expect(desc?.callerSessionId).toBeUndefined()

    await close()
  })

  it("passes an explicit origin through onto the minted session", async () => {
    const { client, close } = await buildHarness(workspace, registry)
    const result = await client.callTool({
      name: "command_execute",
      arguments: { command: "node", args: ["-e", "console.log('hi')"], origin: "cowork" },
    })
    const { sessionId } = JSON.parse(textOf(result))
    const desc = registry.get(sessionId)
    expect(desc?.origin).toBe("cowork")

    await close()
  })

  it("still records a nonzero-exit invocation as status \"error\"", async () => {
    const { client, close } = await buildHarness(workspace, registry)
    const result = await client.callTool({
      name: "command_execute",
      arguments: { command: "node", args: ["-e", "process.exit(3)"] },
    })
    const { sessionId } = JSON.parse(textOf(result))
    const desc = registry.get(sessionId)
    expect(desc?.status).toBe("error")
    expect(desc?.exitCode).toBe(3)

    await close()
  })

  it("command_log_tail(sessionId) reads back the full result for one invocation", async () => {
    const { client, close } = await buildHarness(workspace, registry)
    const exec = await client.callTool({
      name: "command_execute",
      arguments: { command: "node", args: ["-e", "console.log('full-result')"] },
    })
    const { sessionId } = JSON.parse(textOf(exec))

    const { entry } = await pollUntil(
      async () => {
        const tail = await client.callTool({
          name: "command_log_tail",
          arguments: { sessionId },
        })
        return JSON.parse(textOf(tail))
      },
      result => result.entry !== null,
    )
    expect(entry).toMatchObject({ command: "node", exitCode: 0 })
    expect(entry.stdout).toContain("full-result")

    await close()
  })

  it("command_log_tail(sessionId) returns a null entry for a non-command session", async () => {
    const { client, close } = await buildHarness(workspace, registry)
    const tail = await client.callTool({
      name: "command_log_tail",
      arguments: { sessionId: "sess_doesnotexist" },
    })
    expect(JSON.parse(textOf(tail))).toEqual({ entry: null })
    await close()
  })

  it("command_log_tail lists recent invocations, newest last, respecting lastN", async () => {
    const { client, close } = await buildHarness(workspace, registry)
    for (const n of [1, 2, 3]) {
      await client.callTool({
        name: "command_execute",
        arguments: { command: "node", args: ["-e", `console.log(${n})`] },
      })
    }
    const { entries } = await pollUntil(
      async () => {
        const result = await client.callTool({
          name: "command_log_tail",
          arguments: { lastN: 2 },
        })
        return JSON.parse(textOf(result)) as { entries: Array<{ stdout?: string }> }
      },
      result => result.entries.every(e => typeof e.stdout === "string"),
    )
    expect(entries).toHaveLength(2)
    expect(entries.map(e => e.stdout!.trim())).toEqual(["2", "3"])

    await close()
  })

  it("command_log_tail returns an empty list for a workspace with no history", async () => {
    const { client, close } = await buildHarness(workspace, registry)
    const result = await client.callTool({ name: "command_log_tail", arguments: {} })
    expect(JSON.parse(textOf(result))).toEqual({ entries: [] })
    await close()
  })
})

function sandboxConfig(workspace: string, json: string): void {
  mkdirSync(join(workspace, ".agentproto"), { recursive: true })
  writeFileSync(join(workspace, ".agentproto", "command-sandbox.json"), json)
}

describe("command_execute → sandbox confinement default posture", () => {
  let workspace: string
  let registry: SessionsRegistry
  const originalEnv = process.env[COMMAND_SANDBOX_MODE_ENV]

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "command-tools-sandbox-test-"))
    allowlist(workspace, ["node"])
    registry = createSessionsRegistry({ persistPath: join(workspace, "sessions.json"), persist: false })
    sandboxOverride.backend = undefined
  })

  afterEach(() => {
    registry.shutdown()
    rmSync(workspace, { recursive: true, force: true })
    sandboxOverride.backend = undefined
    if (originalEnv === undefined) delete process.env[COMMAND_SANDBOX_MODE_ENV]
    else process.env[COMMAND_SANDBOX_MODE_ENV] = originalEnv
  })

  it("defaults to unconfined (mode 'off') and warns loudly on every call, not once", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { client, close } = await buildHarness(workspace, registry)
    for (const n of [1, 2]) {
      const result = await client.callTool({
        name: "command_execute",
        arguments: { command: "node", args: ["-e", `console.log(${n})`] },
      })
      expect(result.isError).toBeFalsy()
    }
    const unconfinedWarnings = errSpy.mock.calls.filter(call =>
      String(call[0]).includes("UNCONFINED"),
    )
    // Two calls, no dedup ⇒ two warnings — this is the "every run" nag, not
    // the one-time-per-basename interpreter warning.
    expect(unconfinedWarnings).toHaveLength(2)
    errSpy.mockRestore()
    await close()
  })

  it("fails CLOSED (refuses to run) when a mode is configured but no backend is available", async () => {
    sandboxConfig(workspace, JSON.stringify({ mode: "workspace" }))
    sandboxOverride.backend = null // simulate a platform with no sandbox-exec/bwrap
    const { client, close } = await buildHarness(workspace, registry)
    const result = await client.callTool({
      name: "command_execute",
      arguments: { command: "node", args: ["-e", "console.log('should not run')"] },
    })
    expect(result.isError).toBeTruthy()
    expect(textOf(result)).toContain("no sandbox backend is available")
    expect(textOf(result)).toContain("Refusing to run")
    await close()
  })

  it("the env override forces mode 'off' even when the workspace config asks for confinement", async () => {
    sandboxConfig(workspace, JSON.stringify({ mode: "workspace" }))
    sandboxOverride.backend = null // would fail closed under the file's mode…
    process.env[COMMAND_SANDBOX_MODE_ENV] = "off" // …but the env escape hatch wins
    const { client, close } = await buildHarness(workspace, registry)
    const result = await client.callTool({
      name: "command_execute",
      arguments: { command: "node", args: ["-e", "console.log('unblocked')"] },
    })
    expect(result.isError).toBeFalsy()
    const { stdout } = JSON.parse(textOf(result))
    expect(stdout).toContain("unblocked")
    await close()
  })

  it("wraps and still runs successfully when 'workspace' mode is configured and a real backend exists", async () => {
    if (!existsSync("/usr/bin/sandbox-exec") && !existsSync("/usr/bin/bwrap")) return
    sandboxConfig(workspace, JSON.stringify({ mode: "workspace" }))
    const { client, close } = await buildHarness(workspace, registry)
    const result = await client.callTool({
      name: "command_execute",
      arguments: { command: "node", args: ["-e", "console.log('confined-ok')"] },
    })
    expect(result.isError).toBeFalsy()
    const { stdout, exitCode } = JSON.parse(textOf(result))
    expect(exitCode).toBe(0)
    expect(stdout).toContain("confined-ok")
    await close()
  })
})
