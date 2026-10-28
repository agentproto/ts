import { describe, it, expect } from "vitest"
import { defineHarness } from "../define-agent-cli.js"
import { agentCliFromManifest, parseAgentCliManifest } from "../manifest/index.js"
import type {
  AgentCliDefinition,
  NativeHookCapability,
} from "../types.js"

const minimal = (overrides: Partial<AgentCliDefinition> = {}): AgentCliDefinition => ({
  name: "hermes",
  id: "hermes",
  description: "Nous Research Hermes Agent: autonomous CLI agent.",
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

const validHook: NativeHookCapability = {
  event: "tool.call",
  native_event: "PreToolUse",
  path: "admission",
  can_block: true,
  handlers: ["command", "mcp"],
  async: true,
  context: "append",
}

const withHooks = (hooks: readonly NativeHookCapability[]): AgentCliDefinition =>
  minimal({ capabilities: { hooks } })

const manifest = (hooks: string): string => `---
name: hermes
id: hermes
description: Nous Research Hermes Agent.
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
  timeout_ms: 5000
sandbox: ./SANDBOX.md
protocol: acp
acp: ./hermes-acp.ACP.md
capabilities:
  hooks:
${hooks}
---

Body.
`

describe("capabilities.hooks (AIP-71)", () => {
  it("accepts one valid entry and keeps it on the handle", () => {
    const handle = defineHarness(withHooks([validHook]))
    expect(handle.capabilities?.hooks).toEqual([validHook])
  })

  it("parses one valid entry from a markdown manifest and round-trips it", () => {
    const source = manifest(`    - event: tool.call
      native_event: PreToolUse
      path: admission
      can_block: true
      handlers: [command, mcp]
      async: true
      context: append`)
    const parsed = parseAgentCliManifest(source)
    expect(parsed.frontmatter.capabilities?.hooks).toEqual([validHook])
    const handle = agentCliFromManifest(parsed)
    expect(handle.capabilities?.hooks).toEqual([validHook])
  })

  it("rejects an unknown key in an entry", () => {
    expect(() =>
      defineHarness(
        withHooks([
          { ...validHook, unexpected: true } as unknown as NativeHookCapability,
        ]),
      ),
    ).toThrow(/Unrecognized key/)
  })

  it("rejects empty handlers", () => {
    expect(() =>
      defineHarness(withHooks([{ ...validHook, handlers: [] }])),
    ).toThrow(/handlers must not be empty/)
  })

  it("rejects a duplicate handler", () => {
    expect(() =>
      defineHarness(
        withHooks([{ ...validHook, handlers: ["command", "command"] }]),
      ),
    ).toThrow(/handlers must not contain duplicates/)
  })

  it("rejects lifecycle with can_block true", () => {
    expect(() =>
      defineHarness(
        withHooks([{ ...validHook, path: "lifecycle", can_block: true }]),
      ),
    ).toThrow(/can_block must be false when path is lifecycle/)
  })

  it("rejects a duplicate (event, native_event) pair", () => {
    expect(() =>
      defineHarness(withHooks([validHook, { ...validHook }])),
    ).toThrow(/hooks must not repeat the same \(event, native_event\) pair/)
  })

  it("rejects an empty event", () => {
    expect(() =>
      defineHarness(withHooks([{ ...validHook, event: "" }])),
    ).toThrow(/capabilities\.hooks\.0\.event/)
  })

  it("still parses a manifest without hooks", () => {
    const handle = defineHarness(minimal({ capabilities: { streaming: true } }))
    expect(handle.capabilities).toEqual({ streaming: true })
    expect(handle.capabilities?.hooks).toBeUndefined()
  })
})

describe("capabilities.memory (AIP-72 section 9)", () => {
  const memoryManifest = `---
name: hermes
id: hermes
description: Nous Research Hermes Agent.
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
  timeout_ms: 5000
sandbox: ./SANDBOX.md
protocol: acp
acp: ./hermes-acp.ACP.md
capabilities:
  memory:
    inject: native-dir
    capture: native-dir-diff
---

Body.
`

  it("accepts a declaration and keeps it on the handle", () => {
    const memory = { inject: "system-prompt", capture: "none" } as const
    const handle = defineHarness(minimal({ capabilities: { memory } }))
    expect(handle.capabilities?.memory).toEqual(memory)
  })

  it("parses a declaration from a markdown manifest", () => {
    const handle = agentCliFromManifest(parseAgentCliManifest(memoryManifest))
    expect(handle.capabilities?.memory).toEqual({
      inject: "native-dir",
      capture: "native-dir-diff",
    })
  })

  it("rejects an unknown inject value and an unknown key", () => {
    expect(() =>
      defineHarness(
        minimal({ capabilities: { memory: { inject: "env" } as never } }),
      ),
    ).toThrow(/capabilities\.memory\.inject/)
    expect(() =>
      defineHarness(
        minimal({ capabilities: { memory: { digest: true } as never } }),
      ),
    ).toThrow(/Unrecognized key/)
  })
})
