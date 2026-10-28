import { describe, expect, it } from "vitest"
import { createAgentCliClient, mastraController } from "../index.js"

describe("mastraController (defineHarness)", () => {
  it("is the proprietary mastra-controller arm, served by this package", () => {
    expect(mastraController.id).toBe("mastra-controller")
    expect(mastraController.protocol).toBe("proprietary")
    expect(mastraController.adapter).toBe("@agentproto/adapter-mastra-controller")
  })

  it("declares no static modes and claims streaming and tool calls only", () => {
    // Controller modes come from the manifest at session time (availableModes).
    expect(mastraController.modes ?? []).toEqual([])
    const claimed = Object.entries(mastraController.capabilities ?? {})
      .filter(([, value]) => value === true)
      .map(([key]) => key)
    expect(claimed).toEqual(["streaming", "tool_calls"])
  })

  it("declares the manifest and controller_mode options as env patches", () => {
    expect(mastraController.options?.map(o => [o.id, o.env])).toEqual([
      ["manifest", { AGENTPROTO_MASTRA_CONTROLLER_MANIFEST: "{value}" }],
      ["controller_mode", { AGENTPROTO_MASTRA_CONTROLLER_MODE: "{value}" }],
    ])
  })
})

describe("createAgentCliClient before connect", () => {
  const client = createAgentCliClient(mastraController)

  it("has no session, no modes and nothing to stream", async () => {
    expect(client.sessionId).toBeUndefined()
    expect(client.availableModes).toBeUndefined()
    expect(client.currentModeId).toBeUndefined()
    await expect(client.events()[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })

  it("send() needs a connected session; setSessionMode reports not-connected", async () => {
    await expect(client.send("t1", "hi")).rejects.toThrow(/send\(\) called before connect\(\)/)
    await expect(client.setSessionMode!("plan")).resolves.toEqual({
      applied: false,
      reason: "not-connected",
    })
  })

  it("connect() without a manifest fails naming the option", async () => {
    await expect(
      client.connect({ cwd: "/tmp", env: {}, abortSignal: new AbortController().signal }),
    ).rejects.toThrow(/no manifest\. Set the `manifest` option/)
  })

  it("close() is a no-op", async () => {
    await expect(client.close()).resolves.toBeUndefined()
  })
})
