/**
 * A usage or rate limit on a box session is a fact about the box's egress
 * address: the turn-retry controller feeds the egress health ledger from it,
 * whether or not the session opted into any retry policy.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createModelCooldowns } from "../model-cooldowns.js"
import { createTurnRetryController } from "../turn-retry.js"
import { createEgressHealthLedger } from "../egress-health.js"
import { resolveTurnRetryPolicy } from "../turn-retry-policy.js"

const MODEL = "opencode/glm-5.3-flash-free"
const IP = "203.0.113.9"
const CI_USAGE_LIMIT =
  "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"

const fail = (message: string): AgentStreamEvent[] => [
  { kind: "error", error: { message } },
  { kind: "turn-end", reason: "error" },
]
const ok: AgentStreamEvent[] = [
  { kind: "text-delta", text: "done\n" },
  { kind: "turn-end", reason: "completed" },
]

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentproto-egress-turn-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function harness(opts: { script: AgentStreamEvent[]; egress?: boolean; turnRetry?: boolean }) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const ledger = createEgressHealthLedger({ path: join(dir, "egress-health.json") })
  const controller = createTurnRetryController({
    registry: {
      get: registry.get,
      list: registry.list,
      enqueuePrompt: registry.enqueuePrompt,
      patchTurnRetry: registry.patchTurnRetry,
      setModel: registry.setModel,
      interruptSession: registry.interruptSession,
      recordNotice: registry.recordNotice,
    },
    sessionEvents,
    cooldowns: createModelCooldowns(),
    egressHealth: ledger,
    log: () => {},
  })
  const session: AgentSessionLike = {
    sessionId: "scripted",
    async *send() {
      for (const evt of opts.script) yield evt
    },
    async cancel() {},
    async close() {},
  }
  const desc = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: session,
    adapterSlug: "fake",
    model: MODEL,
    remote: true,
    sandboxId: "box_1",
    ...(opts.egress === false ? {} : { sandboxEgressIp: IP, sandboxEgressSlot: "c" }),
    ...(opts.turnRetry ? { turnRetry: resolveTurnRetryPolicy({ on: ["usage-limit"] }) } : {}),
  })
  return {
    registry,
    ledger,
    desc,
    done: () => {
      controller.dispose()
      registry.shutdown()
    },
  }
}

describe("turn-retry feeds the egress health ledger", () => {
  it("a usage-limit turn on a box session cools its egress address down for the model", async () => {
    const h = harness({ script: fail(CI_USAGE_LIMIT) })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.ledger.cooling(IP, MODEL) !== undefined, "egress cooldown")

    const [entry] = h.ledger.list()
    expect(entry).toMatchObject({ publicIp: IP, model: MODEL, errorClass: "usage-limit", slot: "c", source: h.desc.id })
    h.done()
  })

  it("feeds the ledger when the session also opted into a usage-limit retry policy", async () => {
    const h = harness({ script: fail(CI_USAGE_LIMIT), turnRetry: true })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.ledger.cooling(IP, MODEL) !== undefined, "egress cooldown")
    h.done()
  })

  it("a rate limit cools the address with the server's retry-after hint", async () => {
    const h = harness({ script: fail("429 Too Many Requests: rate limit exceeded, retry after 90 seconds") })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.ledger.cooling(IP, MODEL) !== undefined, "egress cooldown")

    const [entry] = h.ledger.list()
    expect(entry?.errorClass).toBe("rate-limit")
    expect(entry?.remainingMs).toBeLessThanOrEqual(90_000)
    h.done()
  })

  it("ignores a session that has no known egress address", async () => {
    const h = harness({ script: fail(CI_USAGE_LIMIT), egress: false })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.registry.get(h.desc.id)?.busy === false, "turn end")
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.ledger.list()).toEqual([])
    h.done()
  })

  it("ignores a failure that is not a usage or rate limit, and a successful turn", async () => {
    const other = harness({ script: fail("segmentation fault in the tool runner") })
    await other.registry.sendPrompt(other.desc.id, "go")
    await until(() => other.registry.get(other.desc.id)?.busy === false, "turn end")
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(other.ledger.list()).toEqual([])
    other.done()

    const fine = harness({ script: ok })
    await fine.registry.sendPrompt(fine.desc.id, "go")
    await until(() => fine.registry.get(fine.desc.id)?.busy === false, "turn end")
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fine.ledger.list()).toEqual([])
    fine.done()
  })
})
