import { describe, it, expect } from "vitest"
import { agentCliFrontmatterSchema } from "@agentproto/harness"
import { antigravity } from "../index.js"

describe("antigravity adapter manifest", () => {
  it("is an ACP arm spawned as `agy acp`", () => {
    expect(antigravity.protocol).toBe("acp")
    expect(antigravity.acp).toBe("./antigravity-acp.ACP.md")
    expect(antigravity.bin).toBe("agy")
    expect(antigravity.bin_args).toEqual(["acp"])
    expect(antigravity.print).toBeUndefined()
  })

  it("is persistent and resumable via ACP session/load", () => {
    expect(antigravity.session?.mode).toBe("persistent")
    expect(antigravity.capabilities?.resumable).toBe(true)
    expect(antigravity.continuation?.supported).toContain("native-resume")
  })

  it("installs via the official curl script (not npm — agy is not published there)", () => {
    expect(antigravity.install).toEqual([
      { method: "curl", url: "https://antigravity.google/cli/install.sh" },
    ])
  })

  it("declares NO api-key auth env vars (keyring + Google Sign-In only)", () => {
    // Honest: there is no documented API-key env var, so no auth.state.env
    // and no provider.
    expect(antigravity.auth?.state?.env).toBeUndefined()
    expect(antigravity.provider).toBeUndefined()
  })

  it("declares the Google Sign-In login as an external subscription (no bearer injected)", () => {
    expect(antigravity.authSubscription).toEqual({ external: true })
  })

  it("declares no fixed models list and no argv model/effort option (agy acp has no such flags)", () => {
    expect(antigravity.models).toBeUndefined()
    expect(antigravity.options?.map((o) => o.id)).toEqual([
      "agent",
      "dangerously_skip_permissions",
      "terminal_sandbox",
    ])
  })

  it("validates cleanly against the AIP-45 AGENT-CLI frontmatter schema", () => {
    // The handle is projected from the manifest; re-parsing the declared
    // fields through the canonical schema catches any invalid combination
    // the type system alone wouldn't (e.g. enum option without an enum).
    const result = agentCliFrontmatterSchema.safeParse({
      name: antigravity.name,
      id: antigravity.id,
      description: antigravity.description,
      version: antigravity.version,
      bin: antigravity.bin,
      install: antigravity.install,
      version_check: antigravity.version_check,
      auth: antigravity.auth,
      sandbox: antigravity.sandbox,
      protocol: antigravity.protocol,
      bin_args: antigravity.bin_args,
      acp: antigravity.acp,
      session: antigravity.session,
      capabilities: antigravity.capabilities,
      options: antigravity.options,
      continuation: antigravity.continuation,
      metadata: antigravity.metadata,
      tags: antigravity.tags,
    })
    expect(result.success, JSON.stringify(result.error?.issues, null, 2)).toBe(true)
  })
})
