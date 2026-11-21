/**
 * Unit tests for `readAdapterManifest` and `readAdapterPackageInfo`
 * (`registry/manifest-loader.ts`) — specifically verifying that an installed
 * adapter package without an `agentproto/adapter/v1` manifest (e.g. an AIP-45
 * agent-CLI adapter like `@agentproto/adapter-antigravity`) returns `null` for
 * `readAdapterManifest` while still resolving its `package.json` metadata via
 * `readAdapterPackageInfo`.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import {
  readAdapterManifest,
  readAdapterPackageInfo,
} from "../registry/manifest-loader.js"

describe("manifest-loader — installed package without runtime manifest", () => {
  it("distinguishes installed-without-manifest from not-installed for @agentproto/adapter-antigravity", async () => {
    const req = createRequire(import.meta.url)
    const expected = JSON.parse(
      readFileSync(req.resolve("@agentproto/adapter-antigravity/package.json"), "utf8")
    ) as { name: string; version: string }

    expect(await readAdapterManifest("@agentproto/adapter-antigravity")).toBeNull()

    const pkgInfo = await readAdapterPackageInfo("@agentproto/adapter-antigravity")
    expect(pkgInfo).not.toBeNull()
    expect(pkgInfo?.name).toBe(expected.name)
    expect(pkgInfo?.version).toBe(expected.version)
  })

  it("returns null from both helpers when a package is genuinely absent", async () => {
    const missing = "@agentproto/adapter-definitely-does-not-exist-xyz"
    expect(await readAdapterManifest(missing)).toBeNull()
    expect(await readAdapterPackageInfo(missing)).toBeNull()
  })
})
