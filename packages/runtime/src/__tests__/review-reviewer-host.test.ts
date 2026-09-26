/**
 * `createDaemonReviewerHost` end to end against a REAL sessions registry +
 * event bus + event ring: the reviewer is a child session spawned through
 * `spawnAgentSession` (the `agent_start` core), waited on through
 * `monitorSessionWait`, and killed through `registry.kill` — after a normal
 * turn, on timeout, and on cancel. Only the adapter is fake: its session
 * plays the reviewer by writing the verdict file the prompt names.
 *
 * HOME is pointed at a temp dir so the spawn core's real config/preset reads
 * (config.json, harness-presets.json, auth-profiles.json) see nothing.
 */

import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { createDaemonReviewerHost, resolveReviewerPreset } from "../review-reviewer-host.js"
import type { HarnessPreset } from "../harness-preset-store.js"
import type { UserPreset } from "../user-presets.js"

// Real git + subprocesses (+ sessions) per test: the 5s default is too tight
// on a loaded machine or CI runner.
vi.setConfig({ testTimeout: 30_000 })

type Behaviour = "review" | "hang" | "empty"

/** Fake adapter session. `review`: write the verdict file the prompt names,
 *  say something, end the turn. `hang`: never end the turn until closed.
 *  `empty`: end the turn with no output (the auth-failure no-op). */
function fakeReviewerSession(behaviour: Behaviour, seen: string[]): AgentSessionLike {
  let release: (() => void) | undefined
  const closed = new Promise<void>((r) => (release = r))
  return {
    sessionId: "fake-reviewer",
    async *send(message: unknown): AsyncIterable<AgentStreamEvent> {
      const text = typeof message === "string" ? message : JSON.stringify(message)
      seen.push(text)
      if (behaviour === "hang") {
        await closed
        return
      }
      if (behaviour === "empty") {
        yield { kind: "turn-end", reason: "completed" }
        return
      }
      const path = text.match(/write EXACTLY ONE file — (\S+) —/)?.[1]
      if (path) await writeFile(path, JSON.stringify({ findings: [] }))
      yield { kind: "text-delta", text: "reviewed\n" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {
      release?.()
    },
    async close() {
      release?.()
    },
  }
}

let home: string
let prevHome: string | undefined

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-review-host-"))
  process.env.HOME = home
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

function setup(behaviour: Behaviour) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const eventRing = createEventRing()
  eventRing.wire(sessionEvents)
  const seen: string[] = []
  const spawnedWith: Array<Record<string, unknown>> = []
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    startSession: (async (opts: Record<string, unknown>) => {
      spawnedWith.push(opts)
      return fakeReviewerSession(behaviour, seen)
    }) as any,
    commandPreview: "fake-reviewer",
  })
  const host = createDaemonReviewerHost({
    registry,
    sessionEvents,
    eventRing,
    resolveAgentAdapter,
    getHarnessPreset: async () => undefined,
    getUserPreset: async (id) => (id === "rev" ? { id: "rev", label: "Reviewer", adapter: "fake" } : undefined),
    spawnDeps: {
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    },
  })
  return { host, registry, seen, spawnedWith }
}

describe("createDaemonReviewerHost — child reviewer sessions", () => {
  it("spawns under the preset, waits for the turn, then kills the session", async () => {
    const { host, registry, seen } = setup("review")
    const verdictPath = join(home, "verdict.json")
    const res = await host.run({
      preset: "rev",
      cwd: home,
      prompt: `Review it. When done, write EXACTLY ONE file — ${verdictPath} — containing ONLY this JSON`,
      label: "review:demo:correctness",
      timeoutMs: 10_000,
    })
    expect(res).toMatchObject({ status: "ended", preset: "rev" })
    if (res.status !== "ended") throw new Error("expected ended")
    expect(JSON.parse(await readFile(verdictPath, "utf8"))).toEqual({ findings: [] })
    expect(seen.join("\n")).toContain(verdictPath)
    const desc = registry.get(res.sessionId)!
    expect(desc.label).toBe("review:demo:correctness")
    expect(desc.adapterSlug).toBe("fake")
    expect(desc.status).toBe("killed")
    registry.shutdown()
  })

  it("kills a reviewer that exceeds its timeout", async () => {
    const { host, registry } = setup("hang")
    const res = await host.run({ preset: "rev", cwd: home, prompt: "review", label: "review:demo:slow", timeoutMs: 300 })
    expect(res).toMatchObject({ status: "timeout", preset: "rev" })
    if (res.status !== "timeout") throw new Error("expected timeout")
    expect(registry.get(res.sessionId)!.status).toBe("killed")
    registry.shutdown()
  })

  it("cancel kills the running reviewer through the session lifecycle", async () => {
    const { host, registry } = setup("hang")
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const res = await host.run({
      preset: "rev",
      cwd: home,
      prompt: "review",
      label: "review:demo:cancelled",
      timeoutMs: 10_000,
      signal: ac.signal,
    })
    expect(res).toMatchObject({ status: "failed", error: "review cancelled while the reviewer was running" })
    expect(res.status === "failed" && res.sessionId && registry.get(res.sessionId)!.status).toBe("killed")
    registry.shutdown()
  })

  it("an empty turn is a failed reviewer, not a finished one", async () => {
    const { host, registry } = setup("empty")
    const res = await host.run({ preset: "rev", cwd: home, prompt: "review", label: "review:demo:empty", timeoutMs: 10_000 })
    expect(res).toMatchObject({ status: "failed" })
    expect(res.status === "failed" && res.error).toMatch(/empty turn/)
    registry.shutdown()
  })

  it("an unknown preset fails without spawning anything", async () => {
    const { host, registry, spawnedWith } = setup("review")
    const res = await host.run({ preset: "nope", cwd: home, prompt: "review", label: "review:demo:x", timeoutMs: 1_000 })
    expect(res).toEqual({
      status: "failed",
      preset: "nope",
      error: "preset 'nope' not found — neither a harness preset (harness_preset_list) nor a user preset",
    })
    expect(spawnedWith).toHaveLength(0)
    expect(existsSync(join(home, ".agentproto", "sessions"))).toBe(false)
    registry.shutdown()
  })
})

describe("resolveReviewerPreset", () => {
  const harness: HarnessPreset = {
    id: "kimi",
    harnessSlug: "kimi-cli",
    name: "Kimi",
    profileRef: "moonshot-api",
    defaultModel: "kimi-k2.7-code",
    isDefault: true,
  }
  const user: UserPreset = { id: "kimi", label: "Kimi (user)", adapter: "claude-sdk", model: "kimi-k2.7-code" }

  it("prefers a harness preset: adapter = harness, its model + auth profile", async () => {
    expect(
      await resolveReviewerPreset("kimi", { getHarnessPreset: async () => harness, getUserPreset: async () => user }),
    ).toEqual({ adapter: "kimi-cli", model: "kimi-k2.7-code", access: { profileRef: "moonshot-api" } })
  })

  it("falls back to a user preset, handed to the spawn core as-is", async () => {
    expect(
      await resolveReviewerPreset("kimi", { getHarnessPreset: async () => undefined, getUserPreset: async () => user }),
    ).toEqual({ adapter: "claude-sdk", preset: user })
  })

  it("is undefined when neither store knows the id (or the user preset names no adapter)", async () => {
    expect(
      await resolveReviewerPreset("kimi", { getHarnessPreset: async () => undefined, getUserPreset: async () => undefined }),
    ).toBeUndefined()
    expect(
      await resolveReviewerPreset("kimi", {
        getHarnessPreset: async () => undefined,
        getUserPreset: async () => ({ id: "kimi", label: "no adapter" }),
      }),
    ).toBeUndefined()
  })
})
