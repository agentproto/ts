import { describe, it, expect } from "vitest"
import { gemini, geminiRuntime } from "../index.js"

/**
 * @agentproto/adapter-gemini — manifest shape, with a focus on the billing-auth
 * surface that distinguishes this native adapter from the generic `gemini-cli`
 * ACP catalog entry.
 *
 * The MECHANICAL application of a file-based (external) subscription spec
 * (scrub-only, no bearer injected) is generic driver machinery, locked in by
 * `packages/driver/agent-cli/src/__tests__/codex-external-auth.test.ts`; the
 * gemini-specific scrub set (`GOOGLE_GENERATIVE_AI_API_KEY` + `GEMINI_API_KEY` +
 * `GOOGLE_API_KEY`) and the fail-loud / ambient / both-auth-paths spawn
 * integration are covered in `@agentproto/runtime`'s `spawn-defaults.test.ts`
 * and `session-spawn.test.ts`. This file asserts the manifest those tests rely
 * on is what the adapter actually ships.
 */

describe("gemini manifest", () => {
  it("declares the native ACP spawn recipe and stable identity", () => {
    expect(gemini.id).toBe("gemini")
    expect(gemini.name).toBe("gemini")
    expect(gemini.protocol).toBe("acp")
    expect(gemini.bin).toBe("gemini")
    expect(gemini.bin_args).toEqual(["--experimental-acp"])
    // A runtime factory is exported alongside the handle.
    expect(typeof geminiRuntime).toBe("function")
  })

  it("installs via the Google Gemini CLI npm package", () => {
    expect(gemini.install).toEqual([
      { method: "npm", package: "@google/gemini-cli", global: true },
    ])
  })

  it("declares provider `google` + a FILE-BASED (external) subscription scrubbing both sibling keys", () => {
    // Single-provider adapter: the catalog provider drives which api-key var is
    // scrubbed automatically (GOOGLE_GENERATIVE_AI_API_KEY). GEMINI_API_KEY and
    // GOOGLE_API_KEY are the siblings — both must be scrubbed because an env API
    // key OVERRIDES the OAuth login in Google's precedence.
    expect(gemini.provider).toBe("google")
    expect(gemini.authSubscription).toEqual({
      external: true,
      conflictEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    })
    // No bearer setEnv — an external subscription injects nothing (money-safe by
    // construction: no OAuth token can land in an api-key channel).
    expect((gemini.authSubscription as { setEnv?: string }).setEnv).toBeUndefined()
    // No authEnforce ⇒ unconfigured spawns stay ambient (opt-in only).
    expect(gemini.authEnforce).toBeUndefined()
  })

  it("advertises every api-key rail the Gemini CLI honors as auth state (so the scrub is complete)", () => {
    expect(gemini.auth?.state?.env).toEqual([
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
    ])
  })

  it("sources allowed models from the catalog's Google line (no invented ids)", () => {
    expect(gemini.models?.default).toBe("gemini-2.5-pro")
    expect(gemini.models?.allowed).toContain("gemini-2.5-pro")
    expect(gemini.models?.allowed).toContain("gemini-2.5-flash")
    // The default is always eligible.
    expect(gemini.models?.allowed).toContain(gemini.models?.default)
    // Every allowed id is a real `gemini-*` slug, composed via the documented
    // global `-m` flag.
    for (const m of gemini.models?.allowed ?? []) {
      expect(m).toMatch(/^gemini-/)
    }
    expect(gemini.models?.apply).toBe("arg")
    expect(gemini.models?.bin_args_template).toEqual(["-m", "{model}"])
  })
})
