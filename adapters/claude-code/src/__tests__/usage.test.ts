import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  claudeCodeProjectSlug,
  parseClaudeCodeTranscriptUsage,
  readClaudeCodeUsage,
  resetClaudeCodeUsageCache,
} from "../usage.js"

const FIXTURE = fileURLToPath(new URL("./fixtures/transcript.jsonl", import.meta.url))

/** The fixture's expected totals: msg_A counted once despite two lines,
 *  msg_B has no thinking details, msg_C has no usage, junk lines skipped. */
const FIXTURE_TOTALS = {
  tokensIn: 5,
  tokensOut: 200,
  cacheReadTokens: 41_000,
  cacheWriteTokens: 1_500,
  reasoningTokens: 40,
}

const assistant = (id: string, usage: Record<string, unknown>): string =>
  JSON.stringify({ type: "assistant", message: { id, role: "assistant", content: [], usage } })

describe("parseClaudeCodeTranscriptUsage", () => {
  it("sums per-response usage once per message id, skipping non-usage and malformed lines", () => {
    expect(parseClaudeCodeTranscriptUsage(readFileSync(FIXTURE, "utf8"))).toEqual(FIXTURE_TOTALS)
  })

  it("omits a field no response reported instead of zero-filling it", () => {
    const text = assistant("m1", { input_tokens: 4, output_tokens: 9 })
    expect(parseClaudeCodeTranscriptUsage(text)).toEqual({ tokensIn: 4, tokensOut: 9 })
  })

  it("returns null when the transcript has no usage at all", () => {
    expect(parseClaudeCodeTranscriptUsage('{"type":"user","message":{"content":"hi"}}\n')).toBeNull()
  })
})

describe("readClaudeCodeUsage", () => {
  let tmp: string
  let prevHome: string | undefined
  const cwd = "/work/my-repo"
  const sid = "0b6c0f9e-aaaa-bbbb-cccc-123456789abc"

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cc-usage-test-"))
    prevHome = process.env.HOME
    process.env.HOME = join(tmp, "home")
    resetClaudeCodeUsageCache()
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(tmp, { recursive: true, force: true })
  })

  function projectDir(base: string): string {
    const dir = join(base, "projects", claudeCodeProjectSlug(cwd))
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it("reads the session transcript under the isolated config dir, plus Task sub-agent transcripts", async () => {
    const configDir = join(tmp, "adapter-config")
    const dir = projectDir(configDir)
    copyFileSync(FIXTURE, join(dir, `${sid}.jsonl`))
    mkdirSync(join(dir, sid, "subagents"), { recursive: true })
    writeFileSync(
      join(dir, sid, "subagents", "agent-1.jsonl"),
      assistant("msg_sub", { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1_000 }) + "\n",
    )

    expect(await readClaudeCodeUsage(sid, { cwd, configDir })).toEqual({
      ...FIXTURE_TOTALS,
      tokensIn: 15,
      tokensOut: 220,
      cacheReadTokens: 42_000,
    })
  })

  it("falls back to ~/.claude when the config dir has no transcript", async () => {
    copyFileSync(FIXTURE, join(projectDir(join(tmp, "home", ".claude")), `${sid}.jsonl`))
    expect(await readClaudeCodeUsage(sid, { cwd, configDir: join(tmp, "empty-config") })).toEqual(
      FIXTURE_TOTALS,
    )
  })

  it("reads incrementally: holds a half-written line, and a restated message id replaces rather than adds", async () => {
    const configDir = join(tmp, "cfg")
    const path = join(projectDir(configDir), `${sid}.jsonl`)
    writeFileSync(path, assistant("m1", { input_tokens: 1, output_tokens: 10 }) + "\n")
    expect(await readClaudeCodeUsage(sid, { cwd, configDir })).toEqual({ tokensIn: 1, tokensOut: 10 })

    // A line still being written (no newline yet) is not consumed.
    const next = assistant("m2", { input_tokens: 2, output_tokens: 20 })
    appendFileSync(path, next.slice(0, 25))
    expect(await readClaudeCodeUsage(sid, { cwd, configDir })).toEqual({ tokensIn: 1, tokensOut: 10 })

    appendFileSync(path, next.slice(25) + "\n")
    // Same message id again with a later output count: last one wins.
    appendFileSync(path, assistant("m1", { input_tokens: 1, output_tokens: 15 }) + "\n")
    expect(await readClaudeCodeUsage(sid, { cwd, configDir })).toEqual({ tokensIn: 3, tokensOut: 35 })
  })

  it("re-parses from scratch when the transcript shrinks (rewritten)", async () => {
    const configDir = join(tmp, "cfg")
    const path = join(projectDir(configDir), `${sid}.jsonl`)
    writeFileSync(
      path,
      assistant("m1", { input_tokens: 100, output_tokens: 100 }) +
        "\n" +
        assistant("m2", { input_tokens: 100, output_tokens: 100 }) +
        "\n",
    )
    expect(await readClaudeCodeUsage(sid, { cwd, configDir })).toEqual({ tokensIn: 200, tokensOut: 200 })
    writeFileSync(path, assistant("m9", { input_tokens: 1, output_tokens: 1 }) + "\n")
    expect(await readClaudeCodeUsage(sid, { cwd, configDir })).toEqual({ tokensIn: 1, tokensOut: 1 })
  })

  it("returns null (never throws) with no transcript or no cwd", async () => {
    expect(await readClaudeCodeUsage(sid, { cwd, configDir: join(tmp, "nothing") })).toBeNull()
    expect(await readClaudeCodeUsage(sid)).toBeNull()
  })
})
