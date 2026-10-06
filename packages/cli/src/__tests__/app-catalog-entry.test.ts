/**
 * Tests for the pure catalog-entry builder (`app-catalog-entry.ts`):
 * slug derivation, GitHub Releases asset URL, and AppCatalogEntry
 * construction/validation for `app pack --release --entry`.
 */

import { describe, expect, it } from "vitest"

import { AppCatalogEntrySchema } from "@agentproto/runtime/app-catalog"
import {
  APP_RELEASES_BASE,
  buildCatalogEntry,
  bundleReleaseAssetUrl,
  catalogSlug,
} from "../app-catalog-entry.js"

describe("catalogSlug", () => {
  it("takes the last segment of a scoped appId", () => {
    expect(catalogSlug("@agentik/session-chat")).toBe("session-chat")
  })

  it("keeps an unscoped appId as-is", () => {
    expect(catalogSlug("job-hunter")).toBe("job-hunter")
    expect(catalogSlug("agentik/tools/inspector")).toBe("inspector")
  })
})

describe("bundleReleaseAssetUrl", () => {
  it("encodes the @ of the tag as %40", () => {
    expect(bundleReleaseAssetUrl("session-chat", "1.2.3")).toBe(
      `${APP_RELEASES_BASE}/session-chat%401.2.3/session-chat-1.2.3.agentapp`,
    )
  })
})

describe("buildCatalogEntry", () => {
  const base = {
    appId: "@agentik/session-chat",
    name: "Session Chat",
    description: "Chat with your sessions",
    category: "productivity",
    icon: "icon.svg",
    placement: "any" as const,
    version: "1.2.3",
    publisher: "Agentik",
    url: bundleReleaseAssetUrl("session-chat", "1.2.3"),
    sha256: "a".repeat(64),
    size: 12345,
  }

  it("builds a schema-valid bundle entry with a free license", () => {
    const entry = buildCatalogEntry(base)
    expect(AppCatalogEntrySchema.parse(entry)).toEqual(entry)
    expect(entry.tier).toBe("bundle")
    expect(entry.license).toEqual({ kind: "free" })
    expect(entry.source).toEqual({
      kind: "agentapp",
      url: base.url,
      sha256: base.sha256,
      version: "1.2.3",
      size: 12345,
    })
  })

  it("omits optional metadata when absent (publisher, icon, placement...)", () => {
    const entry = buildCatalogEntry({ ...base, name: undefined, description: undefined, category: undefined, icon: undefined, placement: undefined, publisher: undefined })
    expect(entry.name).toBeUndefined()
    expect(entry.publisher).toBeUndefined()
    expect(entry.icon).toBeUndefined()
    expect(entry.placement).toBeUndefined()
    expect(AppCatalogEntrySchema.safeParse(entry).success).toBe(true)
  })

  it("rejects an empty sha256 or url (schema validation before returning)", () => {
    expect(() => buildCatalogEntry({ ...base, sha256: "" })).toThrow(/invalid catalog entry/)
    expect(() => buildCatalogEntry({ ...base, url: "" })).toThrow(/invalid catalog entry/)
  })

  it("rejects a non-positive size", () => {
    expect(() => buildCatalogEntry({ ...base, size: -1 })).toThrow(/invalid catalog entry/)
  })
})
