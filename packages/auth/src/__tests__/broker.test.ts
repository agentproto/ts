import { describe, it, expect, vi, beforeEach } from "vitest"
import type { AuthProviderHandle } from "../types.js"
import { MemoryStore } from "../store/memory-store.js"

const { runAuthFlowMock } = vi.hoisted(() => ({ runAuthFlowMock: vi.fn() }))
vi.mock("../run-flow.js", () => ({ runAuthFlow: runAuthFlowMock }))

import { CredentialBroker } from "../broker.js"

const provider: AuthProviderHandle = {
  id: "acme",
  description: "d",
  apiBase: "https://api.example",
  auth: { flow: "pat", tokenStore: { keychain: "acme-svc", account: "{server}" } },
}

// Matches resolveStoreRef(provider.auth.tokenStore, "https://api.example").
const ref = { path: "acme-svc", account: "https://api.example" }

describe("CredentialBroker", () => {
  let store: MemoryStore
  let broker: CredentialBroker

  beforeEach(() => {
    store = new MemoryStore()
    runAuthFlowMock.mockReset()
    broker = new CredentialBroker({
      store,
      getProvider: (id) => (id === provider.id ? provider : undefined),
    })
  })

  it("runs the flow and returns Bearer headers when nothing is stored", async () => {
    runAuthFlowMock.mockResolvedValue({ accessToken: "tok-fresh", tokenKind: "pat" })

    const headers = await broker.resolveHeaders({ path: "acme" })

    expect(headers).toEqual({ Authorization: "Bearer tok-fresh" })
    expect(runAuthFlowMock).toHaveBeenCalledTimes(1)
    expect(runAuthFlowMock).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ server: "https://api.example", store }),
    )
  })

  it("returns cached headers without running the flow when the credential is fresh", async () => {
    await store.write(ref, { value: "tok-cached", kind: "pat" })

    const headers = await broker.resolveHeaders({ path: "acme" })

    expect(headers).toEqual({ Authorization: "Bearer tok-cached" })
    expect(runAuthFlowMock).not.toHaveBeenCalled()
  })

  it("refreshes when the stored credential is already expired", async () => {
    await store.write(ref, {
      value: "tok-old",
      kind: "pat",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })
    runAuthFlowMock.mockResolvedValue({ accessToken: "tok-new", tokenKind: "pat" })

    const headers = await broker.resolveHeaders({ path: "acme" })

    expect(headers).toEqual({ Authorization: "Bearer tok-new" })
    expect(runAuthFlowMock).toHaveBeenCalledTimes(1)
  })

  it("refreshes when the stored credential is inside the expiry skew window", async () => {
    await store.write(ref, {
      value: "tok-old",
      kind: "pat",
      expiresAt: new Date(Date.now() + 30_000).toISOString(), // < 60s skew
    })
    runAuthFlowMock.mockResolvedValue({ accessToken: "tok-new", tokenKind: "pat" })

    const headers = await broker.resolveHeaders({ path: "acme" })

    expect(headers).toEqual({ Authorization: "Bearer tok-new" })
    expect(runAuthFlowMock).toHaveBeenCalledTimes(1)
  })

  it("does not refresh when expiresAt is safely past the skew window", async () => {
    await store.write(ref, {
      value: "tok-cached",
      kind: "pat",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })

    const headers = await broker.resolveHeaders({ path: "acme" })

    expect(headers).toEqual({ Authorization: "Bearer tok-cached" })
    expect(runAuthFlowMock).not.toHaveBeenCalled()
  })

  it("runs the flow when the stored credential kind isn't directly bearer-usable", async () => {
    // e.g. a service-auth identity assertion — must be exchanged first.
    await store.write(ref, { value: "assert-jwt", kind: "assertion" })
    runAuthFlowMock.mockResolvedValue({ accessToken: "oat-exchanged", tokenKind: "oat" })

    const headers = await broker.resolveHeaders({ path: "acme" })

    expect(headers).toEqual({ Authorization: "Bearer oat-exchanged" })
    expect(runAuthFlowMock).toHaveBeenCalledTimes(1)
  })

  it("resolves a fresh daemon credential to Bearer headers without running the flow", async () => {
    await store.write(ref, { value: "gdt_fresh", kind: "daemon" })

    const headers = await broker.resolveHeaders({ path: "acme" })

    expect(headers).toEqual({ Authorization: "Bearer gdt_fresh" })
    expect(runAuthFlowMock).not.toHaveBeenCalled()
  })

  it("throws a clear error for an unknown provider id", async () => {
    await expect(broker.resolveHeaders({ path: "bogus" })).rejects.toThrow(
      /unknown auth provider "bogus"/,
    )
    expect(runAuthFlowMock).not.toHaveBeenCalled()
  })

  it("parses '<providerId>/<account>' and passes the account through to the store ref", async () => {
    await store.write(
      { path: "acme-svc", account: "custom-account" },
      { value: "tok-acct", kind: "pat" },
    )

    const headers = await broker.resolveHeaders({ path: "acme/custom-account" })

    expect(headers).toEqual({ Authorization: "Bearer tok-acct" })
    expect(runAuthFlowMock).not.toHaveBeenCalled()
  })

  it("throws when the flow produces no usable access token", async () => {
    runAuthFlowMock.mockResolvedValue({ tokenKind: "pat" })

    await expect(broker.resolveHeaders({ path: "acme" })).rejects.toThrow(
      /no usable access token/,
    )
  })

  it("passes the abort signal through to runAuthFlow", async () => {
    const controller = new AbortController()
    runAuthFlowMock.mockResolvedValue({ accessToken: "tok", tokenKind: "pat" })

    await broker.resolveHeaders({ path: "acme", signal: controller.signal })

    expect(runAuthFlowMock).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it("uses o.server (not provider.apiBase) to resolve the store ref, when given", async () => {
    await store.write(
      { path: "acme-svc", account: "https://other.example" },
      { value: "tok-other", kind: "pat" },
    )

    const headers = await broker.resolveHeaders({
      path: "acme",
      server: "https://other.example",
    })

    expect(headers).toEqual({ Authorization: "Bearer tok-other" })
    expect(runAuthFlowMock).not.toHaveBeenCalled()
  })
})
