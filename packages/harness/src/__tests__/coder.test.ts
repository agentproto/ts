import { describe, it, expect, vi } from "vitest"
import { buildCoderArgs, createCoderHarness } from "../harnesses/coder.js"

describe("buildCoderArgs", () => {
  it("defaults to claude-code adapter with opus model", () => {
    const args = buildCoderArgs({ workspace: "/repo" })
    expect(args.adapter).toBe("claude-code")
    expect(args.model).toBe("claude-opus-4-8")
    expect(args.cwd).toBe("/repo")
    expect(args.effort).toBe("high")
  })

  it("hermes engine uses deepseek model", () => {
    const args = buildCoderArgs({ workspace: "/repo", engine: "hermes" })
    expect(args.adapter).toBe("hermes")
    expect(args.model).toBe("deepseek/deepseek-v4-pro")
  })

  it("injects context as spawn prompt", () => {
    const args = buildCoderArgs({
      workspace: "/repo",
      context: { stack: "TypeScript", gateCmds: ["pnpm test"] },
    })
    expect(args.prompt).toContain("TypeScript")
    expect(args.prompt).toContain("pnpm test")
    expect(args.prompt).toContain("## Coding context")
  })

  it("passes through workspaceSlug (no cwd)", () => {
    const args = buildCoderArgs({ workspaceSlug: "my-ws" })
    expect(args.workspaceSlug).toBe("my-ws")
    expect(args.cwd).toBeUndefined()
  })

  it("passes through label and extra mcpServers", () => {
    const mcp = [{ name: "gh", transport: "http" as const }]
    const args = buildCoderArgs({ workspace: "/repo", label: "fix-123", mcpServers: mcp })
    expect(args.label).toBe("fix-123")
    expect(args.mcpServers).toEqual(mcp)
  })

  it("respects model override even with default engine", () => {
    const args = buildCoderArgs({ workspace: "/repo", model: "openai/gpt-4o" })
    expect(args.adapter).toBe("claude-code")
    expect(args.model).toBe("openai/gpt-4o")
  })
})

describe("createCoderHarness", () => {
  it("calls client.start with correct args and returns handle", async () => {
    const fakeSession = { id: "sess_test", status: "running", startedAt: new Date().toISOString() }
    const client = { start: vi.fn().mockResolvedValue(fakeSession) } as any
    const handle = await createCoderHarness(client, { workspace: "/repo" })
    expect(client.start).toHaveBeenCalledOnce()
    expect(client.start.mock.calls[0][0].adapter).toBe("claude-code")
    expect(handle.sessionId).toBe("sess_test")
    expect(handle.adapter).toBe("claude-code")
  })

  it("passes engine=hermes through to start args", async () => {
    const fakeSession = { id: "sess_h", status: "running", startedAt: new Date().toISOString() }
    const client = { start: vi.fn().mockResolvedValue(fakeSession) } as any
    const handle = await createCoderHarness(client, { engine: "hermes", workspaceSlug: "ws1" })
    expect(client.start.mock.calls[0][0].adapter).toBe("hermes")
    expect(client.start.mock.calls[0][0].model).toBe("deepseek/deepseek-v4-pro")
    expect(handle.adapter).toBe("hermes")
  })
})