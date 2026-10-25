import { describe, expect, it } from "vitest"
import { AGENT_CLI_FORMAT, SPEC_NAME } from "../index.js"

describe("agent-cli format identity", () => {
  it("exposes the internal format id", () => {
    expect(AGENT_CLI_FORMAT).toBe("agentcli-interactive/v1")
  })

  it("keeps the legacy SPEC_NAME for compatibility", () => {
    expect(SPEC_NAME).toBe("agentcli-interactive/v1")
    expect(SPEC_NAME).toBe(AGENT_CLI_FORMAT)
  })
})
