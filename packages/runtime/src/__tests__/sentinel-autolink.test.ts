/**
 * Unit tests for sentinel auto-link (AIP-60 §6, step 4).
 *
 * `linkNow` (the awaitable twin of the production `onOpenedPr` hook) is
 * called directly with a fabricated `RecordOpenedPrInput` + a minimal
 * `AutoLinkSession` — this module's dependency on `SessionDescriptor` is
 * already narrowed to just `sentinelAutoWatch`, so no real session registry
 * is needed to exercise it.
 */

import { describe, expect, it } from "vitest"
import { createSentinelAutoLinker } from "../sentinel-autolink.js"
import { createSentinelStore } from "../sentinel-store.js"
import { createFakeSentinelProvider } from "../sentinel-providers/fake.js"
import { LOCAL_GH_SLUG } from "../sentinel-providers/local-gh.js"
import type { SentinelProviderHandle } from "../sentinel-providers/types.js"
import type { RecordOpenedPrInput } from "../sessions.js"

const OPENED: RecordOpenedPrInput = {
  adapter: "claude-code",
  number: 42,
  url: "https://github.com/acme/widgets/pull/42",
}

function resolverFor(provider: SentinelProviderHandle) {
  return async (slug: string): Promise<SentinelProviderHandle | null> =>
    slug === provider.slug ? provider : null
}

describe("sentinel auto-link", () => {
  it("an executor-opened PR creates exactly one sentinel", async () => {
    const store = createSentinelStore({ persist: false })
    // The fake's slug must match LOCAL_GH_SLUG — auto-link always resolves
    // that exact provider slug (design §6: "auto-select ... local-gh for now").
    const provider = createFakeSentinelProvider({ slug: LOCAL_GH_SLUG })
    const linker = createSentinelAutoLinker({
      store,
      resolveProvider: resolverFor(provider),
      autoWatchPrs: async () => true,
    })

    await linker.linkNow("sess_1", OPENED, {})

    const sentinels = store.list()
    expect(sentinels).toHaveLength(1)
    const s = sentinels[0]!
    expect(s.provider).toBe(LOCAL_GH_SLUG)
    expect(s.spec.match).toEqual([{ subject: "github:acme/widgets#42", types: expect.any(Array) }])
    expect(s.spec.until).toEqual({ kind: "subject_terminal" })
    expect(s.spec.target).toEqual({ kind: "session", sessionId: "sess_1", urgency: "next-turn" })
    expect(s.spec.label).toBe("auto:pr#42")
    expect(s.spec.group).toBe("sess_1")
  })

  it("a re-run (the reconciler observing the same PR again) does not duplicate the sentinel", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({ slug: LOCAL_GH_SLUG })
    const linker = createSentinelAutoLinker({
      store,
      resolveProvider: resolverFor(provider),
      autoWatchPrs: async () => true,
    })

    await linker.linkNow("sess_1", OPENED, {})
    await linker.linkNow("sess_1", OPENED, {}) // reconciler lane B re-polls, or lane A + B both fire
    await linker.linkNow("sess_1", OPENED, {})

    expect(store.list()).toHaveLength(1)
  })

  it("a per-spawn opt-out (sentinelAutoWatch: false) creates no sentinel", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({ slug: LOCAL_GH_SLUG })
    const linker = createSentinelAutoLinker({
      store,
      resolveProvider: resolverFor(provider),
      autoWatchPrs: async () => true,
    })

    await linker.linkNow("sess_1", OPENED, { sentinelAutoWatch: false })

    expect(store.list()).toEqual([])
  })

  it("config.sentinel.autoWatchPrs: false creates no sentinel", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({ slug: LOCAL_GH_SLUG })
    const linker = createSentinelAutoLinker({
      store,
      resolveProvider: resolverFor(provider),
      autoWatchPrs: async () => false,
    })

    await linker.linkNow("sess_1", OPENED, {})

    expect(store.list()).toEqual([])
  })

  it("a non-github PR url is a silent no-op (local-gh has nothing to watch)", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({ slug: LOCAL_GH_SLUG })
    const linker = createSentinelAutoLinker({
      store,
      resolveProvider: resolverFor(provider),
      autoWatchPrs: async () => true,
    })

    await linker.linkNow(
      "sess_1",
      { adapter: "claude-code", number: 1, url: "https://gitlab.com/acme/widgets/-/merge_requests/1" },
      {},
    )

    expect(store.list()).toEqual([])
  })

  it("an unavailable provider is a logged no-op, not a throw", async () => {
    const store = createSentinelStore({ persist: false })
    const messages: string[] = []
    const linker = createSentinelAutoLinker({
      store,
      resolveProvider: async () => null,
      autoWatchPrs: async () => true,
      log: line => messages.push(line),
    })

    await expect(linker.linkNow("sess_1", OPENED, {})).resolves.toBeUndefined()
    expect(store.list()).toEqual([])
    expect(messages.some(m => m.includes("unavailable"))).toBe(true)
  })

  it("two different PRs opened by the same session get two independent sentinels", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({ slug: LOCAL_GH_SLUG })
    const linker = createSentinelAutoLinker({
      store,
      resolveProvider: resolverFor(provider),
      autoWatchPrs: async () => true,
    })

    await linker.linkNow("sess_1", OPENED, {})
    await linker.linkNow("sess_1", { adapter: "claude-code", number: 7, url: "https://github.com/acme/widgets/pull/7" }, {})

    const sentinels = store.list()
    expect(sentinels).toHaveLength(2)
    expect(sentinels.map(s => s.spec.group)).toEqual(["sess_1", "sess_1"])
  })
})
