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
import {
  createDaemonReviewerHost,
  isRetryableTurnError,
  resolveReviewerPreset,
  reviewerOpenRouterViolation,
} from "../review-reviewer-host.js"
import type { HarnessPreset } from "../harness-preset-store.js"
import type { UserPreset } from "../user-presets.js"

// Real git + subprocesses (+ sessions) per test: the 5s default is too tight
// on a loaded machine or CI runner.
vi.setConfig({ testTimeout: 30_000 })

type Behaviour = "review" | "hang" | "empty" | `error:${string}` | `slowerror:${number}:${string}`

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
      if (behaviour.startsWith("slowerror:")) {
        const [, ms, ...msg] = behaviour.split(":")
        await new Promise((r) => setTimeout(r, Number(ms)))
        yield { kind: "error", error: { message: msg.join(":") } }
        yield { kind: "turn-end", reason: "error" }
        return
      }
      if (behaviour.startsWith("error:")) {
        yield { kind: "error", error: { message: behaviour.slice("error:".length) } }
        yield { kind: "turn-end", reason: "error" }
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

function setup(behaviour: Behaviour | Behaviour[], laneRetries?: number) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const eventRing = createEventRing()
  eventRing.wire(sessionEvents)
  const seen: string[] = []
  const spawnedWith: Array<Record<string, unknown>> = []
  // One behaviour per spawn, in order; the last one repeats.
  const script = Array.isArray(behaviour) ? behaviour : [behaviour]
  const resolveAgentAdapter: AgentAdapterResolver = async (slug) => {
    // `broken` is an adapter the daemon cannot resolve → a spawn failure.
    if (slug === "broken") return undefined as never
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startSession: (async (opts: Record<string, unknown>) => {
        const next = script[Math.min(spawnedWith.length, script.length - 1)]!
        spawnedWith.push(opts)
        return fakeReviewerSession(next, seen)
      }) as any,
      commandPreview: "fake-reviewer",
    }
  }
  const host = createDaemonReviewerHost({
    registry,
    sessionEvents,
    eventRing,
    resolveAgentAdapter,
    getHarnessPreset: async () => undefined,
    getUserPreset: async (id) =>
      id === "broken-rev"
        ? { id, label: id, adapter: "broken" }
        : ["rev", "rev2", "rev3", "rev-openrouter"].includes(id)
          ? { id, label: id, adapter: "fake", model: `model-${id}` }
          : undefined,
    ...(laneRetries !== undefined ? { laneRetries } : {}),
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

  it("retries a lane whose turn dies on a dropped socket, in a fresh session", async () => {
    const { host, registry, spawnedWith } = setup([
      "error:Cannot connect to API: The socket connection was closed unexpectedly",
      "review",
    ])
    const verdictPath = join(home, "verdict-retry.json")
    const res = await host.run({
      preset: "rev",
      cwd: home,
      prompt: `Review it. When done, write EXACTLY ONE file — ${verdictPath} — containing ONLY this JSON`,
      label: "review:demo:flaky",
      timeoutMs: 10_000,
    })
    expect(res).toMatchObject({ status: "ended", preset: "rev" })
    expect(spawnedWith).toHaveLength(2)
    if (res.status !== "ended") throw new Error("expected ended")
    expect(registry.get(res.sessionId)!.label).toBe("review:demo:flaky:retry1")
    expect(JSON.parse(await readFile(verdictPath, "utf8"))).toEqual({ findings: [] })
    registry.shutdown()
  })

  it("reports the adapter's own error once the retries are spent — no auth-failure filler", async () => {
    const { host, registry, spawnedWith } = setup("error:The socket connection was closed unexpectedly")
    const res = await host.run({ preset: "rev", cwd: home, prompt: "review", label: "review:demo:down", timeoutMs: 10_000 })
    expect(spawnedWith).toHaveLength(2)
    expect(res.status).toBe("failed")
    const error = res.status === "failed" ? res.error : ""
    expect(error).toContain("The socket connection was closed unexpectedly")
    expect(error).toContain("after 2 attempts")
    expect(error).not.toMatch(/auth failure/)
    registry.shutdown()
  })

  it("honours laneRetries (0 disables, 2 allows a third attempt)", async () => {
    const off = setup("error:socket hang up", 0)
    const offRes = await off.host.run({ preset: "rev", cwd: home, prompt: "review", label: "review:demo:off", timeoutMs: 10_000 })
    expect(off.spawnedWith).toHaveLength(1)
    expect(offRes.status === "failed" && offRes.error).not.toMatch(/attempts/)
    off.registry.shutdown()

    const three = setup(["error:socket hang up", "error:socket hang up", "review"], 2)
    const threeRes = await three.host.run({ preset: "rev", cwd: home, prompt: "review", label: "review:demo:three", timeoutMs: 10_000 })
    expect(three.spawnedWith).toHaveLength(3)
    expect(threeRes.status).toBe("ended")
    three.registry.shutdown()

    const spent = setup("error:socket hang up", 2)
    const spentRes = await spent.host.run({ preset: "rev", cwd: home, prompt: "review", label: "review:demo:spent", timeoutMs: 10_000 })
    expect(spent.spawnedWith).toHaveLength(3)
    expect(spentRes.status === "failed" && spentRes.error).toContain("after 3 attempts")
    spent.registry.shutdown()
  })

  it("never retries a permanent error (auth, quota, unknown model)", async () => {
    for (const message of ["401 Unauthorized: invalid API key", "Go usage limit exceeded", "model foo-9 not found"]) {
      const { host, registry, spawnedWith } = setup(`error:${message}`)
      const res = await host.run({ preset: "rev", cwd: home, prompt: "review", label: "review:demo:perm", timeoutMs: 10_000 })
      expect(spawnedWith).toHaveLength(1)
      expect(res.status === "failed" && res.error).toContain(message)
      expect(res.status === "failed" && res.error).not.toMatch(/attempts/)
      registry.shutdown()
    }
  })

  it("an empty turn is not retried either", async () => {
    const { host, registry, spawnedWith } = setup("empty")
    await host.run({ preset: "rev", cwd: home, prompt: "review", label: "review:demo:empty2", timeoutMs: 10_000 })
    expect(spawnedWith).toHaveLength(1)
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

describe("isRetryableTurnError", () => {
  it("retries transport and provider hiccups, and errors with no text", () => {
    for (const m of [
      "Cannot connect to API: The socket connection was closed unexpectedly",
      "ECONNRESET",
      "fetch failed",
      "503 Service Unavailable",
      "429 Too Many Requests",
      "Overloaded",
      undefined,
    ]) {
      expect(isRetryableTurnError(m)).toBe(true)
    }
  })

  it("does not retry credentials, quota or model errors", () => {
    for (const m of [
      "401 Unauthorized",
      "403 Forbidden",
      "Authentication required",
      "invalid api key",
      "Go usage limit exceeded",
      "You exceeded your current quota",
      "model foo not found",
    ]) {
      expect(isRetryableTurnError(m)).toBe(false)
    }
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

describe("review lanes never bill OpenRouter (fail closed)", () => {
  const noProfile = async () => undefined

  it("refuses a harness preset whose auth profile bills the openrouter endpoint, without spawning", async () => {
    const registry = createSessionsRegistry()
    const spawnedWith: unknown[] = []
    const host = createDaemonReviewerHost({
      registry,
      sessionEvents: createSessionEventBus(),
      eventRing: createEventRing(),
      resolveAgentAdapter: (async () => {
        spawnedWith.push(1)
        throw new Error("must not spawn")
      }) as AgentAdapterResolver,
      getHarnessPreset: async () => ({
        id: "rev-or",
        harnessSlug: "opencode",
        name: "rev",
        profileRef: "some-profile",
        defaultModel: "glm-5.3-flash",
        isDefault: false,
      }),
      getUserPreset: async () => undefined,
      getAuthProfile: async (id) => ({ id, endpoint: "openrouter", method: { kind: "api-key" } }) as never,
    })
    const res = await host.run({ preset: "rev-or", cwd: "/tmp", prompt: "x", label: "review:x:y", timeoutMs: 1_000 })
    expect(res.status).toBe("failed")
    expect(res.status === "failed" && res.error).toMatch(/would bill OpenRouter/)
    expect(spawnedWith).toHaveLength(0)
    registry.shutdown()
  })

  it("flags an openrouter/* model, an openrouter profile id, and an openrouter preset id", async () => {
    expect(await reviewerOpenRouterViolation("p", { adapter: "opencode", model: "openrouter/z-ai/glm-5.3-flash" }, noProfile)).toMatch(/model/)
    expect(await reviewerOpenRouterViolation("p", { adapter: "opencode", access: { profileRef: "openrouter-env" } }, noProfile)).toMatch(/auth profile/)
    expect(await reviewerOpenRouterViolation("opencode-default-openrouter", { adapter: "opencode" }, noProfile)).toMatch(/preset/)
  })

  it("fails closed when the auth profile lookup throws", async () => {
    const boom = async () => {
      throw new Error("disk error")
    }
    expect(await reviewerOpenRouterViolation("p", { adapter: "opencode", access: { profileRef: "x" } }, boom)).toMatch(/could not read auth profile/)
  })

  it("checks a user preset's own model + profile", async () => {
    const preset: UserPreset = { id: "u", label: "u", adapter: "opencode", model: "openrouter/x/y" }
    expect(await reviewerOpenRouterViolation("u", { adapter: "opencode", preset }, noProfile)).toMatch(/model/)
  })

  it("lets opencode-go and Claude-subscription lanes through", async () => {
    const lookup = async (id: string) => ({ id, endpoint: id === "claude-subs-agentik" ? "anthropic" : "opencode-go" }) as never
    expect(
      await reviewerOpenRouterViolation(
        "opencode-default-go",
        { adapter: "opencode", model: "opencode-go/longcat-2.5-preview-free", access: { profileRef: "opencode-go-local" } },
        lookup,
      ),
    ).toBeUndefined()
    expect(
      await reviewerOpenRouterViolation("claude-sub", { adapter: "claude-code", access: { profileRef: "claude-subs-agentik" } }, lookup),
    ).toBeUndefined()
  })
})

describe("createDaemonReviewerHost — fallbackPresets", () => {
  const run = (
    host: ReturnType<typeof setup>["host"],
    extra: { preset?: string; fallbackPresets?: string[]; timeoutMs?: number; signal?: AbortSignal; prompt?: string } = {},
  ) =>
    host.run({
      preset: "rev",
      fallbackPresets: ["rev2"],
      cwd: home,
      prompt: "review",
      label: "review:demo:chain",
      timeoutMs: 10_000,
      ...extra,
    })
  const modelsSpawned = (spawnedWith: Array<Record<string, unknown>>) => spawnedWith.map((o) => o.model)

  it("falls back after the primary's turn ends in an error, and records the winner + the unavailable primary", async () => {
    const { host, registry, spawnedWith } = setup(["error:401 Unauthorized: invalid API key", "review"])
    const verdictPath = join(home, "verdict-fb.json")
    const res = await run(host, {
      prompt: `Review it. When done, write EXACTLY ONE file — ${verdictPath} — containing ONLY this JSON`,
    })
    expect(res.status).toBe("ended")
    if (res.status !== "ended") throw new Error("expected ended")
    expect(res.preset).toBe("rev2")
    expect(res.model).toBe("model-rev2")
    expect(res.fallbacks).toEqual([
      { preset: "rev", error: expect.stringContaining("401 Unauthorized: invalid API key") },
    ])
    expect(modelsSpawned(spawnedWith)).toEqual(["model-rev", "model-rev2"])
    expect(registry.get(res.sessionId)!.label).toBe("review:demo:chain:fallback1")
    expect(JSON.parse(await readFile(verdictPath, "utf8"))).toEqual({ findings: [] })
    registry.shutdown()
  })

  it("runs the per-preset retries on each preset before moving on", async () => {
    const { host, registry, spawnedWith } = setup([
      "error:socket hang up",
      "error:socket hang up",
      "error:socket hang up",
      "review",
    ])
    const res = await run(host)
    expect(res.status).toBe("ended")
    expect(modelsSpawned(spawnedWith)).toEqual(["model-rev", "model-rev", "model-rev2", "model-rev2"])
    expect(res.fallbacks).toEqual([{ preset: "rev", error: expect.stringContaining("after 2 attempts") }])
    registry.shutdown()
  })

  it("falls back after an empty turn", async () => {
    const { host, registry, spawnedWith } = setup(["empty", "review"])
    const res = await run(host)
    expect(res).toMatchObject({ status: "ended", preset: "rev2" })
    expect(res.fallbacks).toEqual([{ preset: "rev", error: expect.stringMatching(/empty turn/) }])
    expect(spawnedWith).toHaveLength(2)
    registry.shutdown()
  })

  it("falls back after a spawn failure", async () => {
    const { host, registry, spawnedWith } = setup("review")
    const res = await run(host, { preset: "broken-rev" })
    expect(res).toMatchObject({ status: "ended", preset: "rev2" })
    expect(res.fallbacks).toEqual([{ preset: "broken-rev", error: expect.stringMatching(/reviewer spawn failed \(adapter_not_found\)/) }])
    expect(spawnedWith).toHaveLength(1)
    registry.shutdown()
  })

  it("walks the whole chain in order", async () => {
    const { host, registry, spawnedWith } = setup(["empty", "empty", "review"])
    const res = await run(host, { fallbackPresets: ["rev2", "rev3"] })
    expect(res).toMatchObject({ status: "ended", preset: "rev3" })
    expect(res.fallbacks?.map((f) => f.preset)).toEqual(["rev", "rev2"])
    expect(modelsSpawned(spawnedWith)).toEqual(["model-rev", "model-rev2", "model-rev3"])
    registry.shutdown()
  })

  it("never falls back once the primary produced a verdict (the secondary is never spawned)", async () => {
    const { host, registry, spawnedWith } = setup(["review", "review"])
    const res = await run(host)
    expect(res).toMatchObject({ status: "ended", preset: "rev" })
    expect(res.fallbacks).toBeUndefined()
    expect(spawnedWith).toHaveLength(1)
    registry.shutdown()
  })

  it("never falls back on a timeout", async () => {
    const { host, registry, spawnedWith } = setup(["hang", "review"])
    const res = await run(host, { timeoutMs: 300 })
    expect(res).toMatchObject({ status: "timeout", preset: "rev" })
    expect(res.fallbacks).toBeUndefined()
    expect(spawnedWith).toHaveLength(1)
    registry.shutdown()
  })

  it("never falls back on a cancel", async () => {
    const { host, registry, spawnedWith } = setup(["hang", "review"])
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const res = await run(host, { signal: ac.signal })
    expect(res).toMatchObject({ status: "failed", error: "review cancelled while the reviewer was running" })
    expect(spawnedWith).toHaveLength(1)
    registry.shutdown()
  })

  it("does not fall back from a primary preset that does not exist", async () => {
    const { host, registry, spawnedWith } = setup("review")
    const res = await run(host, { preset: "nope" })
    expect(res).toMatchObject({ status: "failed", preset: "nope", error: expect.stringMatching(/preset 'nope' not found/) })
    expect(spawnedWith).toHaveLength(0)
    registry.shutdown()
  })

  it("does not fall back from an OpenRouter refusal on the primary, and an OpenRouter fallback is refused too", async () => {
    const primary = setup("review")
    const res1 = await run(primary.host, { preset: "rev-openrouter" })
    expect(res1).toMatchObject({ status: "failed", preset: "rev-openrouter", error: expect.stringMatching(/would bill OpenRouter/) })
    expect(res1.fallbacks).toBeUndefined()
    expect(primary.spawnedWith).toHaveLength(0)
    primary.registry.shutdown()

    const fallback = setup(["empty", "review"])
    const res2 = await run(fallback.host, { fallbackPresets: ["rev-openrouter"] })
    expect(res2).toMatchObject({ status: "failed", preset: "rev-openrouter", error: expect.stringMatching(/would bill OpenRouter/) })
    expect(res2.fallbacks).toEqual([{ preset: "rev", error: expect.stringMatching(/empty turn/) }])
    expect(fallback.spawnedWith).toHaveLength(1)
    fallback.registry.shutdown()
  })

  it("an exhausted chain fails listing every preset and its error", async () => {
    const { host, registry, spawnedWith } = setup(["error:401 Unauthorized", "empty"])
    const res = await run(host)
    expect(res.status).toBe("failed")
    if (res.status !== "failed") throw new Error("expected failed")
    expect(res.preset).toBe("rev2")
    expect(res.error).toMatch(/every reviewer in the chain was unavailable/)
    expect(res.error).toContain("'rev': reviewer's turn ended with reason 'error': 401 Unauthorized")
    expect(res.error).toMatch(/'rev2': reviewer produced an empty turn/)
    expect(res.fallbacks?.map((f) => f.preset)).toEqual(["rev"])
    expect(spawnedWith).toHaveLength(2)
    registry.shutdown()
  })

  it("without fallbackPresets an unavailable reviewer fails exactly as before", async () => {
    const { host, registry } = setup("empty")
    const res = await run(host, { fallbackPresets: [] })
    expect(res.status === "failed" && res.error).toMatch(/^reviewer produced an empty turn/)
    expect(res.fallbacks).toBeUndefined()
    registry.shutdown()
  })

  it("shares ONE deadline across the chain", async () => {
    const { host, registry } = setup(["slowerror:600:401 Unauthorized", "hang"], 0)
    const started = Date.now()
    const res = await run(host, { timeoutMs: 1_000 })
    const elapsed = Date.now() - started
    expect(res).toMatchObject({ status: "timeout", preset: "rev2" })
    expect(res.fallbacks?.map((f) => f.preset)).toEqual(["rev"])
    // A fresh per-preset timer would take ~1600ms.
    expect(elapsed).toBeLessThan(1_450)
    registry.shutdown()
  })
})
