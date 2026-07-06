import { describe, expect, it } from "vitest"
import { parseManifest } from "../manifest.js"

describe("parseManifest", () => {
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
