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

describe("adapter-pi client — system-prompt argv (`--append-system-prompt`)", () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it("pushes the manifest's flag + text onto the child argv", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(connectOpts({ appendSystemPrompt: "AGENT.md text" }))

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args.slice(-2)).toEqual(["--append-system-prompt", "AGENT.md text"])

    await client.close()
  })

  it("pushes it on a `--session` resume spawn too (every connect recomposes argv)", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(
      connectOpts({ resumeSessionId: "sess-old", appendSystemPrompt: "AGENT.md text" }),
    )

    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args).toEqual([
      "--mode",
      "rpc",
      "--session",
      "sess-old",
      "--append-system-prompt",
      "AGENT.md text",
    ])

    await client.close()
  })

  it("omits the flag when the spawn carries no text", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(connectOpts({ model: "anthropic/claude-sonnet-4-5" }))

    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args).not.toContain("--append-system-prompt")

    await client.close()
  })
})
