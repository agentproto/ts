/**
 * `createReviewLedger`'s parsed-entry cache (path -> {mtimeMs, size, entry}):
 * a cache hit must return exactly what a cold read would, this ledger's own
 * `put()` must never serve a stale row for the key it just wrote, and a file
 * changed by a DIFFERENT `ReviewLedger` instance over the same root (the
 * daemon and a stand-alone `review` CLI invocation each construct their own
 * — see `packages/cli/src/commands/review.ts`) must still be seen fresh,
 * which is why the cache is guarded by a `stat` (mtimeMs+size), not only
 * invalidated on this instance's own writes. Annotations
 * (`<rangeSha>.annotations.json`) are never part of this cache, so a
 * `review_pr` update is never masked by a stale cached row either.
 */

import { mkdtemp, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ATTESTATION_SCHEMA, ledgerKeyOf, type Attestation } from "@agentproto/review"
import { createReviewLedger, repoSlug } from "../review-ledger.js"

function fakeAttestation(overrides: Partial<Attestation> & { requesterSessionId: string }): Attestation {
  const { requesterSessionId, ...rest } = overrides
  return {
    schema: ATTESTATION_SCHEMA,
    runId: "review-fixed",
    reviewId: "demo",
    manifestSha: "m".repeat(64),
    binding: "default",
    target: { repoRemote: "github.com/acme/demo", baseSha: "b".repeat(40), headSha: "h".repeat(40) },
    rangeSha: "r".repeat(64),
    lanes: [],
    verdict: "pass",
    attestor: { daemon: "test", presets: [] },
    rubrics: [],
    requester: { sessionId: requesterSessionId },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...rest,
  }
}

let root: string
const cleanup: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agp-review-ledger-cache-"))
  cleanup.push(root)
})
afterEach(async () => {
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true })
})

describe("review ledger — parsed-entry cache", () => {
  it("a warm list() returns rows identical to the cold read", async () => {
    const ledger = createReviewLedger({ root })
    for (let i = 0; i < 5; i++) {
      await ledger.put({
        attestation: fakeAttestation({ requesterSessionId: "s1", runId: `r${i}`, rangeSha: `r${i}`.repeat(16) }),
        host: { repoRoot: "/tmp/repo", manifestPath: "/tmp/repo/REVIEW.md" },
      })
    }
    const cold = await ledger.list({ requesterSessionIds: ["s1"] })
    const warm = await ledger.list({ requesterSessionIds: ["s1"] })
    expect(warm).toEqual(cold)
    expect(warm).toHaveLength(5)
  })

  it("put() to the same key never serves the stale cached verdict afterwards", async () => {
    const ledger = createReviewLedger({ root })
    const attestation = fakeAttestation({ requesterSessionId: "s1", verdict: "pass" })
    const key = ledgerKeyOf(attestation)
    await ledger.put({ attestation, host: { repoRoot: "/tmp/repo", manifestPath: "/tmp/repo/REVIEW.md" } })
    // Warm the cache for this key via every read path.
    expect((await ledger.get(key))!.attestation.verdict).toBe("pass")
    expect((await ledger.list({ requesterSessionIds: ["s1"] }))[0]!.attestation.verdict).toBe("pass")

    const rerun = fakeAttestation({ requesterSessionId: "s1", verdict: "block" })
    await ledger.put({ attestation: rerun, host: { repoRoot: "/tmp/repo", manifestPath: "/tmp/repo/REVIEW.md" } })

    expect((await ledger.get(key))!.attestation.verdict).toBe("block")
    expect((await ledger.list({ requesterSessionIds: ["s1"] }))[0]!.attestation.verdict).toBe("block")
  })

  it("a file removed out from under a warm cache reads as absent, not stale", async () => {
    const ledger = createReviewLedger({ root })
    const attestation = fakeAttestation({ requesterSessionId: "s1" })
    const key = ledgerKeyOf(attestation)
    const path = await ledger.put({ attestation, host: { repoRoot: "/tmp/repo", manifestPath: "/tmp/repo/REVIEW.md" } })
    expect(await ledger.get(key)).toBeDefined() // warms the cache
    await unlink(path)
    expect(await ledger.get(key)).toBeUndefined()
  })

  it("a write from a SECOND ledger instance over the same root is visible despite this instance's warm cache", async () => {
    const writer = createReviewLedger({ root })
    const reader = createReviewLedger({ root })
    const attestation = fakeAttestation({ requesterSessionId: "s1", verdict: "pass" })
    const key = ledgerKeyOf(attestation)
    await writer.put({ attestation, host: { repoRoot: "/tmp/repo", manifestPath: "/tmp/repo/REVIEW.md" } })
    expect((await reader.get(key))!.attestation.verdict).toBe("pass") // warms reader's own cache

    const rerun = fakeAttestation({ requesterSessionId: "s1", verdict: "block" })
    await writer.put({ attestation: rerun, host: { repoRoot: "/tmp/repo", manifestPath: "/tmp/repo/REVIEW.md" } })

    expect((await reader.get(key))!.attestation.verdict).toBe("block")
  })

  it("review_pr's annotation update is never masked by a cached row (pr/prState always read fresh)", async () => {
    const ledger = createReviewLedger({ root })
    const attestation = fakeAttestation({ requesterSessionId: "s1" })
    const key = ledgerKeyOf(attestation)
    await ledger.put({ attestation, host: { repoRoot: "/tmp/repo", manifestPath: "/tmp/repo/REVIEW.md" } })
    // Warm the entry cache for this key (what session_tree's polling does).
    await ledger.get(key)
    await ledger.list({ requesterSessionIds: ["s1"] })
    expect(await ledger.getAnnotations(key)).toEqual({})

    const pr = { provider: "github" as const, repo: "acme/demo", number: 7, url: "https://github.com/acme/demo/pull/7" }
    await ledger.updateAnnotations(key, current => ({ ...current, pr }))

    expect((await ledger.getAnnotations(key)).pr).toEqual(pr)
    // The entry itself (still cached) is untouched — pr/prState live only in
    // the annotations sidecar, never baked into the cached attestation row.
    expect((await ledger.get(key))!.attestation.pr).toBeUndefined()
  })

  it("repoSlug stays stable across cache reads (sanity: same on-disk layout as before caching)", () => {
    expect(repoSlug("github.com/acme/demo")).toBe("github.com_acme_demo")
  })
})
