import { describe, expect, it } from "vitest"

import { copilotCli, copilotCliRuntime } from "./index.js"

describe("@agentproto/adapter-copilot-cli", () => {
  it("drives GitHub Copilot CLI's first-party ACP server over stdio", () => {
    expect(copilotCli.protocol).toBe("acp")
    expect(copilotCli.bin).toBe("copilot")
    expect(copilotCli.bin_args).toEqual(["--acp", "--stdio"])
    expect(copilotCli.acp).toBe("./copilot-acp.ACP.md")
  })

  it("declares the documented GitHub token env vars (public + enterprise)", () => {
    expect(copilotCli.auth?.state?.env).toEqual([
      "COPILOT_GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ])
  })

  it("declares the CLI's own GitHub login as an external subscription (no bearer injected)", () => {
    expect(copilotCli.authSubscription).toEqual({ external: true })
  })

  it("has no catalog provider — Copilot bills through the GitHub subscription", () => {
    expect(copilotCli.provider).toBeUndefined()
    expect(copilotCli.modelDerivedApiKey).toBeUndefined()
  })

  it("exposes the real Copilot model menu (verified on 1.0.113), applied via ACP config", () => {
    expect(copilotCli.models?.apply).toBe("config")
    expect(copilotCli.models?.default).toBe("claude-sonnet-5.5")
    const allowed = copilotCli.models?.allowed ?? []
    expect(allowed).toEqual(
      expect.arrayContaining(["auto", "claude-sonnet-5.5", "mai-code-2", "mai-code-2-flash"]),
    )
    expect(allowed).not.toContain("gpt-5")
    expect(allowed).not.toContain("claude-sonnet-4.5")
  })

  it("declares image prompts (proved live on 1.0.113) and no steering-dependent behaviour", () => {
    expect(copilotCli.capabilities?.multimodal).toBe(true)
    expect(copilotCli.capabilities?.resumable).toBe(true)
  })

  it("applies model + effort through ACP session config, and GH_HOST via env", () => {
    const model = copilotCli.options?.find((o) => o.id === "model")
    expect(model?.type).toBe("string")
    expect(model?.bin_args_template).toBeUndefined()

    const effort = copilotCli.options?.find((o) => o.id === "effort")
    expect(effort?.enum).toEqual(["low", "medium", "high", "xhigh", "max"])

    const host = copilotCli.options?.find((o) => o.id === "github_host")
    expect(host?.env).toEqual({ GH_HOST: "{value}" })
  })

  it("exposes a runtime factory", () => {
    expect(copilotCliRuntime().definition.id).toBe("copilot-cli")
  })
})
