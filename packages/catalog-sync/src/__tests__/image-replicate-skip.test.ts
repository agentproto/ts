/**
 * Regression: the Replicate image source must SKIP its live refresh (reusing the
 * committed snapshot) when `REPLICATE_API_TOKEN` is absent — never throw. Before
 * the fix `REPLICATE_SOURCE` carried no auth header, so a token-less
 * `catalog-sync generate --refresh` fetched the authed endpoint unauthenticated,
 * got 401, and threw — crashing the ENTIRE multi-provider run (and the weekly
 * catalog-sync Action if that secret ever lapses). The fix declares the token as
 * an `env:REPLICATE_API_TOKEN` header, routing it through the same missing-env
 * gate the authed LLM sources already use.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { runGenerators } from "../runner.js"
import { imageReplicate } from "../generators/image-replicate.js"

describe("image:replicate — skips refresh cleanly when REPLICATE_API_TOKEN is absent", () => {
  let saved: string | undefined
  beforeEach(() => {
    // Force the token-absent path deterministically, regardless of the runner's
    // ambient env (CI may set the secret).
    saved = process.env.REPLICATE_API_TOKEN
    delete process.env.REPLICATE_API_TOKEN
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.REPLICATE_API_TOKEN
    else process.env.REPLICATE_API_TOKEN = saved
  })

  it("does NOT throw on `--refresh` with no token — reuses the committed snapshot", async () => {
    // refresh:true + missing token ⇒ the runner reuses snapshots/image-replicate.json
    // with NO network call. write:false keeps it read-only.
    const result = await runGenerators([imageReplicate], { refresh: true, write: false })
    // The generator still emits its file from the committed snapshot...
    const out = result.files["packages/catalog-sync/generated/image-replicate.generated.ts"]
    expect(out).toBeDefined()
    expect(out).toContain("REPLICATE_IMAGE_MODELS")
    // ...and produces real entries (the snapshot is non-empty), proving the skip
    // fell back to committed data rather than an empty/failed fetch.
    expect(out).toContain("providerId")
  })

  it("the offline (no --refresh) path is likewise clean and byte-identical", async () => {
    const refreshed = await runGenerators([imageReplicate], { refresh: true, write: false })
    const offline = await runGenerators([imageReplicate], { refresh: false, write: false })
    // With the token absent, --refresh degrades to exactly the offline snapshot
    // read, so both runs emit identical content.
    expect(refreshed.files).toEqual(offline.files)
  })
})
