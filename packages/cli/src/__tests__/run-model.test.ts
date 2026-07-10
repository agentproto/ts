/**
 * `agentproto run --model` / `--effort` (issue #5).
 *
 * `run` is the natural one-shot verb but had no `--model` flag — picking a
 * model forced you onto `sessions start`, and passing `--model` threw a raw
 * parseArgs error instead of a friendly message. These pin that `--model` /
 * `--effort` now reach the driver as manifest `model`/`effort` options (the
 * same channel `agent_start` / `sessions start` use), and that an unknown
 * flag is reported cleanly with exit 2.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { AgentCliStartOptions } from "@agentproto/driver-agent-cli"

const startSpy = vi.fn<(opts?: AgentCliStartOptions) => Promise<unknown>>()

vi.mock("@agentproto/driver-agent-cli", () => ({
  createAgentCliRuntime: () => ({
    definition: { id: "fake" },
    start: (opts?: AgentCliStartOptions) => startSpy(opts),
  }),
}))

vi.mock("../registry/resolve.js", () => ({
  resolveAdapter: vi.fn(async () => ({ handle: { id: "fake", bin: "fake" } })),
}))

// No piped stdin — force the `--prompt` path.
vi.mock("../util/stdin.js", () => ({
  readStdinIfPiped: vi.fn(async () => null),
}))

const { runRun } = await import("../commands/run.js")

/** A fake session whose one turn ends immediately. */
function fakeSession() {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *send() {
      yield { kind: "turn-end", reason: "completed" as const }
    },
    async close() {},
  }
}

describe("agentproto run — --model / --effort", () => {
  beforeEach(() => {
    startSpy.mockReset()
    startSpy.mockResolvedValue(fakeSession())
  })

  it("threads --model and --effort through as config.options", async () => {
    const code = await runRun([
      "claude-code",
      "--model",
      "claude-opus-4-8",
      "--effort",
      "high",
      "--prompt",
      "hi",
    ])
    expect(code).toBe(0)
    const opts = startSpy.mock.calls[0]?.[0]
    expect(opts?.config?.options).toEqual({
      model: "claude-opus-4-8",
      effort: "high",
    })
  })

  it("omits config entirely when neither --model nor --effort is given", async () => {
    const code = await runRun(["claude-code", "--prompt", "hi"])
    expect(code).toBe(0)
    const opts = startSpy.mock.calls[0]?.[0]
    expect(opts?.config).toBeUndefined()
  })

  it("reports an unknown flag with exit 2 instead of throwing", async () => {
    const stderr: string[] = []
    const spy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stderr as any, "write")
      .mockImplementation((chunk: unknown) => {
        stderr.push(String(chunk))
        return true
      })
    const code = await runRun(["claude-code", "--bogus", "--prompt", "hi"])
    spy.mockRestore()
    expect(code).toBe(2)
    expect(stderr.join("")).toContain("agentproto run:")
    expect(startSpy).not.toHaveBeenCalled()
  })
})
