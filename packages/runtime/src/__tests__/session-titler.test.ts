/**
 * Coverage for the daemon-side session titler (`session-titler.ts`):
 *
 *   - a generated title renames a default-labelled agent-cli session via
 *     `registry.renameSession`;
 *   - a user-created label (`renamedByUser`, or any non-default label) is
 *     NEVER overwritten;
 *   - a session is title-attempted exactly once (the in-memory guard);
 *   - an LLM failure falls back to the local title (first line of the first
 *     user prompt, 6 whole words);
 *   - non-agent-cli sessions, short first turns, and missing transcripts
 *     are no-ops;
 *   - `sanitizeTitle`/`fallbackTitle` shape guarantees (no mid-word cuts).
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  fallbackTitle,
  maybeTitleSession,
  resetTitledSessions,
  sanitizeTitle,
  type FirstTurnText,
  type TitlerRegistry,
} from "../session-titler.js"

interface FakeDescriptor {
  kind?: string
  label?: string
  title?: string
  renamedByUser?: boolean
}

function fakeRegistry(desc: FakeDescriptor): {
  registry: TitlerRegistry
  renames: { label?: string | null }[]
} {
  const renames: { label?: string | null }[] = []
  const registry: TitlerRegistry = {
    get: () => desc,
    renameSession: (_id, patch) => {
      renames.push(patch)
      if (typeof patch.label === "string") desc.label = patch.label
      return desc as never
    },
  }
  return { registry, renames }
}

const LONG_TURN: FirstTurnText = {
  userText: "Review gate state for PR #261 on the auth-hub worktree and report findings",
  assistantText: "Checked the failing checks, traced the regression to the merge gate guard.",
}

beforeEach(() => {
  resetTitledSessions()
})

describe("maybeTitleSession", () => {
  it("generates a title and renames a default-labelled session", async () => {
    const { registry, renames } = fakeRegistry({ kind: "agent-cli", label: "chat-starter-autoprompt" })
    const title = await maybeTitleSession(registry, "s1", {
      readFirstTurn: async () => LONG_TURN,
      generate: async () => "Gate review PR #261 auth-hub",
      minChars: 100,
    })
    expect(title).toBe("Gate review PR #261 auth-hub")
    expect(renames).toEqual([{ label: "Gate review PR #261 auth-hub" }])
  })

  it("never overwrites a user-created label", async () => {
    const { registry, renames } = fakeRegistry({
      kind: "agent-cli",
      label: "my important session",
      renamedByUser: true,
    })
    const title = await maybeTitleSession(registry, "s2", {
      readFirstTurn: async () => LONG_TURN,
      generate: async () => "Generated Title Here",
    })
    expect(title).toBeNull()
    expect(renames).toEqual([])
  })

  it("keeps a non-default spawner label too (not only renamedByUser)", async () => {
    const { registry, renames } = fakeRegistry({ kind: "agent-cli", label: "ops-watchdog" })
    const title = await maybeTitleSession(registry, "s3", {
      readFirstTurn: async () => LONG_TURN,
      generate: async () => "Generated Title Here",
    })
    expect(title).toBeNull()
    expect(renames).toEqual([])
  })

  it("titles at most once per session", async () => {
    const { registry, renames } = fakeRegistry({ kind: "agent-cli", label: "chat-starter" })
    let reads = 0
    const opts = {
      readFirstTurn: async () => {
        reads += 1
        return LONG_TURN
      },
      generate: async () => "Once Only Title",
      minChars: 100,
    }
    await maybeTitleSession(registry, "s4", opts)
    await maybeTitleSession(registry, "s4", opts)
    expect(reads).toBe(1)
    expect(renames).toEqual([{ label: "Once Only Title" }])
  })

  it("falls back to the local title when the LLM fails", async () => {
    const { registry, renames } = fakeRegistry({ kind: "agent-cli", label: "agentproto" })
    const title = await maybeTitleSession(registry, "s5", {
      readFirstTurn: async () => LONG_TURN,
      generate: async () => undefined,
      minChars: 100,
    })
    expect(title).toBe(fallbackTitle(LONG_TURN.userText))
    expect(title).toBe("Review gate state for PR #261")
    expect(renames).toEqual([{ label: title }])
  })

  it("no-ops for a non-agent-cli session", async () => {
    const { registry, renames } = fakeRegistry({ kind: "terminal", label: "chat-starter" })
    const title = await maybeTitleSession(registry, "s6", {
      readFirstTurn: async () => LONG_TURN,
      generate: async () => "Terminal Title",
    })
    expect(title).toBeNull()
    expect(renames).toEqual([])
  })

  it("no-ops when the first turn is too short", async () => {
    const { registry, renames } = fakeRegistry({ kind: "agent-cli", label: "chat-starter" })
    const title = await maybeTitleSession(registry, "s7", {
      readFirstTurn: async () => ({ userText: "hi", assistantText: "ok" }),
      generate: async () => "Short Turn Title",
      minChars: 200,
    })
    expect(title).toBeNull()
    expect(renames).toEqual([])
  })

  it("no-ops when the transcript has no user-prompt", async () => {
    const { registry, renames } = fakeRegistry({ kind: "agent-cli", label: "chat-starter" })
    const title = await maybeTitleSession(registry, "s8", {
      readFirstTurn: async () => null,
      generate: async () => "Missing Turn Title",
    })
    expect(title).toBeNull()
    expect(renames).toEqual([])
  })
})

describe("title shaping", () => {
  it("sanitizeTitle strips markup and caps at 8 words", () => {
    expect(sanitizeTitle('  "Gate review, PR #261 — auth hub." ')).toBe(
      "Gate review PR #261 auth hub",
    )
    expect(sanitizeTitle("`One Two Three Four Five Six Seven Eight Nine Ten`")).toBe(
      "One Two Three Four Five Six Seven Eight",
    )
    expect(sanitizeTitle("   ")).toBeUndefined()
    expect(sanitizeTitle(undefined)).toBeUndefined()
  })

  it("fallbackTitle truncates to 6 whole words across the first line", () => {
    expect(fallbackTitle("one two three four five six seven eight")).toBe(
      "one two three four five six",
    )
    expect(fallbackTitle("first line\nsecond line")).toBe("first line")
    expect(fallbackTitle("\n\n   \nreal prompt here")).toBe("real prompt here")
    expect(fallbackTitle("")).toBe("")
  })
})