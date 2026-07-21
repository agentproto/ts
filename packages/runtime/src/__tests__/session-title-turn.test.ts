/**
 * `runAgentTurn` is the single funnel both `sendPrompt` and `enqueuePrompt`
 * pass through (sessions.ts:~1885) — this covers the title-derivation
 * behavior wired in there: set from the first usable prompt, never
 * overwritten after, and durable across a persist/reload cycle.
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"

function instantAgentSession(): AgentSessionLike {
  return {
    sessionId: "instant-session",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

describe("runAgentTurn — derived session title", () => {
  it("sets the title from the first prompt", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    expect(reg.get(desc.id)?.title).toBeUndefined()

    await reg.sendPrompt(desc.id, "Fix the login redirect bug")
    expect(reg.get(desc.id)?.title).toBe("Fix the login redirect bug")
    reg.shutdown()
  })

  it("does not overwrite the title on a second prompt", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })

    await reg.sendPrompt(desc.id, "Fix the login redirect bug")
    expect(reg.get(desc.id)?.title).toBe("Fix the login redirect bug")

    await reg.sendPrompt(desc.id, "Now also add a regression test")
    expect(reg.get(desc.id)?.title).toBe("Fix the login redirect bug")
    reg.shutdown()
  })

  it("keeps a title the session already had, instead of re-deriving it from a later prompt", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    // Simulates a session restored from a snapshot that already carried a
    // title (e.g. set by an earlier prompt before a daemon restart).
    // `reg.get` returns the live descriptor by reference, so this mutation
    // lands on exactly what `runAgentTurn` reads via `rt.desc`.
    const live = reg.get(desc.id)
    expect(live).toBeDefined()
    if (live) live.title = "pre-existing title"

    await reg.sendPrompt(desc.id, "A completely different topic")
    expect(reg.get(desc.id)?.title).toBe("pre-existing title")
    reg.shutdown()
  })

  it("stamps a spawn-supplied title up-front, so the self-heal never sees the initialPrompt", async () => {
    // FIX 1: the spawn path derives the title from the CALLER's ask and hands
    // it to spawnAgent, which lands it on the descriptor BEFORE the composed,
    // role-prefixed `initialPrompt` turn fires. Without the pre-stamp, the
    // self-heal would name the session after that composition's first sentence
    // (the role disposition) instead of the ask.
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
      title: "Fix session auto-titling",
      initialPrompt: "You are the leaf executor. Fix session auto-titling.",
    })
    // The descriptor carries the caller-derived title, not the composed
    // prompt's "You are the leaf executor".
    expect(desc.title).toBe("Fix session auto-titling")
    // Give the fire-and-forget initial turn a tick — it must NOT overwrite.
    await new Promise(res => setTimeout(res, 10))
    expect(reg.get(desc.id)?.title).toBe("Fix session auto-titling")
    reg.shutdown()
  })

  it("flags a spawn label renamedByUser: false so the title can outrank it", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
      label: "auto-title-precedence-fix",
    })
    expect(desc.label).toBe("auto-title-precedence-fix")
    expect(reg.get(desc.id)?.renamedByUser).toBe(false)
    reg.shutdown()
  })

  it("leaves title undefined when the prompt has no usable text", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })

    await reg.sendPrompt(desc.id, [{ type: "image", source: { url: "https://x/y.png" } }])
    expect(reg.get(desc.id)?.title).toBeUndefined()
    reg.shutdown()
  })

  it("survives a persist/reload cycle", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "session-title-persist-"))
    const persistPath = join(tmp, "sessions.json")
    try {
      const reg = createSessionsRegistry({ persistPath })
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: instantAgentSession(),
        adapterSlug: "fake",
      })
      await reg.sendPrompt(desc.id, "Investigate the flaky CI job")
      expect(reg.get(desc.id)?.title).toBe("Investigate the flaky CI job")
      // Sync-flushes the current in-memory snapshot to `persistPath`,
      // bypassing the debounce timer — same as a real daemon shutdown.
      reg.shutdown()

      const reloaded = createSessionsRegistry({ persistPath })
      const reloadedDesc = reloaded.get(desc.id)
      expect(reloadedDesc?.title).toBe("Investigate the flaky CI job")
      reloaded.shutdown()
      // `shutdown()` is sync-by-design (safe to call from a process "exit"
      // handler) but closes the transcript stream fire-and-forget — give
      // its async flush a tick before the tmpdir under it disappears below.
      await new Promise(res => setTimeout(res, 20))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
