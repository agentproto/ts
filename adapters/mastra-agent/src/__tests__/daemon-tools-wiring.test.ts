/**
 * WP-5 — proves `makeAgentFactory` actually wires the daemon sub-agent tools
 * and the in-process `reviewer` subagent into the `AgentController` config it
 * builds (not just that `tool-categories.ts`'s resolver KNOWS their names —
 * `tool-categories.test.ts` covers that independently of whether they're
 * registered on the controller at all).
 *
 * Subclasses the real `AgentController` to capture the config object each
 * `makeAgentFactory()` call constructs it with — `.init()`/`.createSession()`
 * keep working normally (it's a real subclass, not a stub), but we never
 * need to call them here since the config object alone answers "is it wired".
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentControllerConfig } from "@mastra/core/agent-controller"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeAgentFactory } from "../default-agent.js"

const capturedConfigs: Array<AgentControllerConfig<unknown>> = []

// `vi.mock` calls are hoisted above imports by vitest's transform, so this
// intercepts the `AgentController` `default-agent.ts` imports above, even
// though it's written after that import.
vi.mock("@mastra/core/agent-controller", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mastra/core/agent-controller")>()
  class SpyingAgentController<TState> extends actual.AgentController<TState> {
    constructor(config: AgentControllerConfig<TState>) {
      capturedConfigs.push(config as AgentControllerConfig<unknown>)
      super(config)
    }
  }
  return { ...actual, AgentController: SpyingAgentController }
})

const tmpDirs: string[] = []
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mastra-agent-wp5-wiring-"))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  capturedConfigs.length = 0
})

const DAEMON_TOOL_IDS = ["agent_start", "agent_prompt", "agent_output", "session_list"]

describe("makeAgentFactory — modes on (default)", () => {
  it("config.tools carries the four daemon tools alongside the workspace toolset", async () => {
    const cwd = await makeTmpDir()
    const factory = makeAgentFactory({ model: "mock/wp5-modes-on", cwd })
    await factory()

    expect(capturedConfigs).toHaveLength(1)
    const tools = capturedConfigs[0]!.tools as Record<string, unknown>
    for (const id of DAEMON_TOOL_IDS) {
      expect(tools[id], `tool '${id}' should be present in modes-on config.tools`).toBeDefined()
    }
    // The workspace toolset stays too — daemon tools are additive, not a replacement.
    expect(tools.read_file).toBeDefined()
    expect(tools.write_file).toBeDefined()
  })

  it("re-enables the `subagent` built-in and configures the reviewer subagent (forked, read-only tools)", async () => {
    const cwd = await makeTmpDir()
    const factory = makeAgentFactory({ model: "mock/wp5-subagent", cwd })
    await factory()

    const config = capturedConfigs[0]!
    expect(config.disableBuiltinTools).not.toContain("subagent")
    // submit_plan (WP-3) must still be re-enabled too — WP-5 is additive, not a regression.
    expect(config.disableBuiltinTools).not.toContain("submit_plan")

    expect(config.subagents).toHaveLength(1)
    const reviewer = config.subagents![0]!
    expect(reviewer.id).toBe("reviewer")
    expect(reviewer.forked).toBe(true)
    expect(reviewer.allowedControllerTools).toEqual(
      expect.arrayContaining(["read_file", "read_diff", "run_tests", "list_dir"]),
    )
  })
})

describe("makeAgentFactory — parity mode (modes: false)", () => {
  it("carries none of the WP-5 additions: no daemon tools, subagent stays disabled, no subagents config", async () => {
    const cwd = await makeTmpDir()
    const factory = makeAgentFactory({ model: "mock/wp5-parity", cwd, modes: false })
    await factory()

    const config = capturedConfigs[0]!
    const tools = config.tools as Record<string, unknown>
    for (const id of DAEMON_TOOL_IDS) {
      expect(tools[id], `tool '${id}' should be ABSENT from parity config.tools`).toBeUndefined()
    }
    expect(config.disableBuiltinTools).toContain("subagent")
    expect(config.subagents).toBeUndefined()
  })
})
