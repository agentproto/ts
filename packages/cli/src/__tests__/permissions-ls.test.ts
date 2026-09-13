/**
 * Unit tests for `agentproto permissions ls` plan rendering and the
 * approve/deny `--feedback` flag — ../commands/permissions.ts, with
 * `_daemon-helpers.js` mocked (same seam as permissions-watch.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runPermissions } from "../commands/permissions.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    httpPostJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)
const httpPostJson = vi.mocked(helpers.httpPostJson)

const baseEntry = {
  id: "perm_1",
  sessionId: "s-abc",
  toolCallId: "perm_1",
  text: 'Allow "submit_plan"?',
  options: [{ optionId: "approve", name: "Continue", kind: "allow_once" }],
  requestedAt: new Date().toISOString(),
  ageMs: 4200,
}

describe("agentproto permissions ls — plan rendering", () => {
  let stdoutChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(() => {
    stdoutChunks = []
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:1", token: undefined } } as never)
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdoutChunks.push(String(chunk))
      return true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)
  })
  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.clearAllMocks()
  })

  it("renders the plan text as a multi-line block for entries carrying a suspendPayload _meta", async () => {
    httpGetJson.mockResolvedValue({
      permissions: [
        {
          ...baseEntry,
          toolName: "submit_plan",
          rawInput: { plan: "1. do things" },
          _meta: { "mastra-agent/suspendPayload": { plan: "1. do things\n2. push" } },
        },
      ],
    } as never)
    const code = await runPermissions(["ls"])
    expect(code).toBe(0)
    const out = stdoutChunks.join("")
    expect(out).toContain("PLAN")
    expect(out).toContain("    1. do things\n")
    expect(out).toContain("    2. push\n")
  })

  it("renders a string suspendPayload as-is", async () => {
    httpGetJson.mockResolvedValue({
      permissions: [
        {
          ...baseEntry,
          _meta: { "mastra-agent/suspendPayload": "plain plan text" },
        },
      ],
    } as never)
    const code = await runPermissions(["ls"])
    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("    plain plan text\n")
  })

  it("keeps the truncated rawInput preview for entries without a suspendPayload", async () => {
    httpGetJson.mockResolvedValue({
      permissions: [
        { ...baseEntry, toolName: "Bash", rawInput: { command: "git push --force" } },
      ],
    } as never)
    const code = await runPermissions(["ls"])
    expect(code).toBe(0)
    const out = stdoutChunks.join("")
    expect(out).not.toContain("PLAN")
    expect(out).toContain('{"command":"git push --force"}')
  })
})

describe("agentproto permissions approve/deny — --feedback", () => {
  let stdoutChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(() => {
    stdoutChunks = []
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:1", token: undefined } } as never)
    httpPostJson.mockResolvedValue({ ok: true, decision: "deny" } as never)
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdoutChunks.push(String(chunk))
      return true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)
  })
  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.clearAllMocks()
  })

  it("deny --feedback posts the feedback in the body", async () => {
    const code = await runPermissions(["deny", "perm_1", "--feedback", "do X instead"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledWith(
      "http://127.0.0.1:1/permissions/perm_1",
      { decision: "deny", feedback: "do X instead" },
      undefined,
    )
  })

  it("approve without --feedback posts no feedback key", async () => {
    const code = await runPermissions(["approve", "perm_1"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledWith(
      "http://127.0.0.1:1/permissions/perm_1",
      { decision: "approve" },
      undefined,
    )
  })
})
