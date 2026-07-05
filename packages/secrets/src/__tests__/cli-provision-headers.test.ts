import { describe, it, expect } from "vitest"
import {
  resolveProvisionHeaders,
  type AuthHeaderResolver,
  type ProvisionAuthDeps,
} from "../cli.js"

function fakeDeps(opts: {
  registered: boolean
  headers?: Record<string, string>
}): { deps: ProvisionAuthDeps; calls: Array<{ path: string; audience?: string }> } {
  const calls: Array<{ path: string; audience?: string }> = []
  const resolver: AuthHeaderResolver = {
    async resolveHeaders(o) {
      calls.push({ path: o.path, audience: o.audience })
      return opts.headers ?? { Authorization: "Bearer brokered-token" }
    },
  }
  return {
    deps: { isRegistered: () => opts.registered, resolver },
    calls,
  }
}

describe("@agentproto/secrets cli — provision auth-header brokering", () => {
  it("with no --header and a registered provider, resolves the Authorization header via the broker", async () => {
    const { deps, calls } = fakeDeps({ registered: true })

    const headers = await resolveProvisionHeaders("guilde", [], deps)

    expect(headers).toEqual({ Authorization: "Bearer brokered-token" })
    expect(calls).toEqual([{ path: "guilde", audience: "api" }])
  })

  it("--header overrides the broker, which is never consulted", async () => {
    const { deps, calls } = fakeDeps({ registered: true })

    const headers = await resolveProvisionHeaders(
      "guilde",
      ["Authorization: Bearer explicit-token"],
      deps,
    )

    expect(headers).toEqual({ Authorization: "Bearer explicit-token" })
    expect(calls).toEqual([])
  })

  it("an explicit header still wins even when merged with any broker output (broker skipped entirely)", async () => {
    const { deps, calls } = fakeDeps({
      registered: true,
      headers: { Authorization: "Bearer brokered-token", "X-Extra": "1" },
    })

    const headers = await resolveProvisionHeaders(
      "guilde",
      ["X-Custom: mine"],
      deps,
    )

    expect(headers).toEqual({ "X-Custom": "mine" })
    expect(calls).toEqual([])
  })

  it("an unregistered provider degrades gracefully to the explicit headers (empty when none), without calling the broker", async () => {
    const { deps, calls } = fakeDeps({ registered: false })

    const headers = await resolveProvisionHeaders("some-unknown-provider", [], deps)

    expect(headers).toEqual({})
    expect(calls).toEqual([])
  })

  it("an unregistered provider with an explicit --header still uses the explicit header", async () => {
    const { deps, calls } = fakeDeps({ registered: false })

    const headers = await resolveProvisionHeaders(
      "some-unknown-provider",
      ["Authorization: Bearer explicit-token"],
      deps,
    )

    expect(headers).toEqual({ Authorization: "Bearer explicit-token" })
    expect(calls).toEqual([])
  })

  it("propagates a broker resolution failure (e.g. auth flow error) rather than swallowing it", async () => {
    const resolver: AuthHeaderResolver = {
      async resolveHeaders() {
        throw new Error("auth flow for \"guilde\" failed")
      },
    }
    const deps: ProvisionAuthDeps = { isRegistered: () => true, resolver }

    await expect(resolveProvisionHeaders("guilde", [], deps)).rejects.toThrow(
      /auth flow for "guilde" failed/,
    )
  })
})
