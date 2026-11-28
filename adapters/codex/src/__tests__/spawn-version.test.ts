import { describe, expect, it } from "vitest"
import { composeSpawn, RuntimeConfigError } from "@agentproto/harness"
import { codex } from "../index.js"

describe("codex spawn version", () => {
  it("pins the ACP wrapper so an available Codex update cannot change a spawn", () => {
    expect(codex.bin).toBe("npx")
    expect(codex.bin_args).toEqual([
      "-y",
      "@agentclientprotocol/codex-acp@2.12.0",
    ])
    expect(codex.install).toContainEqual({
      method: "npm",
      package: "@agentclientprotocol/codex-acp@2.12.0",
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

describe("codex model menu", () => {
  it.each([
    "gpt-6.1-sol",
    "gpt-6.1-sol-pro",
    "gpt-6.1-terra",
    "gpt-6.1-terra-pro",
    "gpt-6.2-sol",
    "gpt-6.2-sol-pro",
    "gpt-6.2-astra",
    "gpt-6.2-astra-pro",
  ])("lists %s", (id) => {
    expect(codex.models?.allowed).toContain(id)
  })

  it("does not list ids that do not exist upstream", () => {
    expect(codex.models?.allowed).not.toContain("gpt-6-terra")
    expect(codex.models?.allowed).not.toContain("gpt-6-codex")
  })
})

describe("codex service_tier / reasoning_effort options", () => {
  const config = (options: Record<string, string>) =>
    JSON.parse(composeSpawn(codex, { options }).env.CODEX_CONFIG ?? "{}") as Record<string, unknown>

  it("service_tier sets codex's service_tier through the wrapper's CODEX_CONFIG", () => {
    expect(config({ service_tier: "fast" })).toEqual({ service_tier: "fast" })
  })

  it("reasoning_effort sets model_reasoning_effort", () => {
    expect(config({ reasoning_effort: "low" })).toEqual({ model_reasoning_effort: "low" })
  })

  it("both together land in the same config object", () => {
    expect(config({ service_tier: "fast", reasoning_effort: "minimal" })).toEqual({
      service_tier: "fast",
      model_reasoning_effort: "minimal",
    })
  })

  it("sets nothing when neither option is given", () => {
    expect(composeSpawn(codex, {}).env.CODEX_CONFIG).toBeUndefined()
    expect(composeSpawn(codex, { options: { model: "gpt-5.5" } }).env.CODEX_CONFIG).toBeUndefined()
  })

  it("rejects values codex does not accept", () => {
    expect(() => composeSpawn(codex, { options: { service_tier: "turbo" } })).toThrow(RuntimeConfigError)
    expect(() => composeSpawn(codex, { options: { reasoning_effort: "extreme" } })).toThrow(RuntimeConfigError)
  })
})
