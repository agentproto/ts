import { describe, expect, it } from "vitest"
import {
  parseConnectorMcp,
  safeParseConnectorMcp,
  connectorMcpSchema,
  isHostedConnector,
  isLocalDaemonConnector,
  isSandboxConnector,
  isExternalConnector,
} from "../guards.js"
import type {
  ConnectorMcpDescriptor,
  ConnectorMcpKind,
} from "../descriptor.js"

describe("ConnectorMcpDescriptor", () => {
  it("parses + narrows each of the four kinds", () => {
    const hosted = parseConnectorMcp({
      kind: "hosted",
      slug: "linear",
      serverUrl: "https://mcp.example.com/linear",
    })
    expect(isHostedConnector(hosted)).toBe(true)
    if (isHostedConnector(hosted)) expect(hosted.serverUrl).toContain("linear")

    const sandbox = parseConnectorMcp({
      kind: "sandbox",
      slug: "filesystem",
      runtime: "node",
      entryPoint: "dist/server.mjs",
      args: ["--root", "/tmp"],
      packageName: "@scope/fs-mcp",
    })
    expect(isSandboxConnector(sandbox)).toBe(true)

    const external = parseConnectorMcp({ kind: "external", slug: "my-mcp" })
    expect(isExternalConnector(external)).toBe(true)

    const local = parseConnectorMcp({
      kind: "local-daemon",
      slug: "bureau",
      importAlias: "bureau",
      tunnelProvider: "cloudflare-named",
    })
    expect(isLocalDaemonConnector(local)).toBe(true)
    if (isLocalDaemonConnector(local)) {
      expect(local.importAlias).toBe("bureau")
      expect(local.tunnelProvider).toBe("cloudflare-named")
    }
  })

  it("local-daemon tunnelProvider is optional (single shared-tunnel hosts)", () => {
    const local = parseConnectorMcp({
      kind: "local-daemon",
      slug: "bureau",
      importAlias: "bureau",
    })
    expect(isLocalDaemonConnector(local)).toBe(true)
  })

  it("rejects invalid descriptors", () => {
    // hosted requires serverUrl
    expect(safeParseConnectorMcp({ kind: "hosted", slug: "x" })).toBeNull()
    // local-daemon requires importAlias
    expect(safeParseConnectorMcp({ kind: "local-daemon", slug: "x" })).toBeNull()
    // unknown kind
    expect(safeParseConnectorMcp({ kind: "carrier-pigeon", slug: "x" })).toBeNull()
    // missing slug
    expect(safeParseConnectorMcp({ kind: "external" })).toBeNull()
  })

  it("back-compat: a flat guilde-style object parses + narrows correctly", () => {
    // guilde's original flat bag allowed extra fields; the strict per-kind
    // schema accepts the valid subset for each kind. A hosted entry that also
    // carried a stray importAlias would have been malformed even in guilde —
    // here a well-formed hosted entry parses cleanly.
    const guildeHosted = { kind: "hosted", slug: "github", serverUrl: "https://x" }
    const parsed = parseConnectorMcp(guildeHosted)
    expect(parsed.kind).toBe("hosted")

    const guildeBureau = { kind: "local-daemon", slug: "bureau", importAlias: "bureau" }
    expect(isLocalDaemonConnector(parseConnectorMcp(guildeBureau))).toBe(true)
  })

  it("schema covers exactly the four discriminants (exhaustiveness)", () => {
    const kinds = new Set<ConnectorMcpKind>([
      "hosted",
      "sandbox",
      "external",
      "local-daemon",
    ])
    // The discriminated union options expose their literal `kind`.
    const optionKinds = connectorMcpSchema.options.map((o) => o.shape.kind.value)
    expect(new Set(optionKinds)).toEqual(kinds)

    // Compile-time exhaustiveness: a switch over kind must be total.
    const describe = (d: ConnectorMcpDescriptor): string => {
      switch (d.kind) {
        case "hosted":
          return d.serverUrl
        case "sandbox":
          return d.packageName ?? d.slug
        case "external":
          return d.serverUrl ?? d.slug
        case "local-daemon":
          return d.importAlias
        default: {
          const _exhaustive: never = d
          return _exhaustive
        }
      }
    }
    expect(describe({ kind: "external", slug: "z" })).toBe("z")
  })
})
