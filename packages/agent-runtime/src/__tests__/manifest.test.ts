import { describe, expect, it } from "vitest"
import { MULTI_AGENT_RUNTIME_SCHEMA, parseManifest } from "../manifest.js"

describe("parseManifest", () => {
  it("writes the canonical runtime/v1 schema tag", () => {
    expect(MULTI_AGENT_RUNTIME_SCHEMA).toBe("runtime/v1")
  })

  it("accepts per-participant command/args/model config", () => {
    const manifest = parseManifest(`---
schema: agentruntimes/v1
kind: MultiAgentRuntime
id: test-swarm
participants:
  - id: strategist
    executor: agent-cli
    displayName: Strategist
    role: ./roles/strategist.md
    config:
      command: claude
      model: opus
      args:
        - --print
        - --output-format=json
  - id: skeptic
    executor: agent-cli
    displayName: Skeptic
    config:
      model: sonnet
substrate:
  kind: file
  path: ./conversation.md
dispatcher:
  kind: mention
state:
  kind: fs
  dir: ./state
---

Test swarm.
`)

    expect(manifest.participants).toHaveLength(2)
    const strategist = manifest.participants.at(0)!
    const skeptic = manifest.participants.at(1)!
    expect(strategist.config).toEqual({
      command: "claude",
      model: "opus",
      args: ["--print", "--output-format=json"],
    })
    expect(skeptic.config).toEqual({ model: "sonnet" })
  })

  it("parses a manifest carrying the canonical runtime/v1 tag", () => {
    const manifest = parseManifest(`---
schema: runtime/v1
kind: MultiAgentRuntime
id: canonical-swarm
participants:
  - id: reviewer
    executor: agent-cli
substrate: { kind: file }
dispatcher: { kind: mention }
---
`)
    expect(manifest.schema).toBe("runtime/v1")
  })

  it("still parses the legacy agentruntimes/v1 tag", () => {
    const manifest = parseManifest(`---
schema: agentruntimes/v1
kind: MultiAgentRuntime
id: legacy-swarm
participants:
  - id: reviewer
    executor: agent-cli
substrate: { kind: file }
dispatcher: { kind: mention }
---
`)
    expect(manifest.schema).toBe("agentruntimes/v1")
  })

  it("keeps config optional for backward compatibility", () => {
    const manifest = parseManifest(`---
schema: agentruntimes/v1
kind: MultiAgentRuntime
id: simple-swarm
participants:
  - id: reviewer
    executor: agent-cli
    displayName: Reviewer
    role: ./roles/reviewer.md
substrate: { kind: file }
dispatcher: { kind: mention }
---

Simple swarm.
`)

    const reviewer = manifest.participants.at(0)!
    expect(reviewer.config).toBeUndefined()
  })
})
