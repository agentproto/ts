import { describe, expect, it } from "vitest"
import { codex } from "../index.js"

describe("codex spawn version", () => {
  it("pins the ACP wrapper so an available Codex update cannot change a spawn", () => {
    expect(codex.bin).toBe("npx")
    expect(codex.bin_args).toEqual([
      "-y",
      "@agentclientprotocol/codex-acp@1.1.14",
    ])
    expect(codex.install).toContainEqual({
      method: "npm",
      package: "@agentclientprotocol/codex-acp@1.1.14",
      global: true,
    })
  })
})
