/**
 * WP-6 — proves `makeAgentFactory` actually attaches the
 * `AgentprotoSignalProvider` (manual `connect` + `startPolling`, since
 * `buildMastraAgent` has no `signals` passthrough) and merges its
 * `watch_session`/`unwatch_session` tools into the controller config —
 * modes-on only. Same config-capture pattern as `daemon-tools-wiring.test.ts`.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentControllerConfig } from "@mastra/core/agent-controller"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeAgentFactory } from "../default-agent.js"
import { AgentprotoSignalProvider } from "../signal-provider.js"

const capturedConfigs: Array<AgentControllerConfig<unknown>> = []

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
  const dir = await mkdtemp(join(tmpdir(), "mastra-agent-wp6-wiring-"))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  capturedConfigs.length = 0
  vi.restoreAllMocks()
})

describe("makeAgentFactory — modes on (default)", () => {
  it("connects the provider, starts polling, and merges its tools into config.tools", async () => {
    const connectSpy = vi.spyOn(AgentprotoSignalProvider.prototype, "connect")
    const startPollingSpy = vi.spyOn(AgentprotoSignalProvider.prototype, "startPolling")

    const cwd = await makeTmpDir()
    const factory = makeAgentFactory({ model: "mock/wp6-modes-on", cwd })
    await factory()

    expect(connectSpy).toHaveBeenCalledTimes(1)
    expect(startPollingSpy).toHaveBeenCalledTimes(1)

    const tools = capturedConfigs[0]!.tools as Record<string, unknown>
    expect(tools.watch_session, "watch_session should be in modes-on config.tools").toBeDefined()
    expect(tools.unwatch_session, "unwatch_session should be in modes-on config.tools").toBeDefined()
    // Additive over the WP-5 daemon tools and the workspace toolset.
    expect(tools.agent_start).toBeDefined()
    expect(tools.read_file).toBeDefined()
  })
})

describe("makeAgentFactory — parity mode (modes: false)", () => {
  it("attaches no provider and no watch tools", async () => {
    const connectSpy = vi.spyOn(AgentprotoSignalProvider.prototype, "connect")

    const cwd = await makeTmpDir()
    const factory = makeAgentFactory({ model: "mock/wp6-parity", cwd, modes: false })
    await factory()

    expect(connectSpy).not.toHaveBeenCalled()
    const tools = capturedConfigs[0]!.tools as Record<string, unknown>
    expect(tools.watch_session).toBeUndefined()
    expect(tools.unwatch_session).toBeUndefined()
  })
})
