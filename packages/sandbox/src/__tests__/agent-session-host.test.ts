import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createSandboxAgentSessionHost, type SandboxProvider, type SandboxSpec } from "../agent-session-host.js"

const { connectDaemonAgentSessionHostMock } = vi.hoisted(() => ({
  connectDaemonAgentSessionHostMock: vi.fn(),
}))

vi.mock("@agentproto/worktree", () => ({
  connectDaemonAgentSessionHost: connectDaemonAgentSessionHostMock,
}))

function fakeHost(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    spawn: vi.fn(async () => "sess_1"),
    sendPromptAndWait: vi.fn(async () => {}),
    resolveByLabel: vi.fn(() => undefined),
    close: vi.fn(async () => {}),
    ...overrides,
  }
}

function fakeProvider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
  return {
    boot: vi.fn(async () => ({
      mcpUrl: "https://sandbox-123.e2b.dev/mcp",
      sandboxId: "sbx_123",
      stop: vi.fn(async () => {}),
    })),
    ...overrides,
  }
}

const spec: SandboxSpec = { provider: "e2b", config: {} }

// A fake slug distinct from any real credential name (OPENROUTER_API_KEY /
// ANTHROPIC_API_KEY / MOONSHOT_API_KEY may genuinely be set in the ambient
// shell env this test runs under) so process.env fallback tests are isolated.
const FAKE_SLUG = "AGENTPROTO_SANDBOX_TEST_SECRET"

describe("createSandboxAgentSessionHost", () => {
  const originalValue = process.env[FAKE_SLUG]

  beforeEach(() => {
    connectDaemonAgentSessionHostMock.mockReset()
    connectDaemonAgentSessionHostMock.mockImplementation(async () => fakeHost())
  })
  afterEach(() => {
    if (originalValue === undefined) delete process.env[FAKE_SLUG]
    else process.env[FAKE_SLUG] = originalValue
  })

  it("resolves secrets from process.env into the provider's boot env", async () => {
    process.env[FAKE_SLUG] = "or-key-123"
    const provider = fakeProvider()
    await createSandboxAgentSessionHost({
      provider,
      spec,
      secrets: { slugs: [FAKE_SLUG] },
    })
    expect(provider.boot).toHaveBeenCalledWith(spec, { env: { [FAKE_SLUG]: "or-key-123" } })
  })

  it("resolves secrets via a custom resolver instead of process.env", async () => {
    const provider = fakeProvider()
    const resolver = vi.fn(async (name: string) => `resolved-${name}`)
    await createSandboxAgentSessionHost({
      provider,
      spec,
      secrets: { slugs: ["MOONSHOT_API_KEY"], resolver },
    })
    expect(resolver).toHaveBeenCalledWith("MOONSHOT_API_KEY")
    expect(provider.boot).toHaveBeenCalledWith(spec, {
      env: { MOONSHOT_API_KEY: "resolved-MOONSHOT_API_KEY" },
    })
  })

  it("throws when a secret slug can't be resolved (missing-secret case)", async () => {
    delete process.env[FAKE_SLUG]
    const provider = fakeProvider()
    await expect(
      createSandboxAgentSessionHost({
        provider,
        spec,
        secrets: { slugs: [FAKE_SLUG] },
      }),
    ).rejects.toThrow(new RegExp(`missing secret "${FAKE_SLUG}"`))
    expect(provider.boot).not.toHaveBeenCalled()
  })

  it("wires the daemon host to the booted sandbox's mcpUrl", async () => {
    process.env[FAKE_SLUG] = "or-key-123"
    const provider = fakeProvider({
      boot: vi.fn(async () => ({
        mcpUrl: "https://custom-host.e2b.dev/mcp",
        sandboxId: "sbx_456",
        stop: vi.fn(async () => {}),
      })),
    })
    await createSandboxAgentSessionHost({
      provider,
      spec,
      secrets: { slugs: [FAKE_SLUG] },
    })
    expect(connectDaemonAgentSessionHostMock).toHaveBeenCalledWith({
      url: "https://custom-host.e2b.dev/mcp",
    })
  })

  it("stop() closes the daemon host AND stops the sandbox", async () => {
    process.env[FAKE_SLUG] = "or-key-123"
    const close = vi.fn(async () => {})
    connectDaemonAgentSessionHostMock.mockImplementation(async () => fakeHost({ close }))
    const stopBox = vi.fn(async () => {})
    const provider = fakeProvider({
      boot: vi.fn(async () => ({
        mcpUrl: "https://sandbox-123.e2b.dev/mcp",
        sandboxId: "sbx_123",
        stop: stopBox,
      })),
    })
    const host = await createSandboxAgentSessionHost({
      provider,
      spec,
      secrets: { slugs: [FAKE_SLUG] },
    })
    await host.stop()
    expect(close).toHaveBeenCalledTimes(1)
    expect(stopBox).toHaveBeenCalledTimes(1)
  })

  it("delegates spawn/sendPromptAndWait/resolveByLabel to the connected daemon host", async () => {
    process.env[FAKE_SLUG] = "or-key-123"
    const inner = fakeHost()
    connectDaemonAgentSessionHostMock.mockImplementation(async () => inner)
    const provider = fakeProvider()
    const host = await createSandboxAgentSessionHost({
      provider,
      spec,
      secrets: { slugs: [FAKE_SLUG] },
    })
    await host.spawn("hermes", {})
    expect(inner.spawn).toHaveBeenCalledWith("hermes", {})
  })
})
