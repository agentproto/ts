import { describe, expect, it } from "vitest"
import { createAgentCliClient, mastraController, NotImplementedYetError } from "../index.js"

describe("mastraController (defineHarness)", () => {
  it("is the proprietary mastra-controller arm, served by this package", () => {
    expect(mastraController.id).toBe("mastra-controller")
    expect(mastraController.protocol).toBe("proprietary")
    expect(mastraController.adapter).toBe("@agentproto/adapter-mastra-controller")
  })

  it("declares no modes and claims no capability yet", () => {
    expect(mastraController.modes ?? []).toEqual([])
    for (const value of Object.values(mastraController.capabilities ?? {})) {
      expect(value).toBe(false)
    }
  })
})

describe("createAgentCliClient (scaffold)", () => {
  const client = createAgentCliClient(mastraController)

  it("has no session", () => {
    expect(client.sessionId).toBeUndefined()
  })

  it("throws not implemented yet (E48 PR 2) on every live-controller call", async () => {
    await expect(client.connect({ cwd: "/tmp", env: {} } as never)).rejects.toThrow(
      /connect\(\) is not implemented yet \(E48 PR 2\)/,
    )
    await expect(client.send("t1", "hi")).rejects.toBeInstanceOf(NotImplementedYetError)
    await expect(client.cancel("t1")).rejects.toThrow(/not implemented yet \(E48 PR 2\)/)
    await expect(client.events()[Symbol.asyncIterator]().next()).rejects.toThrow(
      /events\(\) is not implemented yet \(E48 PR 2\)/,
    )
  })

  it("close() is a no-op", async () => {
    await expect(client.close()).resolves.toBeUndefined()
  })
})
