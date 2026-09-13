import { describe, it, expect } from "vitest"
import { agentCliFrontmatterSchema } from "@agentproto/driver-agent-cli"
import { antigravity } from "../index.js"

describe("antigravity adapter manifest", () => {
  it("is a print/headless arm (no ACP — feature request #31)", () => {
    expect(antigravity.protocol).toBe("print")
    expect(antigravity.acp).toBeUndefined()
  })

  it("spawns the real `agy` binary with -p and --output-format stream-json", () => {
    expect(antigravity.bin).toBe("agy")
    expect(antigravity.print?.prompt_flag).toBe("-p")
    expect(antigravity.print?.output_format).toEqual(["--output-format", "stream-json"])
  })

  it("declares agy's bespoke event schema, not the Claude default", () => {
    // agy's stream-json events are `{event: …}` envelopes, not Claude's
    // `{type: …}` — see print-arm.ts's antigravity mapper.
    expect(antigravity.print?.event_schema).toBe("antigravity-stream-json")
  })

  it("resumes a prior conversation via --conversation <id>", () => {
    expect(antigravity.print?.resume).toEqual({ flag: "--conversation", kind: "value" })
    expect(antigravity.capabilities?.resumable).toBe(true)
    expect(antigravity.continuation?.supported).toContain("native-resume")
  })

  it("installs via the official curl script (not npm — agy is not published there)", () => {
    expect(antigravity.install).toEqual([
      { method: "curl", url: "https://antigravity.google/cli/install.sh" },
    ])
  })

  it("declares NO api-key auth env vars (keyring + Google Sign-In only)", () => {
    // Honest: there is no documented API-key env var, so no auth.state.env,
    // no provider, no authSubscription.
    expect(antigravity.auth?.state?.env).toBeUndefined()
    expect(antigravity.provider).toBeUndefined()
    expect(antigravity.authSubscription).toBeUndefined()
  })

  it("declares no fixed models list (exact slugs unverified — free-form `model` option instead)", () => {
    expect(antigravity.models).toBeUndefined()
    const modelOpt = antigravity.options?.find((o) => o.id === "model")
    expect(modelOpt?.bin_args_template).toEqual(["--model", "{value}"])
  })

  it("wires effort as a low/medium/high enum option", () => {
    const effort = antigravity.options?.find((o) => o.id === "effort")
    expect(effort?.type).toBe("enum")
    expect(effort?.enum).toEqual(["low", "medium", "high"])
    expect(effort?.bin_args_template).toEqual(["--effort", "{value}"])
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
      print: antigravity.print,
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
