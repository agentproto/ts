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

  it("hermes engine omits model/effort from args (sent via /model turn instead)", () => {
    const args = buildCoderArgs({ workspace: "/repo", engine: "hermes" })
    expect(args.adapter).toBe("hermes")
    // hermes does not declare model/effort options — omitted from spawn args
    expect(args.model).toBeUndefined()
    expect(args.effort).toBeUndefined()
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
    const client = { start: vi.fn().mockResolvedValue(fakeSession), prompt: vi.fn().mockResolvedValue(undefined) } as any
    const handle = await createCoderHarness(client, { workspace: "/repo" })
    expect(client.start).toHaveBeenCalledOnce()
    expect(client.start.mock.calls[0][0].adapter).toBe("claude-code")
    expect(handle.sessionId).toBe("sess_test")
    expect(handle.adapter).toBe("claude-code")
    // claude-code: model goes in start args, not via /model turn
    expect(client.prompt).not.toHaveBeenCalled()
  })

  it("hermes: omits model from start args, sends /model turn and waits", async () => {
    const fakeWait = { sessionId: "sess_h", event: "turn-end" }
    const fakeSession = { id: "sess_h", status: "running", startedAt: new Date().toISOString() }
    const client = {
      start: vi.fn().mockResolvedValue(fakeSession),
      prompt: vi.fn().mockResolvedValue(undefined),
      waitForAny: vi.fn().mockResolvedValue(fakeWait),
    } as any
    const handle = await createCoderHarness(client, { engine: "hermes", workspaceSlug: "ws1" })
    expect(client.start.mock.calls[0][0].adapter).toBe("hermes")
    // model must NOT be in spawn args for hermes
    expect(client.start.mock.calls[0][0].model).toBeUndefined()
    // model is sent as a /model slash-command turn instead
    expect(client.prompt).toHaveBeenCalledWith("sess_h", "/model deepseek/deepseek-v4-pro")
    // and we wait for that turn to settle before returning
    expect(client.waitForAny).toHaveBeenCalledWith(["sess_h"], { event: "turn-end", timeoutMs: 15_000 })
    expect(handle.adapter).toBe("hermes")
    expect(handle.model).toBe("deepseek/deepseek-v4-pro")
  })
})