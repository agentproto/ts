import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AnthropicRemainingQuotaReader } from "../remaining-quota.js"
import {
  accountHealthOf,
  accountHealthPath,
  backoffMsForStrikes,
  clearAccountHealth,
  exhaustedAccounts,
  isAccountClosed,
  isPerAddressCapMessage,
  listAccountHealth,
  loadAccountHealth,
  markAccountExhausted,
  parseExhaustionUntil,
  createAccountHealthStore,
  reconcileHealthFromQuota,
} from "../account-health.js"

const T0 = Date.parse("2026-11-15T10:00:00Z")
const H = 3_600_000

describe("account-health store", () => {
  let dir: string
  let clock: number
  const opts = () => ({ dir, now: () => clock })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agp-account-health-"))
    clock = T0
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it("reads a missing, corrupt or wrong-version file as empty and never throws", async () => {
    expect(await listAccountHealth(opts())).toEqual([])
    await writeFile(accountHealthPath(opts()), "{not json")
    expect(await loadAccountHealth(opts())).toEqual({ version: 1, accounts: {} })
    await writeFile(accountHealthPath(opts()), JSON.stringify({ version: 9, accounts: {} }))
    expect(await listAccountHealth(opts())).toEqual([])
  })

  it("marks an account exhausted with the provider's until, persisted 0600", async () => {
    const until = T0 + 33 * H
    const view = await markAccountExhausted(
      "opencode-ws01",
      { reason: "usage limit reached (weekly)", until, untilBasis: "observed" },
      opts(),
    )
    expect(view).toMatchObject({
      profileRef: "opencode-ws01",
      state: "exhausted",
      until: new Date(until).toISOString(),
      untilBasis: "observed",
      strikes: 1,
    })
    const raw = JSON.parse(await readFile(accountHealthPath(opts()), "utf8"))
    expect(raw.version).toBe(1)
    expect(raw.accounts["opencode-ws01"].untilBasis).toBe("observed")
    expect(((await stat(accountHealthPath(opts()))).mode & 0o777).toString(8)).toBe("600")
    expect(isAccountClosed(await accountHealthOf("opencode-ws01", opts()))).toBe(true)
    expect(await accountHealthOf("someone-else", opts())).toBeUndefined()
  })

  it("falls back to the strike backoff 30 min, 2 h, 6 h, 24 h and caps there", async () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMsForStrikes)).toEqual([0.5 * H, 2 * H, 6 * H, 24 * H, 24 * H, 24 * H])
    const first = await markAccountExhausted("a", { reason: "402" }, opts())
    expect(first).toMatchObject({ untilBasis: "estimated", strikes: 1 })
    expect(Date.parse(first.until) - T0).toBe(0.5 * H)
    // the trial after `until` fails again: a strike, a longer backoff
    clock = T0 + 0.5 * H + 1
    const second = await markAccountExhausted("a", { reason: "402" }, opts())
    expect(second.strikes).toBe(2)
    expect(Date.parse(second.until) - clock).toBe(2 * H)
  })

  it("does not take a strike for a failure reported while the account is already closed", async () => {
    await markAccountExhausted("a", { reason: "402" }, opts())
    clock = T0 + 60_000
    const again = await markAccountExhausted("a", { reason: "402 again" }, opts())
    expect(again.strikes).toBe(1)
    expect(Date.parse(again.until)).toBeGreaterThanOrEqual(T0 + 0.5 * H) // only ever extended
  })

  it("an account whose until has passed is probing, eligible, and still listed", async () => {
    await markAccountExhausted("a", { reason: "402" }, opts())
    clock = T0 + 0.5 * H + 1
    const view = await accountHealthOf("a", opts())
    expect(view).toMatchObject({ state: "probing", remainingMs: 0 })
    expect(isAccountClosed(view)).toBe(false)
    expect(await exhaustedAccounts(opts())).toEqual([])
    expect(await listAccountHealth(opts())).toHaveLength(1)
  })

  it("clearAccountHealth forgets an entry and reports whether there was one", async () => {
    await markAccountExhausted("a", { reason: "x" }, opts())
    expect(await clearAccountHealth("a", opts())).toBe(true)
    expect(await clearAccountHealth("a", opts())).toBe(false)
    expect(await accountHealthOf("a", opts())).toBeUndefined()
  })

  it("two concurrent failures on different accounts both land", async () => {
    await Promise.all([
      markAccountExhausted("a", { reason: "x" }, opts()),
      markAccountExhausted("b", { reason: "y" }, opts()),
      markAccountExhausted("c", { reason: "z" }, opts()),
    ])
    expect((await listAccountHealth(opts())).map(v => v.profileRef).sort()).toEqual(["a", "b", "c"])
  })

  it("clamps an absurd provider until to the cap and ignores a past one", async () => {
    const far = await markAccountExhausted(
      "a",
      { reason: "x", until: T0 + 400 * 24 * H, untilBasis: "observed" },
      opts(),
    )
    expect(Date.parse(far.until) - T0).toBe(45 * 24 * H)
    const past = await markAccountExhausted("b", { reason: "x", until: T0 - 1000, untilBasis: "observed" }, opts())
    expect(past.untilBasis).toBe("estimated")
  })
})

describe("parseExhaustionUntil", () => {
  it("reads the real OpenCode Go usage-limit messages (relative reset)", () => {
    expect(
      parseExhaustionUntil(
        "AI_APICallError: OpenCode Go usage limit reached (weekly, resets in 1d 9h). To keep going now, turn on Extra Usage or upgrade to Go Plus at https://opencode.ai/console/org_X/go.",
        T0,
      ),
    ).toBe(T0 + 33 * H)
    expect(parseExhaustionUntil("OpenCode Go usage limit reached (5-hour, resets in 2h 1m).", T0)).toBe(
      T0 + 2 * H + 60_000,
    )
    expect(parseExhaustionUntil("usage limit reached (weekly, resets in 11h 30m)", T0)).toBe(T0 + 11.5 * H)
  })

  it("reads Claude's clock form, with and without a zone", () => {
    // 2026-11-15 10:00Z is 11:00 in Paris (CET): "resets 12pm (Europe/Paris)" is 11:00Z the same day
    expect(parseExhaustionUntil("You've hit your weekly limit · resets 12pm (Europe/Paris)", T0)).toBe(
      Date.parse("2026-11-15T11:00:00Z"),
    )
    // 5pm Paris already passed once it is 17:30 Paris: next day
    const evening = Date.parse("2026-11-15T16:30:00Z")
    expect(parseExhaustionUntil("You've hit your session limit · resets 5pm (Europe/Paris)", evening)).toBe(
      Date.parse("2026-11-16T16:00:00Z"),
    )
    expect(parseExhaustionUntil("limit reached · resets Nov 20, 12pm (Europe/Paris)", T0)).toBe(
      Date.parse("2026-11-20T11:00:00Z"),
    )
  })

  it("reads retry-after and try-again hints", () => {
    expect(parseExhaustionUntil("Retry-After: 120", T0)).toBe(T0 + 120_000)
    expect(parseExhaustionUntil("rate limited, retry after 30s", T0)).toBe(T0 + 30_000)
    expect(parseExhaustionUntil("Please try again in 2 minutes", T0)).toBe(T0 + 120_000)
    expect(parseExhaustionUntil("quota exhausted, try again at 2026-11-20T05:00:00Z.", T0)).toBe(
      Date.parse("2026-11-20T05:00:00Z"),
    )
  })

  it("returns undefined when the message names no time", () => {
    expect(parseExhaustionUntil("AI_APICallError: Insufficient balance. Top up at https://x/billing", T0)).toBeUndefined()
    expect(parseExhaustionUntil("Go usage limit exceeded", T0)).toBeUndefined()
    expect(parseExhaustionUntil(undefined, T0)).toBeUndefined()
    expect(parseExhaustionUntil("it resets 3 times", T0)).toBeUndefined()
  })
})

describe("isPerAddressCapMessage", () => {
  it("flags the free-tier per-IP cap, not a wallet message", () => {
    expect(isPerAddressCapMessage("Free usage limit reached")).toBe(true)
    expect(isPerAddressCapMessage("OpenCode Go usage limit reached (weekly, resets in 1h)")).toBe(false)
  })
})

describe("quota readers feed account health", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agp-health-quota-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it("a window at 0 closes the account until its resetsAt (provider basis), headroom reopens it", async () => {
    const now = Date.parse("2026-11-15T10:00:00Z")
    const store = createAccountHealthStore({ dir, now: () => now })
    const resetsAt = "2026-11-15T15:00:00.000Z"
    await reconcileHealthFromQuota(store, "claude-a", [{ remainingPct: 0, resetsAt }, { remainingPct: 40 }], now)
    expect(await store.get("claude-a")).toMatchObject({ state: "exhausted", untilBasis: "provider", until: resetsAt })
    await reconcileHealthFromQuota(store, "claude-a", [{ remainingPct: 30, resetsAt }], now)
    expect(await store.get("claude-a")).toBeUndefined()
  })

  it("AnthropicRemainingQuotaReader closes the account on a live 0-remaining read", async () => {
    const now = new Date("2025-07-23T00:00:00.000Z")
    const store = createAccountHealthStore({ dir, now: () => now.getTime() })
    const headers = new Headers({
      "anthropic-ratelimit-unified-5h-remaining": "0",
      "anthropic-ratelimit-unified-5h-reset": "1753336800",
    })
    const reader = new AnthropicRemainingQuotaReader({
      liveProbe: true,
      fetchImpl: (async () => new Response(null, { status: 429, headers })) as unknown as typeof fetch,
      resolveToken: async () => "fake-bearer",
      store: { dir },
      accountHealth: store,
      now: () => now,
    })
    await reader.readRemainingQuota(
      { profileRef: "claude-a", endpoint: "anthropic", method: "oauth-bearer", source: "claude-code-oauth" },
      "5h",
    )
    expect(await store.get("claude-a")).toMatchObject({
      state: "exhausted",
      untilBasis: "provider",
      until: new Date(1753336800 * 1000).toISOString(),
    })
  })
})
