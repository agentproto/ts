import { describe, it, expect } from "vitest"
import { defineAcp } from "../define-acp.js"
import { parseAcpManifest } from "../manifest/index.js"
import type { AcpDefinition } from "../types.js"

const minimalServer = (
  overrides: Partial<AcpDefinition> = {},
): AcpDefinition => ({
  name: "guilde-acp",
  id: "guilde-acp",
  description:
    "Guilde operator exposed as an ACP server for IDE clients.",
  version: "0.1.0",
  kind: "server",
  transport: "stdio",
  metadata: {
    aip44: {
      acp_rev: "abc1234",
      tier: "governance-aware",
      operator: "./OPERATOR.md",
    },
  },
  ...overrides,
})

const minimalClient = (
  overrides: Partial<AcpDefinition> = {},
): AcpDefinition => ({
  name: "hermes-client",
  id: "hermes-client",
  description: "ACP client driving Hermes via stdio.",
  version: "0.1.0",
  kind: "client",
  transport: "stdio",
  metadata: {
    aip44: {
      acp_rev: "abc1234",
      tier: "basic",
    },
  },
  ...overrides,
})

describe("defineAcp (AIP-44)", () => {
  it("imports cleanly", () => {
    expect(typeof defineAcp).toBe("function")
  })

  describe("baseline frontmatter", () => {
    it("accepts a minimal server manifest", () => {
      const handle = defineAcp(minimalServer())
      expect(handle.kind).toBe("server")
      expect(handle.metadata.aip44.tier).toBe("governance-aware")
      expect(handle.metadata.aip44.operator).toBe("./OPERATOR.md")
    })

    it("accepts a minimal client manifest", () => {
      const handle = defineAcp(minimalClient())
      expect(handle.kind).toBe("client")
    })

    it("accepts transport as an array", () => {
      const handle = defineAcp(
        minimalServer({ transport: ["stdio", "websocket"] }),
      )
      expect(handle.transport).toEqual(["stdio", "websocket"])
    })

    it("rejects non-kebab id", () => {
      expect(() =>
        defineAcp(minimalServer({ id: "Guilde_ACP" })),
      ).toThrow(/defineAcp \(AIP-44\)/)
    })

    it("rejects malformed semver", () => {
      expect(() => defineAcp(minimalServer({ version: "v1" }))).toThrow(
        /defineAcp \(AIP-44\)/,
      )
    })

    it("rejects malformed acp_rev", () => {
      expect(() =>
        defineAcp(
          minimalServer({
            metadata: {
              aip44: {
                acp_rev: "not-a-sha",
                tier: "basic",
                operator: "./OPERATOR.md",
              },
            },
          }),
        ),
      ).toThrow(/defineAcp \(AIP-44\)/)
    })
  })

  describe("cross-field rules", () => {
    it("requires operator when kind=server", () => {
      expect(() =>
        defineAcp({
          name: "no-op-server",
          id: "no-op-server",
          description: "Server without operator binding.",
          version: "0.1.0",
          kind: "server",
          transport: "stdio",
          metadata: {
            aip44: { acp_rev: "abc1234", tier: "basic" },
          },
        }),
      ).toThrow(/operator is required when kind=server/)
    })

    it("does not require operator when kind=client", () => {
      const handle = defineAcp(minimalClient())
      expect(handle.metadata.aip44.operator).toBeUndefined()
    })

    it("requires sandbox when tier=sandboxed", () => {
      expect(() =>
        defineAcp(
          minimalServer({
            metadata: {
              aip44: {
                acp_rev: "abc1234",
                tier: "sandboxed",
                operator: "./OPERATOR.md",
              },
            },
          }),
        ),
      ).toThrow(/sandbox is required when metadata.aip44.tier=sandboxed/)
    })

    it("accepts sandbox when tier=sandboxed", () => {
      const handle = defineAcp(
        minimalServer({
          metadata: {
            aip44: {
              acp_rev: "abc1234",
              tier: "sandboxed",
              operator: "./OPERATOR.md",
              sandbox: "./SANDBOX.md",
            },
          },
        }),
      )
      expect(handle.metadata.aip44.sandbox).toBe("./SANDBOX.md")
    })
  })

  describe("parseAcpManifest", () => {
    it("parses a minimal ACP.md", () => {
      const md = `---
name: guilde-acp
id: guilde-acp
description: Guilde operator exposed as ACP server.
version: 0.1.0
kind: server
transport: stdio
metadata:
  aip44:
    acp_rev: abc1234
    tier: governance-aware
    operator: ./OPERATOR.md
---

# guilde-acp

ACP server description body.
`
      const { frontmatter, body } = parseAcpManifest(md)
      expect(frontmatter.kind).toBe("server")
      expect(frontmatter.metadata.aip44.tier).toBe("governance-aware")
      expect(body).toMatch(/ACP server description body/)
    })

    it("rejects empty frontmatter", () => {
      expect(() => parseAcpManifest("# no frontmatter")).toThrow(
        /missing or empty frontmatter/,
      )
    })

    it("rejects manifest with bad tier value", () => {
      const md = `---
name: bad
id: bad
description: bad tier
version: 0.1.0
kind: client
transport: stdio
metadata:
  aip44:
    acp_rev: abc1234
    tier: invalid-tier
---

body
`
      expect(() => parseAcpManifest(md)).toThrow(/parseAcpManifest/)
    })
  })
})
