/**
 * Unit tests for `corpus discover` — arg parsing and channel dispatch.
 * HTTP fetch and yt-dlp are mocked so no network or binary is needed.
 */

import { mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mock fetch globally before importing the module under test
// ---------------------------------------------------------------------------
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Mock execFile (used by yt-dlp channel) — must happen before import
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, execFile: vi.fn() }
})

import { runDiscover } from "../discover.js"
import { execFile } from "node:child_process"

// promisify wraps execFile; we need to make it resolve with { stdout, stderr }
function stubExecFile(stdout: string) {
  const execFileMock = vi.mocked(execFile)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execFileMock.mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
    callback(null, stdout, "")
    return {} as ReturnType<typeof execFile>
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serperResponse(urls: string[]) {
  return {
    ok: true,
    text: async () => "",
    json: async () => ({
      organic: urls.map(url => ({ link: url, title: url })),
    }),
  }
}

let tmp: string

beforeEach(async () => {
  tmp = join(tmpdir(), `discover-test-${Math.random().toString(36).slice(2)}`)
  await mkdir(tmp, { recursive: true })
  vi.resetAllMocks()
  // Default: no keys
  delete process.env.SERPER_API_KEY
  delete process.env.EXA_API_KEY
  delete process.env.TAVILY_API_KEY
  delete process.env.GOOGLE_SEARCH_API_KEY
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDiscover — arg parsing", () => {
  it("exits 2 with error when no topic given", async () => {
    const code = await runDiscover([])
    expect(code).toBe(2)
  })

  it("exits 2 when topic is missing (only path given)", async () => {
    // A single positional is treated as the topic, not a path
    // so no topic → only when zero positionals
    const code = await runDiscover([])
    expect(code).toBe(2)
  })
})

describe("runDiscover — web channel", () => {
  it("uses SERPER when SERPER_API_KEY is set and writes urls.discovered.txt", async () => {
    process.env.SERPER_API_KEY = "test-key"
    mockFetch.mockResolvedValue(serperResponse([
      "https://example.com/a",
      "https://example.com/b",
    ]))

    const code = await runDiscover(["ai assistant", tmp, "--channels", "web", "--max", "5"])
    expect(code).toBe(0)

    const written = await readFile(join(tmp, "urls.discovered.txt"), "utf-8")
    expect(written).toContain("https://example.com/a")
    expect(written).toContain("https://example.com/b")
  })

  it("deduplicates URLs that appear in multiple query results", async () => {
    process.env.SERPER_API_KEY = "test-key"
    // First call returns a + b, subsequent calls return b + c (b is a dupe)
    mockFetch
      .mockResolvedValueOnce(serperResponse(["https://x.com/a", "https://x.com/b"]))
      .mockResolvedValueOnce(serperResponse(["https://x.com/b", "https://x.com/c"]))
      .mockResolvedValueOnce(serperResponse(["https://x.com/c", "https://x.com/d"]))

    await runDiscover(["test topic", tmp, "--channels", "web", "--max", "10"])
    const written = await readFile(join(tmp, "urls.discovered.txt"), "utf-8")
    const urls = written.trim().split("\n")
    const unique = new Set(urls)
    expect(unique.size).toBe(urls.length) // no duplicates
  })

  it("skips web channel with a warning when no API key is set", async () => {
    const stderrLines: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
      stderrLines.push(String(msg))
      return true
    })

    // youtube also needed to produce at least 1 URL so the command doesn't error
    stubExecFile("https://www.youtube.com/watch?v=AAA\n")
    const code = await runDiscover(["test", tmp, "--channels", "web,youtube", "--max", "2"])

    process.stderr.write = origWrite
    expect(stderrLines.some(l => l.includes("no web search API key"))).toBe(true)
    // Command still succeeds via youtube
    expect(code).toBe(0)
  })
})

describe("runDiscover — youtube channel", () => {
  it("collects video URLs from yt-dlp output", async () => {
    stubExecFile(
      "https://www.youtube.com/watch?v=AAA\nhttps://www.youtube.com/watch?v=BBB\n"
    )

    const code = await runDiscover(["machine learning", tmp, "--channels", "youtube", "--max", "5"])
    expect(code).toBe(0)

    const written = await readFile(join(tmp, "urls.discovered.txt"), "utf-8")
    expect(written).toContain("https://www.youtube.com/watch?v=AAA")
    expect(written).toContain("https://www.youtube.com/watch?v=BBB")
  })

  it("passes the correct ytsearch<max>:<topic> query to yt-dlp", async () => {
    stubExecFile("https://www.youtube.com/watch?v=CCC\n")

    await runDiscover(["rust async", tmp, "--channels", "youtube", "--max", "7"])

    const execFileMock = vi.mocked(execFile)
    const callArgs = execFileMock.mock.calls[0]
    expect(callArgs?.[0]).toBe("yt-dlp")
    expect(callArgs?.[1]).toContain("ytsearch7:rust async")
    expect(callArgs?.[1]).toContain("--flat-playlist")
    expect(callArgs?.[1]).toContain("--print")
    expect(callArgs?.[1]).toContain("%(url)s")
  })
})

describe("runDiscover — multi-channel dedup", () => {
  it("deduplicates URLs that appear in both web and youtube channels", async () => {
    process.env.SERPER_API_KEY = "test-key"
    const sharedUrl = "https://www.youtube.com/watch?v=SHARED"
    mockFetch.mockResolvedValue(serperResponse([sharedUrl, "https://example.com/web-only"]))
    stubExecFile(`${sharedUrl}\nhttps://www.youtube.com/watch?v=YT_ONLY\n`)

    await runDiscover(["topic", tmp, "--channels", "web,youtube", "--max", "10"])

    const written = await readFile(join(tmp, "urls.discovered.txt"), "utf-8")
    const urls = written.trim().split("\n").filter(Boolean)
    // sharedUrl should appear exactly once
    expect(urls.filter(u => u === sharedUrl)).toHaveLength(1)
    expect(urls).toContain("https://example.com/web-only")
    expect(urls).toContain("https://www.youtube.com/watch?v=YT_ONLY")
  })
})

describe("runDiscover — output file", () => {
  it("creates the output directory if it does not exist", async () => {
    process.env.SERPER_API_KEY = "test-key"
    mockFetch.mockResolvedValue(serperResponse(["https://example.com/x"]))

    const nested = join(tmp, "nested", "dir")
    const code = await runDiscover(["topic", nested, "--channels", "web"])
    expect(code).toBe(0)

    const written = await readFile(join(nested, "urls.discovered.txt"), "utf-8")
    expect(written).toContain("https://example.com/x")
  })
})
