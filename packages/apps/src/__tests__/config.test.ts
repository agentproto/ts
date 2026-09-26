import { describe, it, expect } from "vitest"
import { configApp } from "../config/index.js"
import { CONFIG_TOOLS } from "../config/ui.js"
import { CONFIG_SECTIONS } from "../config/fragment.js"

describe("config app", () => {
  it("exposes stable app identity fields", () => {
    expect(configApp.id).toBe("@agentproto/config")
    expect(configApp.name).toBe("agentproto config")
    expect(configApp.version).toBe("0.1.0")
  })

  it("is UI-only — no agents", () => {
    expect(configApp.agents).toEqual([])
  })

  it("ships the config UI panel with exactly the read-only tools allowlist", () => {
    expect(configApp.ui).toBeDefined()
    expect(configApp.ui!.title).toBe("agentproto config")
    expect(configApp.ui!.tools).toEqual([...CONFIG_TOOLS])
    expect(configApp.ui!.html.length).toBeGreaterThan(0)
  })

  it("declares no write tools in this PR's allowlist", () => {
    const writeTools = [
      "auth_profile_create",
      "auth_profile_delete",
      "auth_profile_set_enabled",
      "auth_profile_set_models",
      "auth_profile_update",
      "config_set",
      "remote_enable",
      "remote_disable",
      "pair_offer",
      "pair_revoke",
      "harness_preset_create",
      "harness_preset_delete",
      "harness_preset_set_default",
      "adapter_install",
      "tunnel_create",
      "tunnel_stop",
    ]
    for (const tool of writeTools) {
      expect(CONFIG_TOOLS).not.toContain(tool)
    }
  })

  it("embeds every section id and the deep-link parser in the panel HTML", () => {
    for (const section of CONFIG_SECTIONS) {
      expect(configApp.ui!.html).toContain(`data-section="${section}"`)
    }
    expect(configApp.ui!.html).toContain("function parseConfigFragment")
    expect(configApp.ui!.html).toContain("function buildConfigFragment")
  })

  it("talks to the daemon only through window.McpApp.connect() + app_tool_call, never a direct fetch", () => {
    expect(configApp.ui!.html).toContain("window.McpApp.connect()")
    expect(configApp.ui!.html).toContain("app_tool_call")
    expect(configApp.ui!.html).not.toMatch(/\bfetch\(/)
  })
})
