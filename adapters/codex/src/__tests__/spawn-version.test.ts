import { describe, expect, it } from "vitest"
import { codex } from "../index.js"

describe("codex spawn version", () => {
  it("pins the ACP wrapper so an available Codex update cannot change a spawn", () => {
    expect(codex.bin).toBe("npx")
    expect(codex.bin_args).toEqual([
      "-y",
      "@agentclientprotocol/codex-acp@1.13.1",
    ])
    expect(codex.install).toContainEqual({
      method: "npm",
      package: "@agentclientprotocol/codex-acp@1.13.1",
      global: true,
    })
  })
})

describe("codex state home", () => {
  // An app-boundary spawn denies $HOME; the driver gives codex its own
  // CODEX_HOME from this declaration (packages/runtime
  // app-boundary-codex-parallel.test.ts mirrors it end to end).
  it("declares CODEX_HOME so a confined spawn gets a writable home rooted at its cwd", () => {
    expect(codex.stateHome).toEqual({
      env: "CODEX_HOME",
      defaultDir: ".codex",
      share: ["auth.json"],
      seed: { "config.toml": "project_root_markers = []\n" },
    })
  })
})
