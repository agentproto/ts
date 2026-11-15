/**
 * The turnRetry controller writes the account circuit breaker: a turn that ends
 * in a usage cap closes the profile the session was billed to (until the
 * provider's own reset, else a strike backoff), a clean turn reopens it, and a
 * per-IP free-tier cap or a plain rate limit never touches the account.
 *
 * Hermetic: real registry + event bus, scripted adapter sessions, a temp-dir
 * health store.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createTurnRetryController } from "../turn-retry.js"
import { resolveTurnRetryPolicy } from "../turn-retry-policy.js"
import { createAccountHealthStore } from "../account-health.js"

const T0 = Date.parse("2026-11-15T10:00:00Z")
const H = 3_600_000

const GO_WEEKLY =
  "AI_APICallError: OpenCode Go usage limit reached (weekly, resets in 1d 9h). To keep going now, turn on Extra Usage or upgrade to Go Plus at https://opencode.ai/console/org_X/go."
const GO_NO_TIME = "Go usage limit exceeded"
const FREE_CAP =
  "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const fail = (message: string): AgentStreamEvent[] => [
  { kind: "error", error: { message } },
  { kind: "turn-end", reason: "error" },
]
const ok: AgentStreamEvent[] = [
  { kind: "text-delta", text: "done\n" },
  { kind: "turn-end", reason: "completed" },
]

function scripted(scripts: AgentStreamEvent[][]): AgentSessionLike {
  let turn = 0
  return {
    sessionId: "scripted",
    async *send() {
      const script = scripts[Math.min(turn, scripts.length - 1)]!
      turn += 1
      for (const evt of script) yield evt
    },
    async cancel() {},
    async close() {},
  }
}

describe("turnRetry controller writes account health", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agp-health-ctl-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  function harness(opts: { scripts: AgentStreamEvent[][]; withPolicy?: boolean; profileRef?: string }) {
    const store = createAccountHealthStore({ dir, now: () => T0 })
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const notices: string[] = []
    const controller = createTurnRetryController({
      registry: {
        get: registry.get,
        list: registry.list,
        enqueuePrompt: registry.enqueuePrompt,
        patchTurnRetry: registry.patchTurnRetry,
        setModel: registry.setModel,
        interruptSession: registry.interruptSession,
        recordNotice: (id, text) => {
          notices.push(text)
          return registry.recordNotice(id, text)
        },
      },
      sessionEvents,
      accountHealth: store,
      now: () => T0,
      log: () => {},
    })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scripted(opts.scripts),
      adapterSlug: "opencode",
      model: "opencode-go/deepseek-v4.1-flash",
      accessProfile: { profileRef: opts.profileRef ?? "opencode-ws01", endpoint: "opencode-go", method: "api-key" },
      ...(opts.withPolicy === false
        ? {}
        : { turnRetry: resolveTurnRetryPolicy({ on: ["rate-limit"], baseDelayMs: 5, factor: 1, maxDelayMs: 5 }) }),
    })
    return {
      store,
      registry,
      desc,
      notices,
      done: () => {
        controller.dispose()
        registry.shutdown()
      },
    }
  }

  it("closes the billed account until the provider's own reset time", async () => {
    const h = harness({ scripts: [fail(GO_WEEKLY)] })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(async () => (await h.store.get("opencode-ws01")) !== undefined, "health mark")
    const view = await h.store.get("opencode-ws01")
    expect(view).toMatchObject({
      state: "exhausted",
      untilBasis: "observed",
      until: new Date(T0 + 33 * H).toISOString(),
      strikes: 1,
    })
    expect(h.notices.join("\n")).toMatch(/account "opencode-ws01" marked exhausted/)
    h.done()
  })

  it("falls back to the strike backoff when the message names no time", async () => {
    const h = harness({ scripts: [fail(GO_NO_TIME)] })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(async () => (await h.store.get("opencode-ws01")) !== undefined, "health mark")
    expect(await h.store.get("opencode-ws01")).toMatchObject({ untilBasis: "estimated", strikes: 1 })
    h.done()
  })

  it("marks the account even for a session with no turnRetry policy", async () => {
    const h = harness({ scripts: [fail(GO_WEEKLY)], withPolicy: false })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(async () => (await h.store.get("opencode-ws01")) !== undefined, "health mark")
    h.done()
  })

  it("never closes an account for the per-IP free-tier cap or a rate limit", async () => {
    for (const message of [FREE_CAP, "429 Too Many Requests: rate limit exceeded"]) {
      const h = harness({ scripts: [fail(message)] })
      await h.registry.sendPrompt(h.desc.id, "go")
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(await h.store.list()).toEqual([])
      h.done()
    }
  })

  it("a clean turn reopens the account", async () => {
    const h = harness({ scripts: [ok] })
    await h.store.mark("opencode-ws01", { reason: "earlier cap" })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(async () => (await h.store.get("opencode-ws01")) === undefined, "health cleared")
    h.done()
  })
})
