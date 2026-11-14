import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { defineHarness } from "../define-agent-cli.js"
import { agentCliFromManifest, parseAgentCliManifest } from "../manifest/index.js"
import type { AgentCliCapabilities, AgentCliDefinition, StreamEvent } from "../types.js"

const minimal = (capabilities: AgentCliCapabilities): AgentCliDefinition => ({
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
  capabilities,
})

const manifest = (capabilities: string): string => `---
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
${capabilities}
---

Body.
`

describe("capabilities.mode_events / typed_prompts (AIP-45)", () => {
  for (const flag of ["mode_events", "typed_prompts"] as const) {
    it(`accepts ${flag} on a defined harness`, () => {
      const handle = defineHarness(minimal({ [flag]: true }))
      expect(handle.capabilities?.[flag]).toBe(true)
    })

    it(`parses ${flag} from a markdown manifest`, () => {
      const parsed = parseAgentCliManifest(manifest(`  ${flag}: false`))
      expect(parsed.frontmatter.capabilities?.[flag]).toBe(false)
      expect(agentCliFromManifest(parsed).capabilities?.[flag]).toBe(false)
    })

    it(`rejects a non-boolean ${flag}`, () => {
      expect(() => parseAgentCliManifest(manifest(`  ${flag}: "yes"`))).toThrow()
    })
  }

  it("accepts hooks next to both flags", () => {
    const parsed = parseAgentCliManifest(
      manifest(`  mode_events: true
  typed_prompts: true
  hooks:
    - event: tool.call
      native_event: PreToolUse
      path: admission
      can_block: true
      handlers: [command]`),
    )
    expect(parsed.frontmatter.capabilities).toMatchObject({
      mode_events: true,
      typed_prompts: true,
      hooks: [{ event: "tool.call", native_event: "PreToolUse" }],
    })
  })

  it("declares the same boolean flags as the vendored HARNESS.schema.json", () => {
    const schemaPath = fileURLToPath(
      new URL("../../../../specs/resources/aip-45/draft/HARNESS.schema.json", import.meta.url),
    )
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      $defs: { capabilities: { properties: Record<string, { type?: string }> } }
    }
    const props = schema.$defs.capabilities.properties
    expect(props.mode_events?.type).toBe("boolean")
    expect(props.typed_prompts?.type).toBe("boolean")
  })
})

describe("AIP-45 stream events", () => {
  // Shapes from STREAM-EVENTS.schema.json and the AIP-45 EXAMPLES.md.
  const events: StreamEvent[] = [
    {
      kind: "mode-changed",
      sessionId: "s1",
      modeId: "execute",
      previousModeId: "plan",
      cause: "agent",
      reason: "plan approved",
    },
    {
      kind: "agent-prompt",
      sessionId: "s1",
      toolCallId: "call_1#1",
      options: [
        { optionId: "approve", name: "Approve plan", kind: "allow_once" },
        { optionId: "reject", name: "Reject plan", kind: "reject_once" },
      ],
      request: "plan-approval",
      planApproval: {
        plan: "# Plan",
        planRef: "plan.md",
        targetModeId: "execute",
        approveOptionId: "approve",
        rejectOptionId: "reject",
      },
    },
    {
      kind: "agent-prompt",
      sessionId: "s1",
      toolCallId: "call_2#2",
      options: [
        { optionId: "answer", name: "Answer", kind: "allow_once" },
        { optionId: "decline", name: "Decline to answer", kind: "reject_once" },
      ],
      request: "question",
      question: { prompt: "Which?", choices: [], allowFreeText: true, freeTextOptionId: "answer" },
    },
  ]

  it("round-trip through JSON unchanged", () => {
    for (const event of events) expect(JSON.parse(JSON.stringify(event))).toEqual(event)
  })
})
