/**
 * Tests for {@link BrainSessionSourcePort} — the bridge from an exported
 * transcript to corpus `ConversationTurn`s. Pure mapping: injected `readSession`
 * in, `ConversationDoc` out.
 */

import { describe, expect, it } from "vitest"
import type { ConversationTurn } from "@agentproto/corpus"
import { BrainSessionSourcePort } from "../session-source-port.js"
import type { ExportedSessionLike } from "../types.js"

function transcript(): ExportedSessionLike {
  return {
    meta: { title: "Fix auth outage" },
    messages: [
      { role: "user", text: "investigate the auth 401s", ts: 1700000000000 },
      { role: "assistant", text: "I found the bug in handle.ts", ts: 1700000001000 },
      { role: "tool", text: "  ", ts: 1700000002000 }, // whitespace — dropped
      { role: "system", text: "", ts: 1700000003000 }, // empty — dropped
      { role: "assistant", text: "fixed it", ts: 1700000004000 },
    ],
  }
}

describe("BrainSessionSourcePort", () => {
  it("flattens transcript messages into conversation turns", async () => {
    const port = new BrainSessionSourcePort({ readSession: async () => transcript() })
    const doc = await port.fetchConversation("sess-abc123")
    expect(doc).not.toBeNull()
    expect(doc!.id).toBe("sess-abc123")
    expect(doc!.title).toBe("Fix auth outage")
    expect(doc!.turns).toEqual([
      { role: "user", text: "investigate the auth 401s", at: "2023-11-14T22:13:20.000Z" },
      { role: "assistant", text: "I found the bug in handle.ts", at: "2023-11-14T22:13:21.000Z" },
      { role: "assistant", text: "fixed it", at: "2023-11-14T22:13:24.000Z" },
    ])
  })

  it("drops the empty system turn and the empty tool row", async () => {
    const port = new BrainSessionSourcePort({ readSession: async () => transcript() })
    const doc = await port.fetchConversation("sess-x")
    expect(doc!.turns.map(t => t.role)).toEqual(["user", "assistant", "assistant"])
  })

  it("returns null when the transcript reader has nothing", async () => {
    const port = new BrainSessionSourcePort({ readSession: async () => null })
    expect(await port.fetchConversation("sess-x")).toBeNull()
  })

  it("returns null when every message has no readable text", async () => {
    const port = new BrainSessionSourcePort({
      readSession: async () => ({
        messages: [
          { role: "tool", text: " " },
          { role: "system", text: "" },
        ],
      }),
    })
    expect(await port.fetchConversation("sess-x")).toBeNull()
  })

  it("coerces a throwing reader to a null (skip, never abort)", async () => {
    const port = new BrainSessionSourcePort({
      readSession: async () => {
        throw new Error("store unreachable")
      },
    })
    expect(await port.fetchConversation("sess-x")).toBeNull()
  })

  it("omits `at` when the message has no usable timestamp", async () => {
    const port = new BrainSessionSourcePort({
      readSession: async () => ({
        messages: [{ role: "user", text: "hi" }],
      }),
    })
    const doc = await port.fetchConversation("sess-x")
    expect(doc!.turns[0]).toEqual({ role: "user", text: "hi" })
  })
})
