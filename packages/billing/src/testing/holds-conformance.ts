/**
 * Contract tests for a hold engine, framework-free like the BILL-* cases:
 *
 *   for (const c of holdsConformanceCases(ctx)) it(c.name, c.run)
 *
 * A host overlay that wraps `createHolds` (its own rules decide amounts) runs
 * these on every upgrade of the kit to prove the invariants still hold: no
 * negative balance, settle never above the reserve, one key one effect.
 */
import type { WalletEvent } from "@agentproto/wallet"
import type { StoragePort } from "@agentproto/wallet/ports"
import type { HoldEngine } from "../spend/holds.js"
import type { ConformanceCase } from "./conformance.js"
import type { ManualClock } from "./fakes.js"

export interface HoldsConformanceContext {
  /** Fresh, empty journal for one case. */
  storage: () => StoragePort
  clock: ManualClock
  /** The engine under test, over that journal, drawing on `asset`. */
  engine: (storage: StoragePort) => HoldEngine
  asset: string
}

class HoldsConformanceError extends Error {}
const check = (c: unknown, msg: string): void => {
  if (!c) throw new HoldsConformanceError(msg)
}

export function holdsConformanceCases(ctx: HoldsConformanceContext): ConformanceCase[] {
  const T = () => ctx.clock.nowMs()
  async function fresh(balance: number) {
    const storage = ctx.storage()
    const mint: WalletEvent = { id: "m", accountId: "a", kind: "mint", asset: ctx.asset, partitionId: "main", restriction: [], amount: balance, lotId: "lot", occurredAt: T() }
    await storage.commit("a", [mint])
    return { storage, engine: ctx.engine(storage), bal: () => storage.spendableBalance("a", ctx.asset) }
  }
  return [
    {
      name: "HOLD-1 a hold never takes more than the account can spend",
      run: async () => {
        const { engine, bal } = await fresh(100)
        const r = await engine.hold({ accountId: "a", key: "k", amount: 101 })
        check(!r.ok, "a hold above the balance was granted")
        check((await bal()) === 100, "a refused hold changed the balance")
      },
    },
    {
      name: "HOLD-2 two concurrent holds cannot both spend the same money",
      run: async () => {
        const { engine, bal } = await fresh(100)
        const rs = await Promise.all([engine.hold({ accountId: "a", key: "x", amount: 80 }), engine.hold({ accountId: "a", key: "y", amount: 80 })])
        check(rs.filter(r => r.ok).length === 1, "both holds were granted")
        check((await bal()) >= 0, "balance went negative")
      },
    },
    {
      name: "HOLD-3 settle never captures more than the reserve, whatever the caller passes",
      run: async () => {
        const { engine, bal } = await fresh(100)
        const r = await engine.hold({ accountId: "a", key: "k", amount: 40 })
        check(r.ok, "hold refused")
        if (!r.ok) return
        const s = await engine.settle(r.hold, 10_000)
        check(s.charged === 40 && s.overrun === 9_960, `charged ${s.charged}, overrun ${s.overrun}`)
        check((await bal()) === 60, "more than the reserve left the account")
      },
    },
    {
      name: "HOLD-4 a forged HoldRef cannot capture more than the journal reserved",
      run: async () => {
        const { engine, bal } = await fresh(100)
        const r = await engine.hold({ accountId: "a", key: "k", amount: 30 })
        check(r.ok, "hold refused")
        if (!r.ok) return
        await engine.settle({ ...r.hold, reserved: 90, draws: r.hold.draws.map(d => ({ ...d, amount: 90 })) }, 90)
        check((await bal()) === 70, "the forged reserve was honoured")
      },
    },
    {
      name: "HOLD-5 settle and release are idempotent: one key, one effect",
      run: async () => {
        const { engine, bal } = await fresh(100)
        const r = await engine.hold({ accountId: "a", key: "k", amount: 50 })
        check(r.ok, "hold refused")
        if (!r.ok) return
        await engine.settle(r.hold, 20)
        await engine.settle(r.hold, 20)
        await engine.release(r.hold)
        check((await bal()) === 80, "a replay charged or released twice")
        const again = await engine.hold({ accountId: "a", key: "k", amount: 50 })
        check(again.ok && again.replayed, "a replayed hold was granted twice")
        check((await bal()) === 80, "a replayed hold took money twice")
      },
    },
    {
      name: "HOLD-6 an amount that is not a number charges nothing and does not close the hold",
      run: async () => {
        const { engine, bal } = await fresh(100)
        const r = await engine.hold({ accountId: "a", key: "k", amount: 50 })
        check(r.ok, "hold refused")
        if (!r.ok) return
        let threw = false
        try {
          await engine.settle(r.hold, Number.NaN)
        } catch {
          threw = true
        }
        check(threw, "NaN was accepted")
        check((await bal()) === 50, "the hold was altered by a refused settle")
        await engine.release(r.hold)
        check((await bal()) === 100, "the hold could not be released afterwards")
      },
    },
    {
      name: "HOLD-7 a crash leaves nothing locked: sweep releases old holds and spares settled ones",
      run: async () => {
        const { engine, bal } = await fresh(100)
        await engine.hold({ accountId: "a", key: "orphan", amount: 30 })
        const ok = await engine.hold({ accountId: "a", key: "done", amount: 20 })
        check(ok.ok, "hold refused")
        if (!ok.ok) return
        await engine.settle(ok.hold, 20)
        ctx.clock.advance(3_600_000)
        const swept = await engine.sweep("a", { olderThanMs: 1 })
        check(swept.length === 1 && swept[0] === "orphan", `swept ${JSON.stringify(swept)}`)
        check((await bal()) === 80, "sweep touched a settled hold or missed the orphan")
      },
    },
  ]
}
