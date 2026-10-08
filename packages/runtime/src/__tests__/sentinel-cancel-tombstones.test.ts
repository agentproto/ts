/**
 * Phase 0a — persisted cancel tombstones.
 *
 * Unwatching records the deletion intent durably (keyed by provider + remote
 * subscription id), drops local delivery eligibility immediately, and a sweep
 * retries the remote delete until the provider confirms. An immediate
 * re-subscribe is never cancelled by the old tombstone.
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createCancelTombstoneStore } from "../sentinel-cancel-tombstones.js"
import { eventsSubscribe, eventsUnsubscribe, type EventsUnsubscribeContext } from "../mcp-events/adapter.js"
import { daemonBearerPrincipal } from "../mcp-events/events-registry.js"
import { createSentinelStore } from "../sentinel-store.js"
import { cancelSentinelWatch } from "../sentinel-tools.js"
import { createFakeSentinelProvider, type FakeSentinelProvider } from "../sentinel-providers/fake.js"
import type { SentinelHandle, SentinelProviderHandle } from "../sentinel-providers/types.js"

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tombstones-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const PRINCIPAL = daemonBearerPrincipal()
const CALLBACK = "https://receiver.example.com/mcp-events/cb"
const SECRET = "whsec_" + Buffer.from(new Uint8Array(32).fill(7)).toString("base64")
const SUB = {
  name: "github.pull_request.closed",
  arguments: { repo: "agentproto/ts", number: 1428 },
  delivery: { mode: "webhook" as const, url: CALLBACK, secret: SECRET },
}
const REMOTE = "github:agentproto/ts#1428"

/** A fake provider whose remote can be switched unreachable. */
function flaky(): { provider: FakeSentinelProvider; down: { value: boolean }; cancelAttempts: string[] } {
  const base = createFakeSentinelProvider({ slug: "local-gh" })
  const down = { value: true }
  const cancelAttempts: string[] = []
  const provider: FakeSentinelProvider = {
    ...base,
    async cancel(handle: SentinelHandle): Promise<void> {
      cancelAttempts.push(handle.remoteId ?? "")
      if (down.value) throw new Error("ECONNREFUSED")
      return base.cancel(handle)
    },
  }
  return { provider, down, cancelAttempts }
}

function setup(over: { filePath?: string; now?: { t: number } } = {}) {
  const store = createSentinelStore({ persist: false })
  const f = flaky()
  const now = over.now ?? { t: 1_000_000 }
  const tombstones = createCancelTombstoneStore({
    ...(over.filePath ? { filePath: over.filePath } : {}),
    resolveProvider: async slug => (slug === f.provider.slug ? f.provider : null),
    isRemoteInUse: (provider, remoteId) =>
      store.list().some(s => s.provider === provider && s.handle.remoteId === remoteId && s.status !== "expired"),
    nowMs: () => now.t,
    log: () => {},
    baseBackoffMs: 1_000,
  })
  const subscribeCtx = { principal: PRINCIPAL, store, resolveProvider: async () => f.provider as SentinelProviderHandle, verify: async () => ({ ok: true as const, verificationBytes: new Uint8Array() }) }
  const unsubCtx: EventsUnsubscribeContext = {
    principal: PRINCIPAL,
    store,
    resolveProvider: async () => f.provider,
    tombstones,
  }
  const unsubInput = { name: SUB.name, arguments: SUB.arguments, delivery: { mode: "webhook" as const, url: CALLBACK } }
  return { store, ...f, tombstones, subscribeCtx, unsubCtx, unsubInput, now }
}

describe("cancel tombstones", () => {
  it("remote unreachable: unsubscribe drops the local row at once, leaves a persisted tombstone, and a later sweep converges", async () => {
    const file = join(tmp(), "tombstones.json")
    const { store, provider, down, tombstones, subscribeCtx, unsubCtx, unsubInput, now } = setup({ filePath: file })
    const created = await eventsSubscribe(SUB, subscribeCtx)

    expect(await eventsUnsubscribe(unsubInput, unsubCtx)).toEqual({})

    // Delivery eligibility ended immediately; the remote is still live.
    expect(store.get(created.id)).toBeUndefined()
    expect(provider.canceled.has(REMOTE)).toBe(false)
    expect(tombstones.has("local-gh", REMOTE)).toBe(true)
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { tombstones: Array<{ key: string; attempts: number; lastError?: string }> }
    expect(onDisk.tombstones).toHaveLength(1)
    expect(onDisk.tombstones[0]).toMatchObject({ key: `local-gh|${REMOTE}`, attempts: 1, lastError: "ECONNREFUSED" })

    // Backoff: not due yet.
    expect(await tombstones.sweep()).toMatchObject({ attempted: 0, remaining: 1 })

    // Remote recovers; after the backoff the sweep deletes it and drops the tombstone.
    down.value = false
    now.t += 10 * 60_000
    expect(await tombstones.sweep()).toEqual({ attempted: 1, converged: 1, remaining: 0 })
    expect(provider.canceled.has(REMOTE)).toBe(true)
    expect(tombstones.list()).toEqual([])
    expect((JSON.parse(readFileSync(file, "utf8")) as { tombstones: unknown[] }).tombstones).toEqual([])
  })

  it("a tombstone survives a restart (reloaded from disk) and still converges", async () => {
    const file = join(tmp(), "tombstones.json")
    const a = setup({ filePath: file })
    await eventsSubscribe(SUB, a.subscribeCtx)
    await eventsUnsubscribe(a.unsubInput, a.unsubCtx)
    expect(a.tombstones.list()).toHaveLength(1)

    const b = setup({ filePath: file })
    expect(b.tombstones.has("local-gh", REMOTE)).toBe(true)
    b.down.value = false
    b.now.t += 10 * 60_000
    expect((await b.tombstones.sweep()).converged).toBe(1)
    expect(b.provider.canceled.has(REMOTE)).toBe(true)
  })

  it("persists identifiers only: secret-like handle state is stripped", async () => {
    const file = join(tmp(), "tombstones.json")
    const { tombstones } = setup({ filePath: file })
    await tombstones.cancel({
      provider: "local-gh",
      remoteId: "sub_9",
      state: { mode: "push", hookKey: "hk", callbackSecret: "TOPSECRET", apiToken: "TOPTOKEN", consumerRef: "c" },
    })
    const raw = readFileSync(file, "utf8")
    expect(raw).not.toContain("TOPSECRET")
    expect(raw).not.toContain("TOPTOKEN")
    expect(raw).toContain("consumerRef")
  })

  it("immediate unsubscribe + re-subscribe: the old tombstone never cancels the new subscription's remote", async () => {
    const { store, provider, down, cancelAttempts, tombstones, subscribeCtx, unsubCtx, unsubInput, now } = setup()
    await eventsSubscribe(SUB, subscribeCtx)
    await eventsUnsubscribe(unsubInput, unsubCtx)
    expect(tombstones.has("local-gh", REMOTE)).toBe(true)

    const again = await eventsSubscribe(SUB, subscribeCtx)
    expect(store.get(again.id)).toBeDefined()
    const attemptsBefore = cancelAttempts.length

    down.value = false
    now.t += 10 * 60_000
    const res = await tombstones.sweep()

    // Stale tombstone dropped without touching the remote the live row owns.
    expect(res.remaining).toBe(0)
    expect(cancelAttempts.length).toBe(attemptsBefore)
    expect(provider.canceled.has(REMOTE)).toBe(false)
    expect(store.get(again.id)?.status).not.toBe("expired")
  })

  it("a durable-write failure rejects BEFORE the local row is removed (nothing is half-unwatched)", async () => {
    const dir = tmp()
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "x")
    const { store, tombstones, subscribeCtx } = setup({ filePath: join(blocker, "t.json") })
    const created = await eventsSubscribe(SUB, subscribeCtx)

    const sentinel = store.get(created.id)!
    await expect(tombstones.cancel(sentinel.handle, () => store.remove(created.id))).rejects.toThrow()
    expect(store.get(created.id)).toBeDefined()
    expect(tombstones.list()).toEqual([])
  })

  it("cancelSentinelWatch (the sentinel_unwatch path) goes through the tombstone store too", async () => {
    const { store, tombstones, provider, down, subscribeCtx, now } = setup()
    const created = await eventsSubscribe(SUB, subscribeCtx)

    await cancelSentinelWatch({ store, resolveProvider: async () => provider, tombstones }, created.id)

    expect(store.get(created.id)).toBeUndefined()
    expect(tombstones.has("local-gh", REMOTE)).toBe(true)
    down.value = false
    now.t += 10 * 60_000
    await tombstones.sweep()
    expect(provider.canceled.has(REMOTE)).toBe(true)
  })

  it("a provider with a shared remote (not exclusiveRemote) keeps best-effort cancel and records no tombstone", async () => {
    const base = createFakeSentinelProvider({ slug: "shared" })
    const shared = { ...base, exclusiveRemote: false, cancel: async () => { throw new Error("down") } } as SentinelProviderHandle
    const tombstones = createCancelTombstoneStore({ resolveProvider: async () => shared, log: () => {} })
    let dropped = false
    const res = await tombstones.cancel({ provider: "shared", remoteId: "repo-hook" }, () => {
      dropped = true
    })
    expect(dropped).toBe(true)
    expect(res).toEqual({ converged: false })
    expect(tombstones.list()).toEqual([])
  })
})
