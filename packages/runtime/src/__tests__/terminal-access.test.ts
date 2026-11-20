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

  it("refuses a gateway-route profile: a PTY cannot be pointed at its endpoint", async () => {
    const gateway = (extra: object) =>
      (async () => ({
        ok: true as const,
        authSpec: {
          mode: "api-key" as const,
          credential: "k",
          setEnv: "OPENROUTER_API_KEY",
          unsetEnv: [],
          explicit: true,
          enforce: "always" as const,
          ...extra,
        },
        accessProfileEcho: echo,
      })) as unknown as typeof resolveAccessProfileAuth
    for (const extra of [{ baseUrl: "https://gw.example/v1" }, {}]) {
      const out = await resolveTerminalAccess({
        argv: ["claude"],
        profileRef: "gw",
        resolveAgentAdapter: async () => adapter,
        resolveProfile: extra.baseUrl
          ? gateway(extra)
          : ((async () => ({
              ok: true as const,
              resolvedRouteGateway: "openrouter",
              authSpec: undefined,
              accessProfileEcho: echo,
            })) as unknown as typeof resolveAccessProfileAuth),
      })
      expect(out).toMatchObject({ ok: false, code: "access_profile_unsupported_route" })
    }
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

  it("checks the --model from argv, not the adapter default, against the profile", async () => {
    for (const argv of [
      ["claude", "-p", "hi", "--model", "claude-opus-5-5"],
      ["claude", "--model=claude-opus-5-5", "-p", "hi"],
    ]) {
      const resolveProfile = vi.fn(async () => ({ ok: false as const, code: "x", message: "m" })) as unknown as typeof resolveAccessProfileAuth
      await resolveTerminalAccess({
        argv,
        profileRef: "anthropic-sub-hodl",
        resolveAgentAdapter: async () => adapter,
        resolveProfile,
      })
      expect(resolveProfile).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-opus-5-5" }))
    }
  })

  it("an explicit model input wins over argv; no --model passes none", async () => {
    const resolveProfile = vi.fn(async () => ({ ok: false as const, code: "x", message: "m" })) as unknown as typeof resolveAccessProfileAuth
    const base = { profileRef: "p", resolveAgentAdapter: async () => adapter, resolveProfile }
    await resolveTerminalAccess({ ...base, argv: ["claude", "--model", "a"], model: "b" })
    expect(resolveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ model: "b" }))
    await resolveTerminalAccess({ ...base, argv: ["claude"] })
    expect(resolveProfile).toHaveBeenLastCalledWith(expect.not.objectContaining({ model: expect.anything() }))
  })
})
