/**
 * Boot contract: reaction receipt reconciliation runs after sandbox reattach
 * and before the eager resume pass, and does NOT depend on the workspace
 * config load that guards those passes.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { reconcileReactionsAtBoot } from "../commands/serve-boot-reactions.js"

const summary = { total: 2, pending: 1, running: 1, failed: 0, dead: 0 }

describe("serve.ts boot order", () => {
  const text = readFileSync(new URL("../commands/serve.ts", import.meta.url), "utf8")

  it("runs reattach, then reaction reconciliation, then eager resume", () => {
    const reattach = text.indexOf("reattachSandboxSessionsOnBoot(")
    const reconcile = text.indexOf("reconcileReactionsAtBoot(gateway")
    const resume = text.indexOf("resumeSessionsOnBoot(")
    expect(reattach).toBeGreaterThan(-1)
    expect(reconcile).toBeGreaterThan(-1)
    expect(resume).toBeGreaterThan(-1)
    expect(reattach).toBeLessThan(reconcile)
    expect(reconcile).toBeLessThan(resume)
  })

  it("keeps reconciliation out of the loadWorkspacesConfig try block", () => {
    // The try that loads the config and reattaches ends at the first `catch`
    // after the reattach call; the reconciliation call must come after it.
    const reattach = text.indexOf("reattachSandboxSessionsOnBoot(")
    const catchAfter = text.indexOf("} catch", reattach)
    const reconcile = text.indexOf("reconcileReactionsAtBoot(gateway")
    expect(catchAfter).toBeGreaterThan(-1)
    expect(reconcile).toBeGreaterThan(catchAfter)
  })
})

describe("serve.ts native hook wiring", () => {
  const text = readFileSync(new URL("../commands/serve.ts", import.meta.url), "utf8")

  it("registers the serving CLI before the gateway boots", () => {
    const register = text.indexOf("setServingCli(")
    const boot = text.indexOf("bootGatewayIdempotent(")
    expect(register).toBeGreaterThan(-1)
    expect(boot).toBeGreaterThan(-1)
    expect(register).toBeLessThan(boot)
    expect(text).toContain(
      "setServingCli(servingCliCommand(process.execPath, resolveCliEntry(process.argv[1]) ?? undefined))",
    )
  })
})

describe("reconcileReactionsAtBoot", () => {
  it("still reconciles when the workspace config failed to load", async () => {
    const gateway = { reconcileReactionsOnBoot: vi.fn(async () => summary) }
    const out: string[] = []
    const result = await reconcileReactionsAtBoot(gateway, undefined, l => out.push(l))
    expect(gateway.reconcileReactionsOnBoot).toHaveBeenCalledTimes(1)
    expect(result).toEqual(summary)
    expect(out[0]).toContain("reaction receipts: 2")
  })

  it("skips when another live daemon serves the same bucket", async () => {
    const gateway = { reconcileReactionsOnBoot: vi.fn(async () => summary) }
    const result = await reconcileReactionsAtBoot(
      gateway,
      { servedBucket: "default", otherLiveBuckets: new Set(["default"]) },
      () => {},
    )
    expect(gateway.reconcileReactionsOnBoot).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
  })

  it("runs when other daemons serve different buckets, and never throws", async () => {
    const gateway = {
      reconcileReactionsOnBoot: vi.fn(async () => {
        throw new Error("boom")
      }),
    }
    const out: string[] = []
    await expect(
      reconcileReactionsAtBoot(
        gateway,
        { servedBucket: "a", otherLiveBuckets: new Set(["b"]) },
        l => out.push(l),
      ),
    ).resolves.toBeUndefined()
    expect(gateway.reconcileReactionsOnBoot).toHaveBeenCalledTimes(1)
    expect(out[0]).toContain("boom")
  })
})
