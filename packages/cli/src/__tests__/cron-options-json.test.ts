/**
 * `agentproto cron add --options-json <json|@file>` — agent-kind spawn-field
 * passthrough. The daemon already accepts every `agent_start` field on an
 * `agent` cron action (cron-mcp-parity.test.ts); this tests the CLI parsing:
 * @file loading, fail-fast on malformed JSON / non-object / `kind` key,
 * refusal for non-agent kinds, and that discrete flags win over colliding
 * keys. Follows the fake-daemon pattern in cron-timeout.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCron } from "../commands/cron.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpPostJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpPostJson = vi.mocked(helpers.httpPostJson)

describe("agentproto cron add --options-json", () => {
  let stderrChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(() => {
    stderrChunks = []
    stderrSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stderr as any, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk))
        return true
      })
    stdoutSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stdout as any, "write")
      .mockImplementation(() => true)
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpPostJson.mockResolvedValue({ id: "job_1", schedule: "* * * * *", recurring: true })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("merges agent_start fields into the agent action, discrete flags winning", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "0 */2 * * *",
      "--adapter",
      "pi",
      "--model",
      "openrouter/z-ai/glm-5.3-flash",
      "--cwd",
      "/tmp/from-flag",
      "--prompt",
      "health check",
      "--options-json",
      '{"mcpServers":[{"name":"gateway","transport":"http","ref":"http://127.0.0.1:18790/mcp"}],"model":"openrouter/other","cwd":"/tmp/from-json","label":"session-label"}',
    ])
    expect(code).toBe(0)
    const body = httpPostJson.mock.calls[0]![1] as {
      action: Record<string, unknown>
    }
    expect(body.action.kind).toBe("agent")
    expect(body.action.adapter).toBe("pi")
    expect(body.action.model).toBe("openrouter/z-ai/glm-5.3-flash")
    expect(body.action.cwd).toBe("/tmp/from-flag")
    expect(body.action.prompt).toBe("health check")
    expect(body.action.mcpServers).toEqual([
      { name: "gateway", transport: "http", ref: "http://127.0.0.1:18790/mcp" },
    ])
    expect(body.action.label).toBe("session-label")
  })

  it("loads @file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-options-json-"))
    try {
      const file = join(dir, "fields.json")
      writeFileSync(file, '{"title":"nightly"}')
      const code = await runCron([
        "add",
        "--schedule",
        "0 9 * * 1-5",
        "--adapter",
        "pi",
        "--prompt",
        "standup",
        "--options-json",
        `@${file}`,
      ])
      expect(code).toBe(0)
      const body = httpPostJson.mock.calls[0]![1] as { action: Record<string, unknown> }
      expect(body.action.title).toBe("nightly")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects malformed JSON without touching the daemon", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--adapter",
      "pi",
      "--prompt",
      "x",
      "--options-json",
      "{not json",
    ])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("invalid --options-json")
  })

  it("rejects a non-object without touching the daemon", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--adapter",
      "pi",
      "--prompt",
      "x",
      "--options-json",
      "[1,2]",
    ])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("expected a JSON object")
  })

  it("refuses a kind override without touching the daemon", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--adapter",
      "pi",
      "--prompt",
      "x",
      "--options-json",
      '{"kind":"tool"}',
    ])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain('"kind" is derived from the discrete flags')
  })

  it("refuses --options-json on a --command job", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--command",
      "echo",
      "--options-json",
      '{"title":"x"}',
    ])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("only applies to --adapter")
  })
})