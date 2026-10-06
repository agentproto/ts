/**
 * The apps step's catalog branch: `featured` entries of the daemon's
 * `app_catalog` that are not installed become opt-in install proposals;
 * an unreachable daemon or an empty catalog changes nothing.
 */

import { describe, it, expect } from "vitest"
import { appsStep } from "./steps/apps.js"
import type { StepCatalogEntry } from "./types.js"
import { createFakeContext } from "./__fixtures__/fake-context.js"
import { createFakeSetup } from "./__fixtures__/fake-setup.js"

const FEATURED: StepCatalogEntry = {
  appId: "@agentik/session-chat",
  name: "Session Chat",
  featured: true,
  installed: false,
  source: { kind: "agentapp", url: "https://example.test/session-chat-0.2.0.agentapp" },
}

function ctxWith(catalog: StepCatalogEntry[] | null) {
  return createFakeContext({ sources: { appCatalog: async () => catalog } })
}

describe("apps step: featured catalog entries", () => {
  it("proposes featured, not-installed, remote entries only", async () => {
    const ctx = ctxWith([
      FEATURED,
      { ...FEATURED, appId: "@x/installed", installed: true },
      { ...FEATURED, appId: "@x/not-featured", featured: false },
      { appId: "@x/local", featured: true, installed: false, source: { kind: "local" } },
    ])
    const checks = await appsStep.detect(ctx)
    const featured = checks.filter((c) => c.data?.featured === true)
    expect(featured.map((c) => c.data?.appId)).toEqual(["@agentik/session-chat"])
    expect(featured[0]!.status).toBe("warn")
    expect(featured[0]!.fix).toBe("agentproto app install @agentik/session-chat")
  })

  it("adds nothing when the daemon is unreachable or the catalog is empty", async () => {
    const baseline = await appsStep.detect(ctxWith(null))
    expect(await appsStep.detect(ctxWith([]))).toEqual(baseline)
    expect(baseline.some((c) => c.data?.featured === true)).toBe(false)
    const throwing = createFakeContext({ sources: { appCatalog: async () => Promise.reject(new Error("down")) } })
    expect(await appsStep.detect(throwing)).toEqual(baseline)
  })

  it("the featured action is opt-in and installs through the catalog when interactive", async () => {
    const ctx = ctxWith([FEATURED])
    const checks = await appsStep.detect(ctx)
    const actions = await appsStep.plan!(checks, ctx, new Map())
    const action = actions.find((a) => a.id === "apps.install.apps.featured.@agentik/session-chat")
    expect(action?.default).toBe(false)

    const interactive = createFakeSetup(ctx, { interactive: true })
    expect(await action!.apply(interactive.io)).toEqual({ ok: true, detail: "installed" })
    expect(interactive.calls).toEqual(["appInstallFromCatalog @agentik/session-chat"])
  })

  it("non-interactive: installs nothing, points at the store", async () => {
    const ctx = ctxWith([FEATURED])
    const actions = await appsStep.plan!(await appsStep.detect(ctx), ctx, new Map())
    const action = actions.find((a) => a.id.includes("featured"))!
    const batch = createFakeSetup(ctx, { interactive: false })
    expect(await action.apply(batch.io)).toEqual({ ok: true, detail: "agentproto app store" })
    expect(batch.calls).toEqual([])
  })
})
