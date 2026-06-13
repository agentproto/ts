import { describe, it, expect } from "vitest"
import {
  parseAuthProviderManifest,
  parseAuthProviderManifestRaw,
} from "../manifest.js"

const MD = `---
id: acme
description: ACME API — paste a personal access token.
apiBase: https://api.acme.example
auth:
  flow: pat
  tokenStore:
    keychain: acme-cli
    account: "{server}"
---

# ACME

How to obtain a token.
`

describe("parseAuthProviderManifest", () => {
  it("parses frontmatter into a frozen handle", () => {
    const h = parseAuthProviderManifest(MD)
    expect(h.id).toBe("acme")
    expect(h.auth.flow).toBe("pat")
    expect(h.auth.tokenStore.account).toBe("{server}")
    expect(Object.isFrozen(h)).toBe(true)
  })

  it("exposes the body via the raw parser", () => {
    const { frontmatter, body } = parseAuthProviderManifestRaw(MD)
    expect(frontmatter.id).toBe("acme")
    expect(body).toContain("# ACME")
  })

  it("throws on missing frontmatter", () => {
    expect(() => parseAuthProviderManifest("# just a body")).toThrow(
      /missing or empty frontmatter/,
    )
  })

  it("throws on invalid frontmatter", () => {
    const bad = `---
id: acme
description: ACME API.
apiBase: not-a-url
auth:
  flow: pat
  tokenStore:
    keychain: acme-cli
---
`
    expect(() => parseAuthProviderManifest(bad)).toThrow(
      /invalid frontmatter/,
    )
  })
})
