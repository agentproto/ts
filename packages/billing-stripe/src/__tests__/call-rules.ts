/**
 * The rules of the call side (SET-8 on refund and account errors, SET-9 on
 * the expected account, SET-10, SET-11, SET-12, and the refund movement and
 * idempotency key), each one written once against a provider MAKER, like
 * `rules.ts`: the same rule runs against this adapter (`calls.test.ts`,
 * green) and against the naive calls of `naive-calls.ts`, where each must
 * fail. Each run throws on failure.
 */
import type { SettlementProvider } from "@agentproto/billing"
import { FakeStripeError, SHOP_ORIGIN, makeKit, type Kit, type ProviderMaker } from "./kit.js"
import { toStripeCatalog } from "../catalog.js"

export interface CallRule {
  id: string
  title: string
  run: (make: ProviderMaker) => Promise<void>
}

class RuleError extends Error {}
const check = (cond: unknown, msg: string): void => {
  if (!cond) throw new RuleError(msg)
}
const eq = (a: unknown, b: unknown, msg: string): void => check(Object.is(a, b), `${msg}: expected ${String(b)}, got ${String(a)}`)
const throws = async (fn: () => unknown, msg: string): Promise<Error> => {
  try {
    await fn()
  } catch (e) {
    return e as Error
  }
  throw new RuleError(`${msg}: did not throw`)
}

function world(make: ProviderMaker, over: Parameters<Kit["config"]>[0] = {}) {
  const kit = makeKit()
  const provider: SettlementProvider = make(kit.config(over))
  const ok = `${SHOP_ORIGIN}/billing/done`
  return { kit, provider, ok, client: kit.client }
}

export const CALL_RULES: CallRule[] = [
  {
    id: "SET-8",
    title: "no secret in what refund() returns when Stripe refuses, nor in check() when the account read fails",
    run: async make => {
      const w = world(make, { expectAccount: { test: "acct_1Ex0Account0001" } })
      const secrets = [w.kit.secretKey, w.kit.webhookSecret]
      const leaks = (t: string) => secrets.filter(s => t.includes(s))
      // An SDK error may quote the key, in its message and in the request data it keeps.
      w.client.refundError = new FakeStripeError(`Invalid API Key provided: ${w.kit.secretKey}`, "StripeAuthenticationError", undefined, 401, { message: w.kit.secretKey }, { authorization: `Bearer ${w.kit.secretKey}` })
      const r = await w.provider.refund!("stripe:pi_3Ex0Intent0001", 500, "refund-s8")
      check(!r.ok, "refund() succeeded on a Stripe error")
      check(leaks(JSON.stringify(r)).length === 0, `a secret leaked into the refund result: ${JSON.stringify(r).slice(0, 160)}`)
      w.client.refundError = new FakeStripeError("Refund amount (EUR 30.00) is greater than unrefunded amount on charge (EUR 20.00)", "StripeInvalidRequestError", "amount_too_large")
      const over = await w.provider.refund!("stripe:pi_3Ex0Intent0001", 3000, "refund-s8b")
      check(!over.ok && typeof over.error === "string" && over.error.includes("amount_too_large"), `a refund above what is left: ${JSON.stringify(over)}`)
      w.client.accountError = new FakeStripeError(`Invalid API Key provided: ${w.kit.secretKey}`, "StripeAuthenticationError", undefined, 401)
      const c = await w.provider.check!()
      check(!c.ok, "check() passes when the account cannot be read")
      check(leaks(JSON.stringify(c)).length === 0, `a secret leaked into check(): ${JSON.stringify(c).slice(0, 160)}`)
    },
  },
  {
    id: "SET-9",
    title: "check() reads the account: another account fails, a restricted key without read access fails, the expected one passes",
    run: async make => {
      const w = world(make, { expectAccount: { test: "acct_1Ex0Expected0001", live: "acct_1Ex0Live0001" } })
      w.client.accountId = "acct_1Ex0Other0001"
      const other = await w.provider.check!()
      check(!other.ok && /acct_1Ex0Other0001/.test(other.reason ?? "") && /acct_1Ex0Expected0001/.test(other.reason ?? ""), `check() with the key of another account: ${JSON.stringify(other)}`)
      w.client.accountError = new FakeStripeError("The provided key 'rk_test_***4321' does not have the required permissions for this endpoint on account 'acct_1Ex0Expected0001'.", "StripePermissionError", undefined, 403)
      const restricted = await w.provider.check!()
      check(!restricted.ok && /cannot read its account/.test(restricted.reason ?? ""), `check() with a restricted key that cannot read the account: ${JSON.stringify(restricted)}`)
      w.client.accountError = null
      w.client.accountId = "acct_1Ex0Expected0001"
      eq((await w.provider.check!()).ok, true, "check() with the key of the expected account")
    },
  },
  {
    id: "SET-10",
    title: "a return URL outside the allowed origins is refused before any call, read or write, for checkout and portal",
    run: async make => {
      const w = world(make)
      w.client.seed(toStripeCatalog(w.kit.manifest), ["pack-20"])
      const bad = ["https://shop.example.com.evil.example/x", "http://shop.example.com/x", "javascript:alert(1)", "/relative", "https://user:pw@shop.example.com/x"]
      for (const url of bad) {
        await throws(() => w.provider.createCheckout!({ offerId: "pack-20", owner: { orgId: "acme" }, accountId: "acme", successUrl: url, cancelUrl: w.ok }), `success URL ${url}`)
        await throws(() => w.provider.createCheckout!({ offerId: "pack-20", owner: { orgId: "acme" }, accountId: "acme", successUrl: w.ok, cancelUrl: url }), `cancel URL ${url}`)
        await throws(() => w.provider.createPortalSession!({ owner: { orgId: "acme" }, accountId: "acme", returnUrl: url, payer: { ref: "cus_1Ex0Customer0001" } }), `portal URL ${url}`)
      }
      eq(w.client.log.length, 0, "calls to Stripe after refused URLs")
      const out = await w.provider.createCheckout!({ offerId: "pack-20", owner: { orgId: "acme" }, accountId: "acme", successUrl: w.ok, cancelUrl: w.ok })
      eq(out.outcome, "redirect", "an allowed URL")
    },
  },
  {
    id: "SET-11",
    title: "syncCatalog twice: the second creates and updates nothing and writes nothing",
    run: async make => {
      const w = world(make)
      const first = await w.provider.syncCatalog!(w.kit.manifest)
      check(first.created.length > 0, "the first sync created nothing")
      const writes = w.client.writes
      const second = await w.provider.syncCatalog!(w.kit.manifest)
      eq(second.created.length, 0, "created by the second sync")
      eq(second.updated.length, 0, "updated by the second sync")
      eq(second.unchanged.length, first.created.length + first.updated.length + first.unchanged.length, "unchanged by the second sync")
      eq(w.client.writes, writes, "writes of the second sync")
    },
  },
  {
    id: "SET-11-DRY",
    title: "a dry run makes no write call and reports what the real run then does",
    run: async make => {
      const w = world(make)
      const dry = await w.provider.syncCatalog!(w.kit.manifest, { dryRun: true })
      eq(w.client.writes, 0, "writes of a dry run")
      const real = await w.provider.syncCatalog!(w.kit.manifest)
      eq(JSON.stringify(dry), JSON.stringify(real), "the dry report against the real one")
      check(real.created.length > 0, "the real run created nothing")
    },
  },
  {
    id: "SET-12",
    title: "a missing owner key is refused before any call; every owner key is written on the session and on the subscription",
    run: async make => {
      const w = world(make, { ownerKeys: ["orgId", "userId"] })
      w.client.seed(toStripeCatalog(w.kit.manifest), ["pack-20", "plan-month"])
      await throws(() => w.provider.createCheckout!({ offerId: "pack-20", owner: { orgId: "acme" }, accountId: "acme", successUrl: w.ok, cancelUrl: w.ok }), "a checkout without userId")
      await throws(() => w.provider.createCheckout!({ offerId: "pack-20", owner: { orgId: "acme", userId: "" }, accountId: "acme", successUrl: w.ok, cancelUrl: w.ok }), "a checkout with an empty userId")
      eq(w.client.log.length, 0, "calls to Stripe after a missing owner key")
      const owner = { orgId: "acme", userId: "u1" }
      const want = { agentproto_offer: "plan-month", agentproto_owner_orgId: "acme", agentproto_owner_userId: "u1" }
      const out = await w.provider.createCheckout!({ offerId: "plan-month", owner, accountId: "acme", successUrl: w.ok, cancelUrl: w.ok })
      const s = w.client.sessions.get(out.ref)
      eq(JSON.stringify(s?.metadata), JSON.stringify(want), "session metadata")
      eq(JSON.stringify(s?.subscription_data?.metadata), JSON.stringify(want), "subscription metadata")
    },
  },
  {
    id: "REFUND-MOVEMENT",
    title: "refund() of a movement that is not stripe:pi_... is refused without any call",
    run: async make => {
      const w = world(make)
      for (const m of ["stripe:in_1Ex0Invoice0001", "stripe:re_1Ex0Refund0001", "stripe:cs_test_a1Ex0Session0001", "pi_3Ex0Intent0001", "other:pi_3Ex0Intent0001", "stripe:pi_"]) {
        const r = await w.provider.refund!(m, 500, `r-${m}`)
        check(!r.ok, `refund of '${m}' accepted`)
      }
      eq(w.client.log.length, 0, "calls to Stripe")
    },
  },
  {
    id: "REFUND-IDEMPOTENCY",
    title: "refund() passes ref as the idempotency key: the same ref twice is one refund, two refs are two",
    run: async make => {
      const w = world(make)
      const a = await w.provider.refund!("stripe:pi_3Ex0Intent0001", 500, "refund-a")
      const again = await w.provider.refund!("stripe:pi_3Ex0Intent0001", 500, "refund-a")
      const b = await w.provider.refund!("stripe:pi_3Ex0Intent0001", 500, "refund-b")
      check(a.ok && again.ok && b.ok, "a refund failed")
      eq(again.externalRef, a.externalRef, "the same ref twice")
      check(b.externalRef !== a.externalRef, "two refs gave one refund")
      const keys = w.client.log.filter(c => c.method === "refunds.create").map(c => c.options?.idempotencyKey)
      eq(JSON.stringify(keys), JSON.stringify(["refund-a", "refund-a", "refund-b"]), "idempotency keys")
      eq(w.client.refundsByKey.size, 2, "refunds at Stripe")
    },
  },
]
