import { describe, expect, it, vi } from "vitest"

import { resolveTerminalAccess } from "../terminal-access.js"
import type { resolveAccessProfileAuth } from "../session-spawn.js"

const adapter = { authDescriptor: { kind: "stub" }, defaultModel: "claude-sonnet-5-5" } as never

const echo = { profileRef: "claude-subs-agentik", endpoint: "anthropic", method: "oauth-bearer" as const }

describe("resolveTerminalAccess", () => {
  it("turns a profile into the PTY env, scrub list and echo", async () => {
    const resolveProfile = vi.fn(async () => ({
      ok: true as const,
      authSpec: {
        mode: "subscription" as const,
        credential: "tok-123",
        setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
        unsetEnv: ["ANTHROPIC_API_KEY"],
        explicit: true,
        enforce: "always" as const,
        extraEnv: { EXTRA: "1" },
      },
      accessProfileEcho: echo,
    })) as unknown as typeof resolveAccessProfileAuth
    const out = await resolveTerminalAccess({
      argv: ["claude", "--model", "claude-sonnet-5-5"],
      profileRef: "claude-subs-agentik",
      resolveAgentAdapter: async slug => (slug === "claude-code" ? adapter : null),
      resolveProfile,
    })
    expect(out).toEqual({
      ok: true,
      env: { EXTRA: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok-123" },
      unsetEnv: ["ANTHROPIC_API_KEY"],
      echo,
    })
    expect(resolveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: "claude-code", profileRef: "claude-subs-agentik" }),
    )
  })

  it("refuses an argv that is not a provider TUI (a shell has no billing)", async () => {
    const out = await resolveTerminalAccess({
      argv: ["bash"],
      profileRef: "p",
      resolveAgentAdapter: async () => adapter,
    })
    expect(out).toMatchObject({ ok: false, code: "access_profile_unsupported_argv" })
  })

  it("fails closed when the profile cannot be resolved", async () => {
    const out = await resolveTerminalAccess({
      argv: ["claude"],
      profileRef: "ghost",
      resolveAgentAdapter: async () => adapter,
      resolveProfile: (async () => ({
        ok: false as const,
        code: "access_profile_not_found" as const,
        message: 'no auth profile "ghost" found.',
      })) as unknown as typeof resolveAccessProfileAuth,
    })
    expect(out).toEqual({ ok: false, code: "access_profile_not_found", message: 'no auth profile "ghost" found.' })
  })

  it("refuses when the adapter cannot be resolved", async () => {
    const out = await resolveTerminalAccess({
      argv: ["claude"],
      profileRef: "p",
      resolveAgentAdapter: async () => null,
    })
    expect(out).toMatchObject({ ok: false, code: "adapter_not_found" })
  })
})
