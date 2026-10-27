import { describe, expect, it } from "vitest"
import { bridgeCallerUrl } from "../commands/mcp-bridge.logic.js"

const base = "http://127.0.0.1:18790/mcp?token=test&denyTools=agent_kill"

describe("bridge caller identity", () => {
  it.each([
    { "x-codex-turn-metadata": { thread_id: "chat-a", turn_id: "turn-1" } },
    { "x-codex-turn-metadata": JSON.stringify({ thread_id: "chat-a" }) },
    { "openai/threadId": "chat-a" },
    { thread: { id: "chat-a" } },
  ])("derives a namespaced external caller from per-call thread metadata: %j", meta => {
    const url = new URL(bridgeCallerUrl(base, meta, "codex-mcp-client"))
    expect(url.searchParams.get("callerSessionId")).toBe("codex:chat-a")
    expect(url.searchParams.get("host")).toBe("codex")
    expect(url.searchParams.get("token")).toBe("test")
    expect(url.searchParams.get("denyTools")).toBe("agent_kill")
  })

  it.each([undefined, {}, { "x-codex-turn-metadata": "{" }, { threadId: "../bad" }, { threadId: "" }, { threadId: "a".repeat(123) }])(
    "does not invent a caller from absent or malformed metadata: %j", meta => {
      expect(bridgeCallerUrl(base, meta, "codex")).toBe(base)
    },
  )

  it("never caches a previous chat's identity", () => {
    expect(new URL(bridgeCallerUrl(base, { threadId: "a" }, "codex")).searchParams.get("callerSessionId")).toBe("codex:a")
    expect(new URL(bridgeCallerUrl(base, { threadId: "b" }, "codex")).searchParams.get("callerSessionId")).toBe("codex:b")
    expect(bridgeCallerUrl(base, undefined, "codex")).toBe(base)
  })

  it("preserves an explicit self-mount identity and the approval-cards boundary", () => {
    for (const url of [`${base}&callerSessionId=existing`, `${base}&surface=approval-cards`]) {
      expect(bridgeCallerUrl(url, { threadId: "another" }, "codex")).toBe(url)
    }
  })

  it("does not assign another host's generic thread metadata to Codex", () => {
    expect(bridgeCallerUrl(base, { threadId: "a" }, "cursor")).toBe(base)
    expect(bridgeCallerUrl(base, { thread: { id: "a" } })).toBe(base)
  })
})
