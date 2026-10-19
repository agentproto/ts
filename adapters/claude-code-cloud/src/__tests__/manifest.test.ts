import { describe, expect, it } from "vitest"

// The spawn-time compose for a managed cloud session: the host turns a
// `model` the caller names in `agent_start` into `config.options.model` and
// calls `composeSpawn`. Before AIP-66 issue ... the manifest declared no
// `options` at all, so that compose threw
// "[unknown_option at config.options.model] Option 'model' is not declared
// by manifest 'claude-code-cloud'. Known options: (none)" and EVERY cloud
// spawn that named a model was refused before any vendor side effect.
import { composeSpawn } from "@agentproto/driver-agent-cli"
import { claudeCodeCloud } from "../index.js"

describe("claude-code-cloud manifest: model option (AIP-66)", () => {
  it("accepts config.options.model (no unknown_option)", () => {
    const composed = composeSpawn(claudeCodeCloud, {
      options: { model: "claude-opus-5-5" },
    })
    expect(composed.env.ANTHROPIC_MODEL).toBe("claude-opus-5-5")
  })

  it("passes any anthropic model id (string, not enum)", () => {
    const composed = composeSpawn(claudeCodeCloud, {
      options: { model: "claude-sonnet-5" },
    })
    expect(composed.env.ANTHROPIC_MODEL).toBe("claude-sonnet-5")
  })

  it("adds no ANTHROPIC_MODEL when the caller omits the model", () => {
    const composed = composeSpawn(claudeCodeCloud, {
      options: {},
    })
    expect(composed.env.ANTHROPIC_MODEL).toBeUndefined()
  })

  it("keeps the AIP-66 §4 refused-spawn-fields metadata intact", () => {
    expect(claudeCodeCloud.metadata?.refusedSpawnFields).toContain("inference")
  })
})
