import { describe, it, expect } from "vitest"
import { defineAgentCli } from "../define-agent-cli.js"
import { parseAgentCliManifest } from "../manifest/index.js"
import type { AgentCliDefinition } from "../types.js"

const minimal = (overrides: Partial<AgentCliDefinition> = {}): AgentCliDefinition => ({
  name: "hermes",
  id: "hermes",
  description: "Nous Research Hermes Agent — autonomous CLI agent.",
  version: "0.1.0",
  bin: "hermes",
  bin_args: ["acp"],
  install: [{ method: "brew", package: "hermes" }],
  version_check: {
    cmd: "hermes --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.13.0",
    timeout_ms: 5000,
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./hermes-acp.ACP.md",
  ...overrides,
})

describe("defineAgentCli (AIP-45)", () => {
  it("imports cleanly", () => {
    expect(typeof defineAgentCli).toBe("function")
  })

  describe("baseline frontmatter", () => {
    it("accepts a minimal acp-arm manifest", () => {
      const handle = defineAgentCli(minimal())
      expect(handle.protocol).toBe("acp")
      expect(handle.acp).toBe("./hermes-acp.ACP.md")
    })

    it("accepts an inline sandbox block", () => {
      const handle = defineAgentCli(
        minimal({ sandbox: { provider: "local" } }),
      )
      expect(typeof handle.sandbox).toBe("object")
    })

    it("rejects non-kebab id", () => {
      expect(() => defineAgentCli(minimal({ id: "Hermes_Agent" }))).toThrow(
        /AIP-45/,
      )
    })

    it("rejects malformed semver in version", () => {
      expect(() => defineAgentCli(minimal({ version: "v1" }))).toThrow(
        /AIP-45/,
      )
    })

    it("rejects empty install array", () => {
      expect(() => defineAgentCli(minimal({ install: [] }))).toThrow(
        /AIP-45/,
      )
    })

    it("requires version_check.range", () => {
      expect(() =>
        defineAgentCli(
          minimal({
            version_check: {
              cmd: "hermes --version",
              parse: "(\\d+\\.\\d+\\.\\d+)",
              range: "",
            },
          }),
        ),
      ).toThrow(/AIP-45/)
    })
  })

  describe("protocol cross-field rules", () => {
    it("requires `acp` when protocol=acp", () => {
      expect(() =>
        defineAgentCli(minimal({ protocol: "acp", acp: undefined })),
      ).toThrow(/`acp` ref is required when protocol=acp/)
    })

    it("requires `mcp` when protocol=mcp", () => {
      expect(() =>
        defineAgentCli(
          minimal({
            protocol: "mcp",
            acp: undefined,
            mcp: undefined,
          }),
        ),
      ).toThrow(/`mcp` block is required when protocol=mcp/)
    })

    it("accepts protocol=mcp with mcp block", () => {
      const handle = defineAgentCli(
        minimal({
          protocol: "mcp",
          acp: undefined,
          mcp: { command: "goose", args: ["serve"], transport: "stdio" },
        }),
      )
      expect(handle.protocol).toBe("mcp")
      expect(handle.mcp?.command).toBe("goose")
    })

    it("requires `adapter` when protocol=proprietary", () => {
      expect(() =>
        defineAgentCli(
          minimal({ protocol: "proprietary", acp: undefined }),
        ),
      ).toThrow(/`adapter` package is required when protocol=proprietary/)
    })

    it("accepts protocol=proprietary with adapter", () => {
      const handle = defineAgentCli(
        minimal({
          protocol: "proprietary",
          acp: undefined,
          adapter: "@agentproto/adapter-gemini-cli",
        }),
      )
      expect(handle.adapter).toBe("@agentproto/adapter-gemini-cli")
    })
  })

  describe("session resumable cross-field rule", () => {
    it("requires capabilities.resumable when session.mode=resumable", () => {
      expect(() =>
        defineAgentCli(
          minimal({
            session: { mode: "resumable" },
            capabilities: { resumable: false },
          }),
        ),
      ).toThrow(/session.mode=resumable requires capabilities.resumable: true/)
    })

    it("accepts session.mode=resumable with capabilities.resumable=true", () => {
      const handle = defineAgentCli(
        minimal({
          session: { mode: "resumable", idle_timeout_ms: 86_400_000 },
          capabilities: { resumable: true, streaming: true },
        }),
      )
      expect(handle.session?.mode).toBe("resumable")
    })
  })

  describe("models.apply=\"arg\" cross-field rule", () => {
    it("requires models.bin_args_template when models.apply=\"arg\"", () => {
      expect(() =>
        defineAgentCli(
          minimal({
            models: { default: "o3", apply: "arg" },
          }),
        ),
      ).toThrow(/models.apply="arg" requires models.bin_args_template/)
    })

    it("accepts models.apply=\"arg\" with bin_args_template", () => {
      const handle = defineAgentCli(
        minimal({
          models: {
            default: "o3",
            apply: "arg",
            bin_args_template: ["-c", 'model="{model}"'],
          },
        }),
      )
      expect(handle.models?.apply).toBe("arg")
      expect(handle.models?.bin_args_template).toEqual(["-c", 'model="{model}"'])
    })
  })

  describe("mode.kind narrowed to \"context\" (SPEC §3.4a route/posture extraction)", () => {
    // `AgentCliMode.kind` no longer accepts "posture" or "route": route is
    // derived from the model catalog (@route) and posture from the harness's
    // ACP mode registry — neither is a manifest mode anymore. Only "context"
    // (an env toggle with no ACP-protocol home) survives as a declarable kind.
    // The casts bypass the compile-time narrowing so the runtime schema's own
    // rejection is what's under test.
    type LegacyMode = { id: string; kind: string; env?: Record<string, string> }
    const withModes = (modes: LegacyMode[]) =>
      minimal({ modes: modes as unknown as AgentCliDefinition["modes"] })

    it("accepts kind: \"context\"", () => {
      const handle = defineAgentCli(
        withModes([{ id: "lean", kind: "context", env: { X: "1" } }]),
      )
      expect(handle.modes?.[0]?.kind).toBe("context")
    })

    it("rejects a legacy kind: \"posture\" mode", () => {
      expect(() =>
        defineAgentCli(withModes([{ id: "plan", kind: "posture" }])),
      ).toThrow(/AIP-45/)
    })

    it("rejects a legacy kind: \"route\" mode", () => {
      expect(() =>
        defineAgentCli(withModes([{ id: "moonshot", kind: "route" }])),
      ).toThrow(/AIP-45/)
    })

    it("still accepts a mode that omits kind (id-inferred by the daemon shim)", () => {
      const handle = defineAgentCli(
        minimal({ modes: [{ id: "default", description: "Standard." }] }),
      )
      expect(handle.modes?.[0]?.kind).toBeUndefined()
    })
  })

  describe("parseAgentCliManifest", () => {
    it("parses a minimal AGENT-CLI.md", () => {
      const md = `---
name: hermes
id: hermes
description: Hermes Agent.
version: 0.1.0
bin: hermes
bin_args: [acp]
install:
  - method: brew
    package: hermes
version_check:
  cmd: hermes --version
  parse: "(\\\\d+\\\\.\\\\d+\\\\.\\\\d+)"
  range: ">=0.13.0"
sandbox: ./SANDBOX.md
protocol: acp
acp: ./hermes-acp.ACP.md
---

# hermes

body
`
      const { frontmatter, body } = parseAgentCliManifest(md)
      expect(frontmatter.id).toBe("hermes")
      expect(frontmatter.protocol).toBe("acp")
      expect(body).toMatch(/body/)
    })

    it("rejects empty frontmatter", () => {
      expect(() => parseAgentCliManifest("# no frontmatter")).toThrow(
        /missing or empty frontmatter/,
      )
    })
  })

  describe("routeSelection (AIP-45 launch-menu drill-down, WP1)", () => {
    it("defaults to undefined (back-compat: absent ⇒ free)", () => {
      expect(defineAgentCli(minimal()).routeSelection).toBeUndefined()
    })

    it("accepts \"free\"", () => {
      expect(defineAgentCli(minimal({ routeSelection: "free" })).routeSelection).toBe("free")
    })

    it("accepts \"derived-from-model\"", () => {
      expect(
        defineAgentCli(minimal({ routeSelection: "derived-from-model" })).routeSelection,
      ).toBe("derived-from-model")
    })

    it("rejects an unrecognized route-selection value", () => {
      expect(() =>
        defineAgentCli(
          minimal({ routeSelection: "sometimes" } as unknown as Partial<AgentCliDefinition>),
        ),
      ).toThrow(/AIP-45/)
    })
  })
})
