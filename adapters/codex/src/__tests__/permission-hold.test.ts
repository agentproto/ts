import { describe, it, expect } from "vitest"

import { codex } from "../index.js"

describe("adapter-codex permission hold", () => {
  it("enables request_user_input through CODEX_CONFIG only for a held session", () => {
    expect(codex.permissionHoldConfig).toEqual({
      env: "CODEX_CONFIG",
      entries: { features: { default_mode_request_user_input: true } },
    })
    // Same env var as the system-prompt channel, so the two merge.
    expect(codex.systemPrompt).toMatchObject({ via: "inline-config", env: "CODEX_CONFIG" })
  })
})
