import { describe, it, expect, vi, beforeEach } from "vitest"
import type {
  AuthProviderHandle,
  DiscoveredEndpoints,
  FlowResult,
} from "../types.js"

// Mock the discovery + engine boundaries so we test ONLY the dispatch/
// discovery-orchestration logic in run-flow.ts.
const { patRun, saRun, discoverMock, DiscoveryError } = vi.hoisted(() => ({
  patRun: vi.fn(),
  saRun: vi.fn(),
  discoverMock: vi.fn(),
  DiscoveryError: class DiscoveryError extends Error {},
}))

vi.mock("../discover.js", () => ({
  discoverEndpoints: discoverMock,
  DiscoveryError,
}))
vi.mock("../flow-engines/index.js", () => ({
  FLOW_ENGINES: {
    pat: { id: "pat", run: patRun },
    "service-auth": { id: "service-auth", run: saRun },
  },
}))

import { runAuthFlow } from "../run-flow.js"

const patProvider = {
  id: "p",
  description: "d",
  apiBase: "https://api.example",
  auth: { flow: "pat", tokenStore: { keychain: "k" } },
} as AuthProviderHandle

const saProvider = {
  id: "s",
  description: "d",
  apiBase: "https://api.example",
  auth: { flow: "service-auth", tokenStore: { keychain: "k" } },
} as AuthProviderHandle

const okResult: FlowResult = { accessToken: "x", tokenKind: "pat" }
const discovered = { tokenEndpoint: "t" } as DiscoveredEndpoints

describe("runAuthFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    patRun.mockResolvedValue(okResult)
    saRun.mockResolvedValue({ accessToken: "y", tokenKind: "oat" })
  })

  it("dispatches to the engine named by provider.auth.flow", async () => {
    const r = await runAuthFlow(patProvider, { server: "https://api.example" })
    expect(patRun).toHaveBeenCalledOnce()
    expect(saRun).not.toHaveBeenCalled()
    expect(r).toEqual(okResult)
  })

  it("does NOT attempt discovery for the pat flow", async () => {
    await runAuthFlow(patProvider, { server: "https://api.example" })
    expect(discoverMock).not.toHaveBeenCalled()
    expect(patRun).toHaveBeenCalledWith(
      patProvider,
      null,
      expect.objectContaining({ server: "https://api.example" }),
    )
  })

  it("attempts discovery for service-auth and forwards the result", async () => {
    discoverMock.mockResolvedValue(discovered)
    await runAuthFlow(saProvider, { server: "https://api.example" })
    expect(discoverMock).toHaveBeenCalledWith("https://api.example", {
      signal: undefined,
    })
    expect(saRun).toHaveBeenCalledWith(
      saProvider,
      discovered,
      expect.anything(),
    )
  })

  it("forwards null to the engine when discovery fails", async () => {
    discoverMock.mockRejectedValue(new DiscoveryError("boom"))
    await runAuthFlow(saProvider, { server: "https://api.example", quiet: true })
    expect(saRun).toHaveBeenCalledWith(saProvider, null, expect.anything())
  })

  it("skips discovery when endpoints are pre-supplied", async () => {
    await runAuthFlow(saProvider, {
      server: "https://api.example",
      discovered,
    })
    expect(discoverMock).not.toHaveBeenCalled()
    expect(saRun).toHaveBeenCalledWith(saProvider, discovered, expect.anything())
  })

  it("throws on an unknown flow", async () => {
    const bogus = {
      ...saProvider,
      auth: { flow: "nope", tokenStore: { keychain: "k" } },
    } as unknown as AuthProviderHandle
    await expect(
      runAuthFlow(bogus, { server: "https://api.example" }),
    ).rejects.toThrow(/unknown flow/)
  })
})
