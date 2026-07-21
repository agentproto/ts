import { describe, expect, it } from "vitest"

import { stampOrigin } from "../commands/mcp-bridge.logic.js"

describe("stampOrigin", () => {
  it("stamps the host name onto an agent_start with no origin", () => {
    const out = stampOrigin({ name: "agent_start", arguments: { adapter: "claude-code" } }, "codex")
    expect(out.arguments).toEqual({ adapter: "claude-code", origin: "codex" })
  })

  it("adds arguments when the call had none", () => {
    const out = stampOrigin({ name: "agent_start" }, "cursor")
    expect(out.arguments).toEqual({ origin: "cursor" })
  })

  it("never overrides an origin the caller set explicitly", () => {
    const params = { name: "agent_start", arguments: { adapter: "hermes", origin: "cron" } }
    expect(stampOrigin(params, "codex")).toBe(params)
    expect(stampOrigin(params, "codex").arguments?.origin).toBe("cron")
  })

  it("leaves non-spawn tools untouched", () => {
    const params = { name: "session_list", arguments: {} }
    expect(stampOrigin(params, "codex")).toBe(params)
  })

  it("is a no-op when the host name is unknown", () => {
    const params = { name: "agent_start", arguments: { adapter: "claude-code" } }
    expect(stampOrigin(params, undefined)).toBe(params)
  })
})
