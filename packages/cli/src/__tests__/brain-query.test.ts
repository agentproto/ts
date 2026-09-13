/**
 * Unit tests for `agentproto brain query` — ../commands/brain.ts, with
 * `_daemon-helpers.js` mocked (same seam as permissions-ls.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runBrain } from "../commands/brain.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)
const printNoDaemonError = vi.mocked(helpers.printNoDaemonError)

describe("agentproto brain query", () => {
  let stdoutChunks: string[]
  let stderrChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any

  beforeEach(() => {
    stdoutChunks = []
    stderrChunks = []
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:1", token: undefined }, stale: [] })
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdoutChunks.push(String(chunk))
      return true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderrChunks.push(String(chunk))
      return true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)
  })
  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.clearAllMocks()
  })

  it("defaults --workspace to \"all\", builds the GET url, and prints a human table with the workspace column", async () => {
    httpGetJson.mockResolvedValue({
      workspace: "all",
      hits: [
        {
          sourceId: "sess-abc123",
          workspace: "agentik-studio",
          sessionId: "sess-abc123",
          title: "Brain search design",
          score: 4.2,
          snippet: "…decided to use BM25…",
        },
      ],
    })

    const code = await runBrain(["query", "bm25 search", "--topk", "5"])
    expect(code).toBe(0)
    expect(httpGetJson).toHaveBeenCalledWith(
      "http://127.0.0.1:1/brain/query?q=bm25%20search&workspace=all&topK=5",
    )
    const out = stdoutChunks.join("")
    expect(out).toContain("4.20")
    expect(out).toContain("agentik-studio")
    expect(out).toContain("sess-abc123")
    expect(out).toContain("Brain search design")
    expect(out).toContain("…decided to use BM25…")
  })

  it("passes an explicit --workspace through instead of the all default", async () => {
    httpGetJson.mockResolvedValue({ workspace: "my-ws", hits: [] })
    const code = await runBrain(["query", "hello", "--workspace", "my-ws"])
    expect(code).toBe(0)
    expect(httpGetJson).toHaveBeenCalledWith(
      "http://127.0.0.1:1/brain/query?q=hello&workspace=my-ws",
    )
  })

  it("--json prints the raw JSON response", async () => {
    const payload = { workspace: "all", hits: [] }
    httpGetJson.mockResolvedValue(payload)
    const code = await runBrain(["query", "hello", "--json"])
    expect(code).toBe(0)
    expect(JSON.parse(stdoutChunks.join(""))).toEqual(payload)
  })

  it("prints a no-hits message for an empty result", async () => {
    httpGetJson.mockResolvedValue({ workspace: "all", hits: [] })
    const code = await runBrain(["query", "nothing matches"])
    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain('No hits in workspace "all"')
  })

  it("surfaces workspacesErrored in the human output", async () => {
    httpGetJson.mockResolvedValue({
      workspace: "all",
      hits: [
        {
          sourceId: "sess-ok",
          workspace: "default",
          sessionId: "sess-ok",
          title: "OK session",
          score: 1,
          snippet: "fine",
        },
      ],
      workspacesErrored: ["agentik-studio"],
    })
    const code = await runBrain(["query", "hi"])
    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("workspaces skipped due to an error: agentik-studio")
  })

  it("rejects a missing query with exit code 2", async () => {
    const code = await runBrain(["query", "--json"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("missing required <query>")
    expect(httpGetJson).not.toHaveBeenCalled()
  })

  it("rejects an out-of-range --topk with exit code 2", async () => {
    const code = await runBrain(["query", "hi", "--topk", "999"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("--topk must be an integer 1..50")
    expect(httpGetJson).not.toHaveBeenCalled()
  })

  it("delegates to printNoDaemonError when no daemon is found", async () => {
    discoverDaemon.mockResolvedValue({ found: null, stale: [] })
    const code = await runBrain(["query", "hi"])
    expect(code).toBe(1)
    expect(printNoDaemonError).toHaveBeenCalled()
  })

  it("unknown subcommand exits 2", async () => {
    const code = await runBrain(["bogus"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain('unknown subcommand "bogus"')
  })
})
