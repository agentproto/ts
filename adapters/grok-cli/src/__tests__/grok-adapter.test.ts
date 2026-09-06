import { describe, expect, it } from "vitest"
import { grokCli, grokCliRuntime } from "../index.js"

/**
 * @agentproto/adapter-grok-cli — manifest shape.
 *
 * Hermetic by construction: this adapter, like gemini/codex, ships no
 * spawn/parse code of its own — `defineAgentCli` only builds a static
 * manifest object, so these tests assert on that object directly, with no
 * subprocess, no network, and no real `grok` binary required. The MECHANICAL
 * application of a file-based (external) subscription spec (scrub-only, no
 * bearer injected) is generic driver machinery, already locked in by
 * `packages/driver/agent-cli/src/__tests__/codex-external-auth.test.ts`.
 */

describe("grok-cli manifest", () => {
  it("declares the native ACP spawn recipe and stable identity", () => {
    expect(grokCli.id).toBe("grok-cli")
    expect(grokCli.name).toBe("grok-cli")
    expect(grokCli.protocol).toBe("acp")
    expect(grokCli.bin).toBe("grok")
    // `grok agent stdio` — verified live to speak real ACP JSON-RPC 2.0
    // (initialize / session/new / session/prompt all confirmed against a
    // running grok 1.0.3 binary).
    expect(grokCli.bin_args).toEqual(["agent", "stdio"])
    // A runtime factory is exported alongside the handle.
    expect(typeof grokCliRuntime).toBe("function")
  })

  it("installs via the official x.ai script, not any npm package", () => {
    // xAI ships no npm package for this CLI. In particular this must NOT
    // reference `@xai-official/grok`, an unrelated npm package with no
    // linked repository/homepage and a publish pattern inconsistent with a
    // single vendor (189 versions, same-day bot-like cadence since 2025-10).
    expect(grokCli.install).toEqual([{ method: "curl", url: "https://x.ai/cli/install.sh" }])
    const installUrls = grokCli.install.map((i) => i.url).filter(Boolean)
    for (const url of installUrls) {
      expect(url).not.toContain("xai-official")
    }
    const installPackages = grokCli.install.map((i) => i.package).filter(Boolean)
    expect(installPackages).toEqual([])
  })

  it("declares provider `xai` + a FILE-BASED (external) subscription", () => {
    expect(grokCli.provider).toBe("xai")
    expect(grokCli.authSubscription).toEqual({ external: true })
    // No bearer setEnv — an external subscription injects nothing (money-safe
    // by construction: no OAuth token can land in an api-key channel).
    expect((grokCli.authSubscription as { setEnv?: string }).setEnv).toBeUndefined()
    // No authEnforce ⇒ unconfigured spawns stay ambient (opt-in only).
    expect(grokCli.authEnforce).toBeUndefined()
  })

  it("advertises XAI_API_KEY as the only auth-relevant env var", () => {
    expect(grokCli.auth?.state?.env).toEqual(["XAI_API_KEY"])
    expect(grokCli.models?.env).toEqual({ xai: "XAI_API_KEY" })
  })

  it("sources allowed models from a live-verified CLI model list (no invented ids)", () => {
    expect(grokCli.models?.default).toBe("grok-4.20-0309-non-reasoning")
    expect(grokCli.models?.allowed).toContain("grok-4.5")
    expect(grokCli.models?.allowed).toContain("grok-build-0.1")
    // The default is always eligible.
    expect(grokCli.models?.allowed).toContain(grokCli.models?.default)
    // Every allowed id is a real `grok-*` slug, composed via the documented
    // global `-m` flag.
    for (const m of grokCli.models?.allowed ?? []) {
      expect(m).toMatch(/^grok-/)
    }
    // Image/video generation models (`grok-imagine-*`) are internal tool
    // models, never a selectable chat-session model — must not leak in.
    for (const m of grokCli.models?.allowed ?? []) {
      expect(m).not.toMatch(/^grok-imagine/)
    }
    expect(grokCli.models?.apply).toBe("arg")
    expect(grokCli.models?.bin_args_template).toEqual(["-m", "{model}"])
  })

  it("declares capabilities matching the live ACP `initialize` response, not assumptions", () => {
    // ACP initialize's promptCapabilities was {"image":false,"audio":false,
    // "embeddedContext":true} on a live grok 1.0.3 handshake — multimodal
    // must reflect that, not a guess based on Grok's underlying model family.
    expect(grokCli.capabilities?.multimodal).toBe(false)
    // agentCapabilities.loadSession was `true` with list/resume/close session
    // capabilities present.
    expect(grokCli.capabilities?.resumable).toBe(true)
    expect(grokCli.capabilities?.streaming).toBe(true)
    expect(grokCli.capabilities?.bidirectional).toBe(true)
  })
})
