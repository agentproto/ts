import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

import { createAgentCliClient } from "../client.js"
import { pi } from "../index.js"
import type { AgentCliConnectOptions } from "@agentproto/driver-agent-cli"

/** A minimal fake `pi --mode rpc` child: answers `get_state` immediately so
 *  `connect()`'s readiness probe resolves without a real pi binary. */
function makeFakeChild() {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
    killed: boolean
  }
  child.stdout = stdout
  child.stderr = stderr
  child.killed = false
  child.kill = vi.fn()
  child.stdin = {
    end: vi.fn(),
    write: vi.fn((data: string) => {
      const msg = JSON.parse(data) as { id: string; type: string }
      if (msg.type === "get_state") {
        queueMicrotask(() => {
          stdout.emit(
            "data",
            `${JSON.stringify({
              id: msg.id,
              type: "response",
              command: "get_state",
              success: true,
              data: { sessionId: "sess-fake" },
            })}\n`,
          )
        })
      }
    }),
  }
  return child
}

function connectOpts(overrides: Partial<AgentCliConnectOptions> = {}): AgentCliConnectOptions {
  return {
    cwd: "/tmp",
    env: {},
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

describe("adapter-pi client — lean mode argv", () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it("passes pi's read-only/context-less flags when mode is 'lean'", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(connectOpts({ model: "openrouter/z-ai/glm-5.3-flash", mode: "lean" }))

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args).toEqual([
      "--mode",
      "rpc",
      "--model",
      "openrouter/z-ai/glm-5.3-flash",
      "--tools",
      "read",
      "--no-context-files",
      "--no-skills",
      "--no-extensions",
    ])

    await client.close()
  })

  // Regression for the review concern: lean combines a restricted tool set
  // with the daemon's OWN AGENTS.md injection, which degrades to a POINTER
  // sentence (a path, not the file's content) once the target repo's
  // AGENTS.md exceeds session-spawn.ts's inline size cap. A `--no-tools`
  // session would have no way to act on "read it before your first tool
  // call" in that case, silently stranding required repository
  // instructions. This is the invariant that must hold regardless of any
  // future change to lean's argv: pi's `read` tool (one of its 4 built-ins)
  // stays enabled, so a pointer is always actionable — never assert
  // `--no-tools` for lean, and never assert lean's tool set excludes "read".
  it("keeps the read tool enabled so a pointer-mode AGENTS.md instruction stays actionable", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(connectOpts({ model: "openrouter/z-ai/glm-5.3-flash", mode: "lean" }))

    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args).not.toContain("--no-tools")
    const toolsFlagIndex = args.indexOf("--tools")
    expect(toolsFlagIndex).toBeGreaterThanOrEqual(0)
    expect(args[toolsFlagIndex + 1]?.split(",")).toContain("read")

    await client.close()
  })

  it("does not pass the lean flags by default (unchanged behavior)", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(connectOpts({ model: "anthropic/claude-sonnet-4-5" }))

    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args).toEqual(["--mode", "rpc", "--model", "anthropic/claude-sonnet-4-5"])

    await client.close()
  })

  it("skips MCP-bridge injection in lean mode even when mcpServers are supplied", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(
      connectOpts({
        model: "anthropic/claude-sonnet-4-5",
        mode: "lean",
        mcpServers: [{ name: "agentproto", transport: "http", ref: "http://127.0.0.1:1/mcp" }],
      }),
    )

    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args).not.toContain("-e")

    await client.close()
  })
})
