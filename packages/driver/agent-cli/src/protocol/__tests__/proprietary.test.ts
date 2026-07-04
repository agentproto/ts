import { describe, it, expect, vi } from "vitest"
import type { AgentCliClient, AgentCliHandle } from "../../types.js"

const fakeClient: AgentCliClient = {
  sessionId: "fake-sess-1",
  async connect() {},
  async send() {},
  async *events() {},
  async cancel() {},
  async close() {},
}

// These package names never exist on disk. Unlike Jest, vitest's `vi.mock`
// intercepts a dynamic `import()` by specifier regardless of whether it
// resolves on disk — no `virtual: true` flag needed (vitest's `mock()`
// signature only takes `(path, factory)`) — exactly the shape a real
// adapter package's dynamic load hits at runtime.
vi.mock("fake-adapter-named-export", () => ({
  createAgentCliClient: vi.fn((definition: AgentCliHandle) => {
    capturedDefinition = definition
    return fakeClient
  }),
}))

vi.mock("fake-adapter-default-export", () => ({
  default: vi.fn(() => fakeClient),
}))

vi.mock("fake-adapter-async-factory", () => ({
  createAgentCliClient: vi.fn(async () => fakeClient),
}))

vi.mock("fake-adapter-no-factory", () => ({
  somethingElse: 42,
  default: undefined,
}))

let capturedDefinition: AgentCliHandle | undefined

import { createProprietaryProtocolArm } from "../proprietary.js"

const minimalDefinition: AgentCliHandle = {
  name: "fake",
  id: "fake",
  description: "fake",
  version: "0.1.0",
  bin: "in-process",
  install: [{ method: "npm", package: "fake-adapter-named-export" }],
  version_check: { cmd: "true", parse: "(\\d+)", range: ">=0.0.0", timeout_ms: 1000 },
  sandbox: "./SANDBOX.md",
  protocol: "proprietary",
  adapter: "fake-adapter-named-export",
} as AgentCliHandle

describe("createProprietaryProtocolArm", () => {
  it("loads the named createAgentCliClient export and forwards the definition", async () => {
    const arm = await createProprietaryProtocolArm({
      adapter: "fake-adapter-named-export",
      definition: minimalDefinition,
    })
    expect(arm).toBe(fakeClient)
    expect(capturedDefinition).toBe(minimalDefinition)
  })

  it("falls back to a default export factory", async () => {
    const arm = await createProprietaryProtocolArm({
      adapter: "fake-adapter-default-export",
      definition: minimalDefinition,
    })
    expect(arm).toBe(fakeClient)
  })

  it("awaits an async factory", async () => {
    const arm = await createProprietaryProtocolArm({
      adapter: "fake-adapter-async-factory",
      definition: minimalDefinition,
    })
    expect(arm).toBe(fakeClient)
  })

  it("throws a descriptive error when the package exports no usable factory", async () => {
    await expect(
      createProprietaryProtocolArm({
        adapter: "fake-adapter-no-factory",
        definition: minimalDefinition,
      }),
    ).rejects.toThrow(/does not export a 'createAgentCliClient' factory/)
  })

  it("throws a descriptive error when the package cannot be loaded", async () => {
    await expect(
      createProprietaryProtocolArm({
        adapter: "totally-nonexistent-package-xyz",
        definition: minimalDefinition,
      }),
    ).rejects.toThrow(/could not load adapter package 'totally-nonexistent-package-xyz'/)
  })
})
