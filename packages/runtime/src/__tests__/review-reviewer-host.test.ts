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
  WALLET_EXHAUSTED_COOLDOWN_MS,
  WALLET_RATE_LIMIT_COOLDOWN_MS,
} from "../review-reviewer-host.js"
import { createReviewExecutionShare, type ReviewExecutionShare } from "../review-execution-share.js"
import type { HarnessPreset } from "../harness-preset-store.js"
import type { UserPreset } from "../user-presets.js"

// Control named auth-profile resolution (`access.profileRef`) + the keychain
// reads deterministically, so the exhausted-wallet tests below can spawn
// against a REAL profileRef without touching the real
// `~/.agentproto/auth-profiles.json` or the machine's keychain. Empty by
// default: every other test in this file still sees "no such profile", same
// as the temp HOME it runs under.
const authProfileState = vi.hoisted(() => ({
  profiles: {} as Record<string, import("@agentproto/auth").AuthProfile>,
  keychain: {} as Record<string, string | undefined>,
}))
vi.mock("@agentproto/auth", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/auth")>()
  return {
    ...actual,
    getAuthProfile: vi.fn(async (id: string) => authProfileState.profiles[id]),
    KeychainStore: vi.fn().mockImplementation(() => ({
      read: vi.fn(async ({ path }: { path: string }) => {
        const value = authProfileState.keychain[path]
        return value !== undefined ? { value, kind: "oat" as const } : undefined
      }),
    })),
  }
})

// Real git + subprocesses (+ sessions) per test: the 5s default is too tight
// on a loaded machine or CI runner.
vi.setConfig({ testTimeout: 30_000 })

/** A scripted turn: `say` is the assistant text for the first prompt (a
 *  function sees that prompt), the turn then ends cleanly — or with
 *  `error`. A later prompt that is the host's recovery FOLLOW-UP writes
 *  `writeOnFollowUp` to the verdict path it names (never otherwise). */
interface Scripted {
  say: string | ((prompt: string) => string)
  error?: string
  hang?: boolean
  writeOnFollowUp?: object
  /** Stream events emitted BEFORE `say` (tool calls/results the reviewer "saw"). */
  events?: AgentStreamEvent[]
  /** Assistant text for a FOLLOW-UP prompt instead of the default. */
  followUpSay?: string
  /** The follow-up turn ends in an error with this text. */
  followUpError?: string
}
type Behaviour =
  | "review"
  | "block"
  | "hang"
  | "empty"
  | `error:${string}`
  | `slowerror:${number}:${string}`
  | `slow:${number}`
  | `slowblock:${number}`
  | Scripted

/** Fake adapter session. `review`: write the verdict file the prompt names,
 *  say something, end the turn. `block`: the same, but the verdict is a real
 *  request-changes report. `hang`: never end the turn until closed.
 *  `empty`: end the turn with no output (the auth-failure no-op). */
function fakeReviewerSession(behaviour: Behaviour, seen: string[]): AgentSessionLike {
  let release: (() => void) | undefined
  const closed = new Promise<void>((r) => (release = r))
  return {
    sessionId: "fake-reviewer",
    async *send(message: unknown): AsyncIterable<AgentStreamEvent> {
      const text = typeof message === "string" ? message : JSON.stringify(message)
      seen.push(text)
      if (typeof behaviour === "object") {
        if (/You ended your turn without writing|conflicting verdict/.test(text)) {
          const path = text.match(/write EXACTLY ONE file — (\S+) —/)?.[1]
          if (path && behaviour.writeOnFollowUp) await writeFile(path, JSON.stringify(behaviour.writeOnFollowUp))
          yield { kind: "text-delta", text: `${behaviour.followUpSay ?? "follow-up handled"}\n` }
          if (behaviour.followUpError) {
            yield { kind: "error", error: { message: behaviour.followUpError } }
            yield { kind: "turn-end", reason: "error" }
            return
          }
          yield { kind: "turn-end", reason: "completed" }
          return
        }
        if (behaviour.hang) {
          await closed
          return
        }
        for (const evt of behaviour.events ?? []) yield evt
        yield { kind: "text-delta", text: `${typeof behaviour.say === "function" ? behaviour.say(text) : behaviour.say}\n` }
        if (behaviour.error) {
          yield { kind: "error", error: { message: behaviour.error } }
          yield { kind: "turn-end", reason: "error" }
          return
        }
        yield { kind: "turn-end", reason: "completed" }
        return
      }
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
      const verdictKind: "review" | "block" = behaviour === "block" || behaviour.startsWith("slowblock:") ? "block" : "review"
      if (behaviour.startsWith("slow:") || behaviour.startsWith("slowblock:")) {
        await new Promise((r) => setTimeout(r, Number(behaviour.split(":")[1])))
      }
      const path = text.match(/write EXACTLY ONE file — (\S+) —/)?.[1]
      const report =
        verdictKind === "block"
          ? {
              decision: "request_changes",
              summary: "one high-severity finding",
              findings: [{ severity: "high", title: "breaks it", file: "src/x.ts", line: 1 }],
            }
          : { findings: [] }
      if (path) await writeFile(path, JSON.stringify(report))
      yield { kind: "text-delta", text: verdictKind === "block" ? "blocked\n" : "reviewed\n" }
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
  authProfileState.profiles = {}
  authProfileState.keychain = {}
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

function setup(
  behaviour: Behaviour | Behaviour[],
  laneRetries?: number,
  opts: {
    /** Preset id → auth profileRef, resolved as HARNESS presets (so the
     *  lane really has a profile behind it). */
    harnessProfiles?: Record<string, string>
    /** Clock for the exhausted-wallet cooldowns. */
    now?: () => number
    /** The verdict-recovery model selection. */
    recovery?: import("../review-reviewer-host.js").ReviewRecoveryConfig
  } = {},
) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const eventRing = createEventRing()
  eventRing.wire(sessionEvents)
  const seen: string[] = []
  const spawnedWith: Array<Record<string, unknown>> = []
  // One behaviour per spawn, in order; the last one repeats.
  const script = Array.isArray(behaviour) ? behaviour : [behaviour]
  // A harness preset carries `access.profileRef`, so the spawn core resolves
  // it through the auth store + keychain: back both with a credential-backed
  // anthropic profile, and give the fake adapter the matching billing
  // descriptor, or the spawn is refused (`access_profile_ineligible`).
  for (const [id, profileRef] of Object.entries(opts.harnessProfiles ?? {})) {
    authProfileState.profiles[profileRef] = {
      id: profileRef,
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: `agentproto.test.${profileRef}`,
    }
    authProfileState.keychain[`agentproto.test.${profileRef}`] = `sk-test-${id}`
  }
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
      ...(opts.harnessProfiles ? { authDescriptor: { provider: "anthropic" } } : {}),
    }
  }
  const host = createDaemonReviewerHost({
    registry,
    sessionEvents,
    eventRing,
    resolveAgentAdapter,
    getHarnessPreset: async (id) => {
      const profileRef = opts.harnessProfiles?.[id]
      return profileRef
        ? { id, harnessSlug: "fake", name: id, profileRef, defaultModel: `model-${id}`, isDefault: false }
        : undefined
    },
    getUserPreset: async (id) =>
      id === "broken-rev"
        ? { id, label: id, adapter: "broken" }
        : ["rev", "rev2", "rev3", "rev-openrouter"].includes(id)
          ? { id, label: id, adapter: "fake", model: `model-${id}` }
          : id === "rev3-alias" || id === "rev3-openrouter-alias"
            ? { id, label: id, adapter: "fake", model: "model-rev3" }
            : undefined,
    getAuthProfile: async (id) => ({ id, endpoint: "opencode-go", method: { kind: "api-key" } }) as never,
    ...(laneRetries !== undefined ? { laneRetries } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.recovery ? { getRecovery: () => opts.recovery } : {}),
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
    expect(desc.archived).toBe(true)
    registry.shutdown()
  })

  it("kills a reviewer that exceeds its timeout", async () => {
    const { host, registry } = setup("hang")
    const res = await host.run({ preset: "rev", cwd: home, prompt: "review", label: "review:demo:slow", timeoutMs: 300 })
    expect(res).toMatchObject({ status: "timeout", preset: "rev" })
    if (res.status !== "timeout") throw new Error("expected timeout")
    expect(registry.get(res.sessionId)!.status).toBe("killed")
    expect(registry.get(res.sessionId)!.archived).toBe(true)
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
    expect(res.status === "failed" && res.sessionId && registry.get(res.sessionId)!.archived).toBe(true)
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

  it("archives every reviewer session — failed turns and each retry attempt too", async () => {
    const { host, registry, spawnedWith } = setup([
      "error:Cannot connect to API: The socket connection was closed unexpectedly",
      "empty",
    ])
    const res = await host.run({ preset: "rev", cwd: home, prompt: "review", label: "review:demo:archive", timeoutMs: 10_000 })
    expect(res.status).toBe("failed")
    expect(spawnedWith).toHaveLength(2)
    const sessions = registry.list({ includeArchived: true }).filter((d) => d.label?.startsWith("review:demo:archive"))
    expect(sessions.map((d) => d.label).sort()).toEqual(["review:demo:archive", "review:demo:archive:retry1"])
    for (const d of sessions) {
      expect(d.status).toBe("killed")
      expect(d.archived).toBe(true)
    }
    // Hidden from the default session list.
    expect(registry.list().filter((d) => d.label?.startsWith("review:demo:archive"))).toEqual([])
    registry.shutdown()
  })

  it("archives a reviewer whose session exits on its own", async () => {
    const { host, registry } = setup("review")
    const res = await host.run({ preset: "rev", cwd: home, prompt: "review", label: "review:demo:archive-ended", timeoutMs: 10_000 })
    if (res.status !== "ended") throw new Error("expected ended")
    expect(registry.list().some((d) => d.id === res.sessionId)).toBe(false)
    expect(registry.list({ includeArchived: true }).some((d) => d.id === res.sessionId)).toBe(true)
    registry.shutdown()
  })

  it("keeps the verdict and the session record readable after archiving", async () => {
    const { host, registry } = setup("review")
    const verdictPath = join(home, "verdict-archived.json")
    const res = await host.run({
      preset: "rev",
      cwd: home,
      prompt: `Review it. When done, write EXACTLY ONE file — ${verdictPath} — containing ONLY this JSON`,
      label: "review:demo:readable",
      timeoutMs: 10_000,
    })
    if (res.status !== "ended") throw new Error("expected ended")
    expect(registry.get(res.sessionId)!.archived).toBe(true)
    expect(JSON.parse(await readFile(verdictPath, "utf8"))).toEqual({ findings: [] })
    expect(res.model).toBe("model-rev")
    expect(registry.get(res.sessionId)).toMatchObject({ label: "review:demo:readable", adapterSlug: "fake" })
    registry.shutdown()
  })

  it("an archive that throws never fails the review", async () => {
    const { host, registry } = setup("review")
    const archive = vi.spyOn(registry, "archiveSession").mockImplementation(() => {
      throw new Error("archive refused")
    })
    const verdictPath = join(home, "verdict-archive-error.json")
    const res = await host.run({
      preset: "rev",
      cwd: home,
      prompt: `Review it. When done, write EXACTLY ONE file — ${verdictPath} — containing ONLY this JSON`,
      label: "review:demo:archive-error",
      timeoutMs: 10_000,
    })
    expect(archive).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ status: "ended", preset: "rev" })
    if (res.status !== "ended") throw new Error("expected ended")
    expect(registry.get(res.sessionId)!.status).toBe("killed")
    expect(registry.get(res.sessionId)!.archived).toBeUndefined()
    expect(JSON.parse(await readFile(verdictPath, "utf8"))).toEqual({ findings: [] })
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

describe("createDaemonReviewerHost — an exhausted auth profile is never re-spawned", () => {
  /** The measured failure: OpenCode Go's wallet is spent, so every Go preset
   *  dies with the same "usage limit exceeded" line. */
  const GO_LIMIT = 'error:Go usage limit exceeded [wallet: profile "opencode-go-local"]'
  /** Two Go presets on the SAME wallet, plus a non-Go fallback on another. */
  const GO_PROFILES = { go: "opencode-go-local", go2: "opencode-go-local", fb: "claude-subs-agentik" }
  const lane = (
    host: ReturnType<typeof setup>["host"],
    extra: { preset?: string; fallbackPresets?: string[]; prompt?: string } = {},
  ) =>
    host.run({
      preset: "go",
      cwd: home,
      prompt: "review",
      label: "review:demo:wallet",
      timeoutMs: 10_000,
      ...extra,
    })

  it("lane B spawns NOTHING for a wallet lane A already exhausted — it falls straight through", async () => {
    const { host, registry, spawnedWith } = setup([GO_LIMIT, "review"], undefined, { harnessProfiles: GO_PROFILES })
    const a = await lane(host, { preset: "go", fallbackPresets: ["fb"] })
    expect(a).toMatchObject({ status: "ended", preset: "fb" })
    expect(spawnedWith).toHaveLength(2) // the doomed Go spawn + the fallback

    const b = await lane(host, { preset: "go2", fallbackPresets: ["fb"] })
    expect(b).toMatchObject({ status: "ended", preset: "fb" })
    expect(spawnedWith).toHaveLength(3) // ONLY the fallback — go2 never spawned
    expect(b.fallbacks).toEqual([
      { preset: "go2", error: expect.stringMatching(/^skipped: auth profile 'opencode-go-local' is exhausted until /) },
    ])
    registry.shutdown()
  })

  it("a fallback preset on the SAME exhausted profile is skipped inside one chain", async () => {
    const { host, registry, spawnedWith } = setup([GO_LIMIT, "review"], undefined, { harnessProfiles: GO_PROFILES })
    const res = await lane(host, { preset: "go", fallbackPresets: ["go2", "fb"] })
    expect(res).toMatchObject({ status: "ended", preset: "fb" })
    expect(spawnedWith).toHaveLength(2) // go (failed) + fb; go2 skipped
    expect(res.fallbacks?.map((f) => f.preset)).toEqual(["go", "go2"])
    expect(res.fallbacks?.[1]?.error).toMatch(/skipped: auth profile 'opencode-go-local' is exhausted/)
    registry.shutdown()
  })

  it("after the 15-minute cooldown the profile is tried again", async () => {
    let clock = 1_760_000_000_000
    const { host, registry, spawnedWith } = setup([GO_LIMIT, "review"], undefined, {
      harnessProfiles: GO_PROFILES,
      now: () => clock,
    })
    const first = await lane(host, { preset: "go" })
    expect(first.status).toBe("failed")
    expect(spawnedWith).toHaveLength(1)

    const skipped = await lane(host, { preset: "go2" })
    expect(skipped).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/skipped: auth profile 'opencode-go-local' is exhausted until /),
    })
    expect(spawnedWith).toHaveLength(1) // still nothing new

    clock += WALLET_EXHAUSTED_COOLDOWN_MS + 1
    const after = await lane(host, { preset: "go2" })
    expect(after.status).toBe("ended") // the script's next (last) behaviour is a real review
    expect(spawnedWith).toHaveLength(2)
    registry.shutdown()
  })

  it("a rate limit cools that MODEL down for 60 seconds only", async () => {
    let clock = 1_760_000_000_000
    const { host, registry, spawnedWith } = setup("error:Rate limit exceeded", 0, {
      harnessProfiles: GO_PROFILES,
      now: () => clock,
    })
    const first = await lane(host, { preset: "go" })
    expect(first.status).toBe("failed")
    expect(spawnedWith).toHaveLength(1)

    clock += 30_000 // still inside the 60s cooldown
    const skipped = await lane(host, { preset: "go" }) // the SAME model → skipped
    expect(skipped.status === "failed" && skipped.error).toMatch(
      /skipped: auth profile 'opencode-go-local' \(model 'model-go'\) is exhausted until /,
    )
    expect(spawnedWith).toHaveLength(1)

    clock += WALLET_RATE_LIMIT_COOLDOWN_MS // well past the 60s cooldown → tried again
    const after = await lane(host, { preset: "go" })
    expect(after.status).toBe("failed")
    expect(spawnedWith).toHaveLength(2) // spawned again (and rate-limited again)
    registry.shutdown()
  })

  it("a rate-limited lane retries in the SAME preset — the cooldown it recorded does not eat its own retry", async () => {
    let clock = 1_760_000_000_000
    // `laneRetries: 1`: a rate limit is transient, so the retry must really
    // launch, not fall on the 60s per-model cooldown the failed attempt just
    // wrote and come back `skipped`.
    const { host, registry, spawnedWith } = setup(["error:Rate limit exceeded", "review"], 1, {
      harnessProfiles: GO_PROFILES,
      now: () => clock,
    })
    const a = await lane(host, { preset: "go", fallbackPresets: ["fb"] })
    expect(a).toMatchObject({ status: "ended", preset: "go" })
    expect(spawnedWith).toHaveLength(2) // the rate-limited attempt + its retry
    if (a.status !== "ended") throw new Error("expected ended")
    expect(registry.get(a.sessionId)!.label).toBe("review:demo:wallet:retry1")
    expect(a.fallbacks).toBeUndefined()

    // …but the cooldown it recorded still guards every OTHER lane/preset:
    // a later lane on the same model is skipped without spawning.
    clock += 30_000
    const b = await lane(host, { preset: "go", fallbackPresets: ["fb"] })
    expect(b).toMatchObject({ status: "ended", preset: "fb" })
    expect(spawnedWith).toHaveLength(3) // ONLY the fallback — `go` was skipped
    expect(b.fallbacks).toEqual([
      { preset: "go", error: expect.stringMatching(/^skipped: auth profile 'opencode-go-local' \(model 'model-go'\) is exhausted until /) },
    ])
    // and a sibling model on the same profile was never rate-limited: it
    // still spawns and reviews normally
    const c = await lane(host, { preset: "go2", fallbackPresets: ["fb"] })
    expect(c).toMatchObject({ status: "ended", preset: "go2" })
    expect(spawnedWith).toHaveLength(4)
    expect(c.fallbacks).toBeUndefined()
    registry.shutdown()
  })

  it("a 'context usage limit' is not an exhausted wallet — the profile keeps spawning", async () => {
    let clock = 1_760_000_000_000
    const { host, registry, spawnedWith } = setup(["error:your context usage limit is at 92%", "review"], 0, {
      harnessProfiles: GO_PROFILES,
      now: () => clock,
    })
    const first = await lane(host, { preset: "go" })
    expect(first.status).toBe("failed")
    expect(first.status === "failed" && first.error).toContain("context usage limit")
    expect(spawnedWith).toHaveLength(1)

    // SAME profile, other model: no 15-minute cooldown was recorded, so this
    // spawn is a real review rather than a `skipped:`.
    clock += 1_000
    const second = await lane(host, { preset: "go2" })
    expect(second).toMatchObject({ status: "ended", preset: "go2" })
    expect(second.fallbacks).toBeUndefined()
    expect(spawnedWith).toHaveLength(2)

    // …and the original model is not cooled either.
    const third = await lane(host, { preset: "go" })
    expect(third.status).toBe("ended")
    expect(spawnedWith).toHaveLength(3)
    registry.shutdown()
  })

  it("a rate limit on one model does NOT skip a sibling model on the same profile", async () => {
    let clock = 1_760_000_000_000
    // The real shape: several free Zen models share ONE profile, and lane
    // chains fall back across them on purpose.
    const ZEN_PROFILES = { mimo: "opencode-zen-free", step5: "opencode-zen-free", nemotron: "opencode-zen-free" }
    const { host, registry, spawnedWith } = setup("error:Rate limit exceeded", 0, {
      harnessProfiles: ZEN_PROFILES,
      now: () => clock,
    })
    // nemotron's rate limit lands in ITS per-model bucket…
    const a = await lane(host, { preset: "nemotron" })
    expect(a.status).toBe("failed")
    expect(spawnedWith).toHaveLength(1)

    // …mimo and step5 share the PROFILE but not the bucket: both still spawn
    const b = await lane(host, { preset: "mimo" })
    expect(b.status).toBe("failed")
    const c = await lane(host, { preset: "step5" })
    expect(c.status).toBe("failed")
    expect(spawnedWith).toHaveLength(3)

    // nemotron itself is still skipped inside its 60s window
    clock += 30_000
    const skipped = await lane(host, { preset: "nemotron" })
    expect(skipped.status === "failed" && skipped.error).toMatch(
      /skipped: auth profile 'opencode-zen-free' \(model 'model-nemotron'\) is exhausted until /,
    )
    expect(spawnedWith).toHaveLength(3)

    // …and is tried again once its 60s rate-limit cooldown ends
    clock += WALLET_RATE_LIMIT_COOLDOWN_MS
    await lane(host, { preset: "nemotron" })
    expect(spawnedWith).toHaveLength(4)
    registry.shutdown()
  })

  it("a real block verdict still never falls back", async () => {
    const { host, registry, spawnedWith } = setup(["block", "review"], undefined, { harnessProfiles: GO_PROFILES })
    const verdictPath = join(home, "verdict-block.json")
    const res = await lane(host, {
      preset: "go",
      fallbackPresets: ["fb"],
      prompt: `Review it. When done, write EXACTLY ONE file — ${verdictPath} — containing ONLY this JSON`,
    })
    expect(res).toMatchObject({ status: "ended", preset: "go" })
    expect(res.fallbacks).toBeUndefined()
    expect(spawnedWith).toHaveLength(1)
    const report = JSON.parse(await readFile(verdictPath, "utf8"))
    expect(report).toMatchObject({ decision: "request_changes", findings: [{ severity: "high" }] })
    registry.shutdown()
  })
})

describe("createDaemonReviewerHost — verdict recovery (missing/invalid verdict file at turn end)", () => {
  const REVIEWER_TEXT =
    "I read src/x.ts and the callers. The null check is inverted, so every request crashes (src/x.ts line 4).\n" +
    "Verdict: request changes, one high-severity finding in src/x.ts."
  const LIFTED = { severity: "high", title: "The null check is inverted", detail: "so every request crashes", file: "src/x.ts", line: 4 }
  const recoveredEnvelope = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ status: "recovered", reason: "reviewer reported a blocking finding", findings: [LIFTED], ...over })
  const BLOCK_REPORT = {
    decision: "request_changes",
    summary: "inverted null check",
    findings: [{ severity: "high", title: "Inverted null check", detail: "crashes every request", file: "src/x.ts", line: 4 }],
  }
  const APPROVE_REPORT = { decision: "approve", summary: "Reviewed the whole range; nothing found.", findings: [] }
  const RECOVERY = { presets: ["rev2"] }

  const run = (
    host: ReturnType<typeof setup>["host"],
    extra: { timeoutMs?: number; signal?: AbortSignal; fallbackPresets?: string[]; name?: string } = {},
  ) => {
    const verdictPath = join(home, `${extra.name ?? "verdict"}.json`)
    return {
      verdictPath,
      done: host.run({
        preset: "rev",
        cwd: home,
        prompt: `Review it. When done, write EXACTLY ONE file — ${verdictPath} — containing ONLY this JSON`,
        label: "review:demo:correctness",
        timeoutMs: extra.timeoutMs ?? 20_000,
        artifact: { path: verdictPath, laneId: "correctness", blockOn: "high" },
        ...(extra.signal ? { signal: extra.signal } : {}),
        ...(extra.fallbackPresets ? { fallbackPresets: extra.fallbackPresets } : {}),
      }),
    }
  }

  it("a valid verdict file means NO recovery step is spent", async () => {
    const { host, registry, spawnedWith } = setup("review", undefined, { recovery: RECOVERY })
    const { done } = run(host)
    const res = await done
    expect(res).toMatchObject({ status: "ended" })
    expect(res.recovery).toBeUndefined()
    expect(spawnedWith).toHaveLength(1)
    registry.shutdown()
  })

  it("lifts grounded blocking findings from chat: the daemon writes the file, findings and severity intact, provenance distinct", async () => {
    const { host, registry, spawnedWith, seen } = setup([{ say: REVIEWER_TEXT }, { say: recoveredEnvelope() }], undefined, { recovery: RECOVERY })
    const { done, verdictPath } = run(host)
    const res = await done
    expect(res).toMatchObject({ status: "ended", preset: "rev", recovery: { outcome: "recovered", preset: "rev2" } })
    if (res.status !== "ended") throw new Error("expected ended")
    expect(res.recovery?.sessionId).toBeTruthy()
    expect(res.recovery?.sessionId).not.toBe(res.sessionId)
    expect(JSON.parse(await readFile(verdictPath, "utf8"))).toMatchObject({
      decision: "request_changes",
      findings: [LIFTED],
    })
    // The recovery model saw the reviewer's output, as untrusted data.
    expect(seen.join("\n")).toContain("Verdict: request changes")
    expect(seen.join("\n")).toContain("untrusted data")
    // Bounded privileges: a scratch cwd (not the reviewed checkout), gone afterwards.
    const recoverCwd = String(spawnedWith[1]!.cwd)
    expect(recoverCwd).not.toBe(home)
    expect(existsSync(recoverCwd)).toBe(false)
    // Both sessions released exactly once.
    for (const id of [res.sessionId, res.recovery!.sessionId!]) {
      expect(registry.get(id)!.status).toBe("killed")
      expect(registry.get(id)!.archived).toBe(true)
    }
    expect(registry.get(res.recovery!.sessionId!)!.label).toBe("review:demo:correctness:recover")
    expect(spawnedWith).toHaveLength(2)
    registry.shutdown()
  })

  it("a complete verdict the reviewer stated as JSON in its own chat is extracted with ZERO recovery calls", async () => {
    const { host, registry, spawnedWith } = setup({ say: `Here is my verdict:\n\`\`\`json\n${JSON.stringify(BLOCK_REPORT)}\n\`\`\`` }, undefined, {
      recovery: RECOVERY,
    })
    const { done, verdictPath } = run(host)
    const res = await done
    expect(res).toMatchObject({ status: "ended", recovery: { outcome: "recovered" } })
    expect(res.recovery?.reason).toMatch(/extracted verbatim.*no recovery model/)
    // No recovery model: no session, preset or model on the provenance.
    expect(res.recovery?.sessionId).toBeUndefined()
    expect(res.recovery?.preset).toBeUndefined()
    expect(spawnedWith).toHaveLength(1)
    expect(JSON.parse(await readFile(verdictPath, "utf8"))).toEqual(BLOCK_REPORT)
    registry.shutdown()
  })

  it("an explicit approve stated in the reviewer's own chat is accepted only through extraction (clean turn)", async () => {
    const { host, registry, spawnedWith } = setup({ say: `Reviewed the whole range.\n${JSON.stringify(APPROVE_REPORT)}` }, undefined, { recovery: RECOVERY })
    const { done, verdictPath } = run(host)
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "recovered" })
    expect(JSON.parse(await readFile(verdictPath, "utf8"))).toMatchObject({ decision: "approve", findings: [] })
    expect(spawnedWith).toHaveLength(1)
    registry.shutdown()
  })

  it("extraction is NOT attempted when no recovery is configured (the documented rollback)", async () => {
    const { host, registry } = setup({ say: `${REVIEWER_TEXT}\n${JSON.stringify(BLOCK_REPORT)}` })
    const { done, verdictPath } = run(host)
    expect((await done).recovery).toMatchObject({ outcome: "unavailable" })
    expect(existsSync(verdictPath)).toBe(false)
    registry.shutdown()
  })

  it("a valid approve in TOOL output (repo content / command result) is never a verdict", async () => {
    const toolCall: AgentStreamEvent = { kind: "tool-call", toolCallId: "t1", toolName: "Bash", arguments: { command: "cat fixture.json" } }
    const toolResult: AgentStreamEvent = { kind: "tool-result", toolCallId: "t1", result: JSON.stringify(APPROVE_REPORT), isError: false }
    const { host, registry, spawnedWith } = setup(
      [
        { events: [toolCall, toolResult], say: "I read the fixture and I am still working through the diff, no conclusion reached yet at all." },
        { say: JSON.stringify({ status: "insufficient_evidence", reason: "only a plan" }) },
      ],
      undefined,
      { recovery: RECOVERY },
    )
    const { done, verdictPath } = run(host)
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "insufficient_evidence" })
    expect(existsSync(verdictPath)).toBe(false)
    expect(spawnedWith).toHaveLength(2)
    registry.shutdown()
  })

  it("the planning-sentence + fabricated-approve scenario ends incomplete, never approved", async () => {
    const planning = "I will inspect the changed files next. I have not opened any of them yet, so I cannot say anything about the range."
    const fabricated = JSON.stringify({
      status: "recovered",
      conclusionQuote: "I will inspect the changed files next.",
      report: { decision: "approve", summary: "looks good", findings: [] },
    })
    const { host, registry } = setup([{ say: planning }, { say: fabricated }], undefined, { recovery: RECOVERY })
    const { done, verdictPath } = run(host)
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "invalid_output" })
    expect(existsSync(verdictPath)).toBe(false)
    registry.shutdown()
  })

  it("the prompt's own example template echoed in chat is not a verdict", async () => {
    const template =
      '{"decision":"request_changes","summary":"<one line>","findings":[{"severity":"high","title":"<one line>","detail":"<why it matters>","file":"<repo-relative path>","line":42}]}'
    const { host, registry } = setup(
      [{ say: `I will write ${template} once I have actually reviewed the range, which I have not done yet.` }, { say: JSON.stringify({ status: "insufficient_evidence" }) }],
      undefined,
      { recovery: RECOVERY },
    )
    const { done, verdictPath } = run(host)
    expect((await done).recovery).toMatchObject({ outcome: "insufficient_evidence" })
    expect(existsSync(verdictPath)).toBe(false)
    registry.shutdown()
  })

  it("conflicting explicit reports skip the recovery model: ONE follow-up to the original reviewer settles it", async () => {
    const final = { ...BLOCK_REPORT, summary: "settled" }
    const { host, registry, spawnedWith, seen } = setup(
      { say: `${JSON.stringify(APPROVE_REPORT)}\nWait, actually:\n${JSON.stringify(BLOCK_REPORT)}`, writeOnFollowUp: final },
      undefined,
      { recovery: RECOVERY },
    )
    const { done, verdictPath } = run(host, { timeoutMs: 120_000 })
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "followup" })
    expect(res.recovery?.reason).toMatch(/different verdicts/)
    expect(res.recovery?.sessionId).toBeUndefined()
    expect(spawnedWith).toHaveLength(1)
    expect(seen.filter((t) => /conflicting/.test(t))).toHaveLength(1)
    expect(JSON.parse(await readFile(verdictPath, "utf8")).summary).toBe("settled")
    registry.shutdown()
  })

  it("conflicting explicit reports with no follow-up possible leave the lane incomplete", async () => {
    const { host, registry, spawnedWith } = setup({ say: `${JSON.stringify(APPROVE_REPORT)}\n${JSON.stringify(BLOCK_REPORT)}` }, undefined, { recovery: RECOVERY })
    const { done, verdictPath } = run(host, { timeoutMs: 20_000 })
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "insufficient_evidence" })
    expect(res.recovery?.reason).toMatch(/different verdicts.*no follow-up possible/)
    expect(existsSync(verdictPath)).toBe(false)
    expect(spawnedWith).toHaveLength(1)
    registry.shutdown()
  })

  it("a follow-up that states its verdict in chat is extracted from the follow-up turn", async () => {
    // Reaches the follow-up through the recovery model's needs_followup.
    const withModel = setup(
      [
        { say: "I finished reading src/x.ts and the tests, all analysis is done but I have not summarised.", followUpSay: JSON.stringify(APPROVE_REPORT) },
        { say: JSON.stringify({ status: "needs_followup", reason: "no conclusion" }) },
      ],
      undefined,
      { recovery: RECOVERY },
    )
    const { done, verdictPath } = run(withModel.host, { timeoutMs: 120_000 })
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "followup" })
    expect(JSON.parse(await readFile(verdictPath, "utf8"))).toMatchObject({ decision: "approve" })
    withModel.registry.shutdown()
  })

  it("rejects a recovery reply that cites text the reviewer never wrote", async () => {
    const { host, registry } = setup([{ say: REVIEWER_TEXT }, { say: recoveredEnvelope({ findings: [{ ...LIFTED, title: "The reviewer clearly found an SQL injection" }] }) }], undefined, {
      recovery: RECOVERY,
    })
    const { done, verdictPath } = run(host)
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "invalid_output" })
    expect(res.recovery?.reason).toMatch(/not verbatim/)
    expect(existsSync(verdictPath)).toBe(false)
    registry.shutdown()
  })

  it("the recovery model can never approve — not even with a clean lifecycle and an explicit-sounding report", async () => {
    const reply = JSON.stringify({ status: "recovered", report: { decision: "approve", summary: "ok", findings: [] } })
    const { host, registry } = setup([{ say: REVIEWER_TEXT }, { say: reply }], undefined, { recovery: RECOVERY })
    const { done, verdictPath } = run(host)
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "invalid_output" })
    expect(res.recovery?.reason).toMatch(/never records an approval/)
    expect(existsSync(verdictPath)).toBe(false)
    registry.shutdown()
  })

  it("rejects a finding that names a file the reviewer never mentioned", async () => {
    const { host, registry } = setup([{ say: REVIEWER_TEXT }, { say: recoveredEnvelope({ findings: [{ ...LIFTED, file: "src/other.ts" }] }) }], undefined, {
      recovery: RECOVERY,
    })
    const { done } = run(host)
    expect((await done).recovery?.reason).toMatch(/never mentions/)
    registry.shutdown()
  })

  it("a FAILED reviewer turn keeps the provider error and can recover a block but never an approval", async () => {
    const blockCase = setup([{ say: REVIEWER_TEXT, error: "401 Unauthorized: token expired" }, { say: recoveredEnvelope() }], undefined, { recovery: RECOVERY })
    const blocked = await run(blockCase.host).done
    expect(blocked).toMatchObject({ status: "ended", recovery: { outcome: "recovered" } })
    // The lane result would otherwise read as a normal ended turn.
    expect(blocked.recovery?.reason).toMatch(/reviewer turn failed \(.*401 Unauthorized/)
    blockCase.registry.shutdown()

    // Approve in chat on a failed turn: not extracted; the model cannot approve either.
    const approveChat = setup([{ say: `${REVIEWER_TEXT}\n${JSON.stringify(APPROVE_REPORT)}`, error: "401 Unauthorized: token expired" }, { say: JSON.stringify({ status: "insufficient_evidence" }) }], undefined, {
      recovery: RECOVERY,
    })
    const approve = await run(approveChat.host, { name: "approve" }).done
    if (approve.status !== "failed") throw new Error("expected failed")
    expect(approve.error).toMatch(/401 Unauthorized/)
    expect(approve.recovery).toMatchObject({ outcome: "insufficient_evidence" })
    expect(existsSync(join(home, "approve.json"))).toBe(false)
    approveChat.registry.shutdown()

    const approveReply = JSON.stringify({ status: "recovered", report: { decision: "approve", summary: "fine", findings: [] } })
    const approveCase = setup([{ say: REVIEWER_TEXT, error: "401 Unauthorized: token expired" }, { say: approveReply }], undefined, { recovery: RECOVERY })
    const viaModel = await run(approveCase.host, { name: "approve2" }).done
    expect(viaModel.status).toBe("failed")
    expect(viaModel.recovery).toMatchObject({ outcome: "invalid_output" })
    expect(existsSync(join(home, "approve2.json"))).toBe(false)
    approveCase.registry.shutdown()
  })

  it("a transient error with a retry left is retried, not recovered", async () => {
    const { host, registry, spawnedWith } = setup(
      [{ say: REVIEWER_TEXT, error: "The socket connection was closed unexpectedly" }, "review"],
      undefined,
      { recovery: RECOVERY },
    )
    const { done } = run(host)
    const res = await done
    expect(res).toMatchObject({ status: "ended" })
    expect(res.recovery).toBeUndefined()
    expect(spawnedWith).toHaveLength(2)
    registry.shutdown()
  })

  it("leaves the lane incomplete, with a reason, when no recovery model is configured", async () => {
    const { host, registry, spawnedWith } = setup({ say: REVIEWER_TEXT })
    const { done, verdictPath } = run(host)
    const res = await done
    expect(res).toMatchObject({ status: "ended", recovery: { outcome: "unavailable" } })
    expect(res.recovery?.reason).toMatch(/no recovery model configured/)
    expect(spawnedWith).toHaveLength(1)
    expect(existsSync(verdictPath)).toBe(false)
    registry.shutdown()
  })

  it("keeps the OpenRouter billing guard on the recovery model", async () => {
    const { host, registry, spawnedWith } = setup({ say: REVIEWER_TEXT }, undefined, { recovery: { presets: ["rev-openrouter"] } })
    const res = await run(host).done
    expect(res.recovery).toMatchObject({ outcome: "unavailable" })
    expect(res.recovery?.reason).toMatch(/OpenRouter/)
    expect(spawnedWith).toHaveLength(1)
    registry.shutdown()
  })

  it("spends no model call when the reviewer produced nothing to recover from", async () => {
    const { host, registry, spawnedWith } = setup({ say: "ok" }, undefined, { recovery: RECOVERY })
    const res = await run(host).done
    expect(res.recovery).toMatchObject({ outcome: "reviewer_failed" })
    expect(spawnedWith).toHaveLength(1)
    registry.shutdown()
  })

  it("an invalid (not missing) verdict file is recovered the same way", async () => {
    const { host, registry } = setup(
      [
        { say: `${REVIEWER_TEXT}` },
        { say: recoveredEnvelope() },
      ],
      undefined,
      { recovery: RECOVERY },
    )
    const { done, verdictPath } = run(host, { name: "invalid" })
    await writeFile(verdictPath, "{ not json")
    // The runner removes a stale file before the run; here the file is invalid at turn end.
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "recovered" })
    expect(JSON.parse(await readFile(verdictPath, "utf8")).decision).toBe("request_changes")
    registry.shutdown()
  })

  it("one follow-up to the original reviewer when the recovery model asks, and no second", async () => {
    const followUp = { decision: "request_changes", summary: "s", findings: [{ severity: "high", title: "late", file: "src/x.ts" }] }
    const { host, registry, spawnedWith, seen } = setup(
      [
        { say: "I finished reading src/x.ts and the tests, all analysis is done but I have not summarised.", writeOnFollowUp: followUp },
        { say: JSON.stringify({ status: "needs_followup", reason: "analysis done, no conclusion" }) },
      ],
      undefined,
      { recovery: RECOVERY },
    )
    const { done, verdictPath } = run(host, { timeoutMs: 120_000 })
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "followup" })
    expect(JSON.parse(await readFile(verdictPath, "utf8")).findings[0].title).toBe("late")
    expect(spawnedWith).toHaveLength(2)
    expect(seen.filter((t) => /You ended your turn without writing/.test(t))).toHaveLength(1)
    registry.shutdown()
  })

  it("a follow-up turn that errors keeps its provider error, and an approval it wrote is removed", async () => {
    const { host, registry } = setup(
      [
        {
          say: "I finished reading src/x.ts and the tests, all analysis is done but I have not summarised.",
          writeOnFollowUp: APPROVE_REPORT,
          followUpError: "503 upstream overloaded",
        },
        { say: JSON.stringify({ status: "needs_followup", reason: "analysis done, no conclusion" }) },
      ],
      undefined,
      { recovery: RECOVERY },
    )
    const { done, verdictPath } = run(host, { timeoutMs: 120_000 })
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "reviewer_failed" })
    expect(res.recovery?.reason).toMatch(/failed turn.*503 upstream overloaded/)
    expect(existsSync(verdictPath)).toBe(false)
    registry.shutdown()
  })

  it("a follow-up that errors AFTER writing a blocking verdict keeps the block and the error text", async () => {
    const { host, registry } = setup(
      [
        {
          say: "I finished reading src/x.ts and the tests, all analysis is done but I have not summarised.",
          writeOnFollowUp: BLOCK_REPORT,
          followUpError: "503 upstream overloaded",
        },
        { say: JSON.stringify({ status: "needs_followup", reason: "analysis done, no conclusion" }) },
      ],
      undefined,
      { recovery: RECOVERY },
    )
    const { done, verdictPath } = run(host, { timeoutMs: 120_000 })
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "followup" })
    expect(res.recovery?.reason).toMatch(/503 upstream overloaded/)
    expect(JSON.parse(await readFile(verdictPath, "utf8")).decision).toBe("request_changes")
    registry.shutdown()
  })

  it("a follow-up that still yields no file ends incomplete — one recovery step, one follow-up, nothing more", async () => {
    const { host, registry, spawnedWith, seen } = setup(
      [
        { say: "I finished reading src/x.ts and the tests, all analysis is done but I have not summarised." },
        { say: JSON.stringify({ status: "needs_followup", reason: "analysis done, no conclusion" }) },
      ],
      undefined,
      { recovery: RECOVERY },
    )
    const { done, verdictPath } = run(host, { timeoutMs: 120_000 })
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "insufficient_evidence" })
    expect(existsSync(verdictPath)).toBe(false)
    expect(spawnedWith).toHaveLength(2)
    expect(seen.filter((t) => /You ended your turn without writing/.test(t))).toHaveLength(1)
    registry.shutdown()
  })

  it("never starts a recovery step the original deadline cannot cover", async () => {
    const { host, registry, spawnedWith } = setup({ say: REVIEWER_TEXT }, undefined, { recovery: RECOVERY })
    const res = await run(host, { timeoutMs: 4_000 }).done
    expect(res.recovery).toMatchObject({ outcome: "timeout" })
    expect(spawnedWith).toHaveLength(1)
    registry.shutdown()
  })

  it("cancelling during the recovery step kills the recovery session and leaves the lane incomplete", async () => {
    const { host, registry, spawnedWith } = setup([{ say: REVIEWER_TEXT }, { say: "", hang: true }], undefined, { recovery: RECOVERY })
    const ac = new AbortController()
    const { done, verdictPath } = run(host, { signal: ac.signal })
    await vi.waitFor(() => expect(spawnedWith.length).toBe(2))
    ac.abort()
    const res = await done
    expect(res.recovery).toMatchObject({ outcome: "cancelled" })
    expect(existsSync(verdictPath)).toBe(false)
    const recSessions = registry.list({ includeArchived: true }).filter((d) => String(d.label).endsWith(":recover"))
    expect(recSessions).toHaveLength(1)
    expect(recSessions[0]!.status).toBe("killed")
    expect(recSessions[0]!.archived).toBe(true)
    registry.shutdown()
  })

  it("a recovered conclusion does not advance the fallback chain, and a chain gets ONE recovery step", async () => {
    const { host, registry, spawnedWith } = setup([{ say: REVIEWER_TEXT }, { say: recoveredEnvelope() }, "review"], undefined, {
      recovery: RECOVERY,
    })
    const res = await run(host, { fallbackPresets: ["rev3"] }).done
    expect(res).toMatchObject({ status: "ended", preset: "rev", recovery: { outcome: "recovered" } })
    expect(res.fallbacks).toBeUndefined()
    expect(spawnedWith).toHaveLength(2)
    registry.shutdown()
  })
})

describe("createDaemonReviewerHost — run-scoped sharing of equivalent fallback executions", () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  /** A lane whose primary reviewer cannot be spawned (`broken-rev`, an adapter
   *  the daemon cannot resolve) and so falls back to `fallback`. */
  const lane = (
    host: ReturnType<typeof setup>["host"],
    coordinator: ReviewExecutionShare,
    name: string,
    over: {
      fallback?: string
      key?: string
      timeoutMs?: number
      signal?: AbortSignal
      withArtifact?: boolean
    } = {},
  ) => {
    const verdictPath = join(home, `${name}.verdict.json`)
    return {
      verdictPath,
      done: host.run({
        preset: "broken-rev",
        fallbackPresets: [over.fallback ?? "rev3"],
        cwd: home,
        prompt: `Review it. When done, write EXACTLY ONE file — ${verdictPath} — containing ONLY this JSON`,
        label: `review:demo:${name}`,
        timeoutMs: over.timeoutMs ?? 10_000,
        ...(over.withArtifact === false ? {} : { artifact: { path: verdictPath, laneId: name, blockOn: "high" as const } }),
        share: { coordinator, key: over.key ?? "same-rubric-same-range", laneId: name },
        ...(over.signal ? { signal: over.signal } : {}),
      }),
    }
  }

  it("three lanes converging on one fallback run ONE reviewer; each gets the verdict at its own path, marked as shared", async () => {
    const { host, registry, spawnedWith } = setup("slow:150")
    const coordinator = createReviewExecutionShare()
    const a = lane(host, coordinator, "correctness-a")
    const b = lane(host, coordinator, "correctness-b", { fallback: "rev3-alias" })
    const c = lane(host, coordinator, "correctness-c")
    const [ra, rb, rc] = await Promise.all([a.done, b.done, c.done])

    expect(spawnedWith).toHaveLength(1)
    for (const r of [ra, rb, rc]) expect(r).toMatchObject({ status: "ended" })
    expect(new Set([ra, rb, rc].map((r) => (r.status === "ended" ? r.sessionId : ""))).size).toBe(1)
    for (const lanePath of [a.verdictPath, b.verdictPath, c.verdictPath]) {
      expect(JSON.parse(await readFile(lanePath, "utf8"))).toEqual({ findings: [] })
    }
    const marks = [ra, rb, rc].map((r) => r.sharedExecution)
    expect(marks[0]).toMatchObject({ role: "owner", ownerLane: "correctness-a" })
    expect(marks[1]).toMatchObject({ role: "joiner", ownerLane: "correctness-a" })
    expect(marks[2]).toMatchObject({ role: "joiner", ownerLane: "correctness-a" })
    expect(new Set(marks.map((m) => m?.executionId)).size).toBe(1)
    // Each lane still records its OWN unavailable primary.
    for (const r of [ra, rb, rc]) expect(r.fallbacks).toHaveLength(1)
    expect(coordinator.stats().inFlight).toBe(0)
    registry.shutdown()
  })

  it("a settled BLOCKING verdict is retained for the run: a later lane reuses it without a new reviewer", async () => {
    const { host, registry, spawnedWith } = setup("block")
    const coordinator = createReviewExecutionShare()
    const first = lane(host, coordinator, "correctness-a")
    const r1 = await first.done
    expect(r1).toMatchObject({ status: "ended" })
    const late = lane(host, coordinator, "correctness-b")
    const r2 = await late.done
    expect(spawnedWith).toHaveLength(1)
    expect(r2).toMatchObject({ status: "ended", sharedExecution: { role: "joiner", ownerLane: "correctness-a" } })
    expect(JSON.parse(await readFile(late.verdictPath, "utf8"))).toMatchObject({
      decision: "request_changes",
      findings: [{ severity: "high", title: "breaks it" }],
    })
    registry.shutdown()
  })

  it("a different resolved model, rubric/range key, or no share input never shares", async () => {
    const { host, registry, spawnedWith } = setup("review")
    const coordinator = createReviewExecutionShare()
    await Promise.all([
      lane(host, coordinator, "a", { fallback: "rev3" }).done,
      lane(host, coordinator, "b", { fallback: "rev2" }).done,
      lane(host, coordinator, "c", { fallback: "rev3", key: "claims-rubric" }).done,
    ])
    expect(spawnedWith.map((o) => o.model).sort()).toEqual(["model-rev2", "model-rev3", "model-rev3"])
    registry.shutdown()
  })

  it("keeps the OpenRouter guard for a joiner whose preset NAME trips it, even though the resolved reviewer is identical", async () => {
    const { host, registry, spawnedWith } = setup("slow:150")
    const coordinator = createReviewExecutionShare()
    const owner = lane(host, coordinator, "a", { fallback: "rev3" })
    const named = lane(host, coordinator, "b", { fallback: "rev3-openrouter-alias" })
    const [ra, rb] = await Promise.all([owner.done, named.done])
    expect(ra).toMatchObject({ status: "ended" })
    expect(rb).toMatchObject({ status: "failed" })
    expect(rb.status === "failed" && rb.error).toMatch(/would bill OpenRouter/)
    expect(rb.sharedExecution).toBeUndefined()
    expect(spawnedWith).toHaveLength(1)
    registry.shutdown()
  })

  it("exactly ONE recovery step per shared execution; joiners reuse the recovered verdict and its provenance", async () => {
    const reviewerText =
      "I read src/x.ts and the callers. The null check is inverted, so every request crashes (src/x.ts line 4).\n" +
      "Verdict: request changes, one high-severity finding in src/x.ts."
    const envelope = JSON.stringify({
      status: "recovered",
      reason: "reviewer reported a blocking finding",
      findings: [{ severity: "high", title: "The null check is inverted", detail: "so every request crashes", file: "src/x.ts", line: 4 }],
    })
    const { host, registry, spawnedWith } = setup([{ say: reviewerText }, { say: envelope }], undefined, {
      recovery: { presets: ["rev2"] },
    })
    const coordinator = createReviewExecutionShare()
    const lanes = ["a", "b", "c"].map((n) => lane(host, coordinator, `correctness-${n}`, { timeoutMs: 20_000 }))
    const results = await Promise.all(lanes.map((l) => l.done))
    // One reviewer + one recovery model, not three of each.
    expect(spawnedWith).toHaveLength(2)
    for (const r of results) expect(r).toMatchObject({ status: "ended", recovery: { outcome: "recovered", preset: "rev2" } })
    expect(new Set(results.map((r) => r.recovery?.sessionId)).size).toBe(1)
    for (const l of lanes) {
      expect(JSON.parse(await readFile(l.verdictPath, "utf8"))).toMatchObject({ decision: "request_changes" })
    }
    registry.shutdown()
  })

  it("a shared execution that FAILED is shared only in flight: a later lane starts its own reviewer", async () => {
    const { host, registry, spawnedWith } = setup(["error:unauthorized: bad key", "review"])
    const coordinator = createReviewExecutionShare()
    const first = await lane(host, coordinator, "a").done
    // The chain was only [broken-rev, rev3]; rev3 failed on a permanent error.
    expect(first.status).toBe("failed")
    const second = await lane(host, coordinator, "b").done
    expect(second).toMatchObject({ status: "ended" })
    expect(spawnedWith).toHaveLength(2)
    registry.shutdown()
  })

  it("cancelling every participant kills the single shared reviewer — nothing stranded", async () => {
    const { host, registry, spawnedWith } = setup("hang")
    const coordinator = createReviewExecutionShare()
    const ac = new AbortController()
    const runs = ["a", "b", "c"].map((n) => lane(host, coordinator, n, { signal: ac.signal }).done)
    setTimeout(() => ac.abort(), 250)
    const results = await Promise.all(runs)
    expect(spawnedWith).toHaveLength(1)
    for (const r of results) expect(r.status).toBe("failed")
    for (const d of registry.list({ includeArchived: true })) {
      expect(d.status).toBe("killed")
      expect(d.archived).toBe(true)
    }
    expect(coordinator.stats()).toEqual({ inFlight: 0, retained: 0 })
    registry.shutdown()
  })

  it("cancelling the owner alone leaves the joiner's shared reviewer running", async () => {
    const { host, registry, spawnedWith } = setup("slow:400")
    const coordinator = createReviewExecutionShare()
    const ownerCtl = new AbortController()
    const owner = lane(host, coordinator, "a", { signal: ownerCtl.signal })
    const joiner = lane(host, coordinator, "b")
    setTimeout(() => ownerCtl.abort(), 150)
    const [ro, rj] = await Promise.all([owner.done, joiner.done])
    expect(ro.status).toBe("failed")
    expect(ro.status === "failed" && ro.error).toMatch(/cancelled/)
    expect(rj).toMatchObject({ status: "ended", sharedExecution: { role: "joiner", ownerLane: "a" } })
    expect(spawnedWith).toHaveLength(1)
    registry.shutdown()
  })

  it("a joiner never extends the deadline: it leaves on its own, while the owner's reviewer finishes", async () => {
    const { host, registry } = setup("slow:600")
    const coordinator = createReviewExecutionShare()
    const owner = lane(host, coordinator, "a", { timeoutMs: 10_000 })
    const joiner = lane(host, coordinator, "b", { timeoutMs: 200 })
    const [ro, rj] = await Promise.all([owner.done, joiner.done])
    expect(ro).toMatchObject({ status: "ended" })
    expect(rj).toMatchObject({ status: "failed", sharedExecution: { role: "joiner" } })
    expect(rj.status === "failed" && rj.error).toMatch(/no time left/)
    registry.shutdown()
  })

  it("the owner's timeout is what its joiners see, and the hung reviewer is killed", async () => {
    const { host, registry, spawnedWith } = setup("hang")
    const coordinator = createReviewExecutionShare()
    const owner = lane(host, coordinator, "a", { timeoutMs: 300 })
    await sleep(20)
    const joiner = lane(host, coordinator, "b", { timeoutMs: 5_000 })
    const [ro, rj] = await Promise.all([owner.done, joiner.done])
    expect(ro).toMatchObject({ status: "timeout" })
    expect(rj).toMatchObject({ status: "timeout", sharedExecution: { role: "joiner", ownerLane: "a" } })
    expect(spawnedWith).toHaveLength(1)
    for (const d of registry.list({ includeArchived: true })) expect(d.status).toBe("killed")
    registry.shutdown()
  })

  it("without a share input nothing changes: every lane runs its own reviewer", async () => {
    const { host, registry, spawnedWith } = setup("review")
    const run = (name: string) =>
      host.run({
        preset: "rev3",
        cwd: home,
        prompt: `x ${join(home, name)}`,
        label: `review:demo:${name}`,
        timeoutMs: 10_000,
      })
    await Promise.all([run("a"), run("b")])
    expect(spawnedWith).toHaveLength(2)
    registry.shutdown()
  })
})
