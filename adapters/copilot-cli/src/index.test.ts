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

  it("has no catalog provider — Copilot bills through the GitHub subscription", () => {
    expect(copilotCli.provider).toBeUndefined()
    expect(copilotCli.modelDerivedApiKey).toBeUndefined()
    expect(copilotCli.models).toBeUndefined()
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
