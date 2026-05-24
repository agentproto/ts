/**
 * Local-runtime `corpus` binary end-to-end test.
 *
 * Spawns the built `corpus` binary against a tmpdir workspace and
 * walks the full flow: init → validate → lint → events:emit →
 * events:tail. Asserts the binary's exit codes + stdout patterns
 * match the same kit behavior exercised by @agentproto/corpus's
 * workspace unit tests, so the local and cloud topologies stay in
 * agreement.
 */

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// packages/corpus-cli/src/__tests__ → packages/corpus-cli/dist/cli.mjs
const CLI_BIN = path.resolve(__dirname, "../../dist/cli.mjs")

interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: {
        ...process.env,
        // Force a stable identity slug across CI environments.
        USER: "test-actor",
        USERNAME: "test-actor",
      },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
    child.on("error", reject)
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr })
    )
  })
}

describe("corpus CLI — end-to-end", () => {
  let tmp: string

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "corpus-cli-m14-"))
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("--help exits 0 with usage block", async () => {
    const r = await runCli(["--help"])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/corpus — AIP-10 corpus workspace operator/)
    expect(r.stdout).toContain("init <vertical>")
  })

  it("--version exits 0", async () => {
    const r = await runCli(["--version"])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^corpus v0\./)
  })

  it("unknown command exits 2 with helpful stderr", async () => {
    const r = await runCli(["frobnicate"])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/unknown command "frobnicate"/)
  })

  it("init marketing scaffolds the workspace at the target path", async () => {
    const ws = path.join(tmp, "ws")
    const r = await runCli(["init", "marketing", ws])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(
      /initialized "marketing" preset \(Marketing Expert Corpus\)/
    )
    // The marketing preset ships 30+ files. Assert a number ≥ 30
    // (loose enough to tolerate small future additions, tight enough
    // to fail if the preset is empty / mis-loaded).
    expect(r.stdout).toMatch(/\d{2,} files written/)
    const n = Number(r.stdout.match(/(\d+) files written/)?.[1] ?? "0")
    expect(n).toBeGreaterThanOrEqual(30)
  })

  it("init on an existing workspace refuses (exit 1)", async () => {
    const ws = path.join(tmp, "ws")
    const r = await runCli(["init", "marketing", ws])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/refusing to overwrite/)
  })

  it("init with unknown slug exits 2", async () => {
    const ws = path.join(tmp, "ws-unknown")
    const r = await runCli(["init", "frobology", ws])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/not found in any configured package/)
  })

  it("validate prints 0 errors on the freshly-init'd workspace (exit 0)", async () => {
    const ws = path.join(tmp, "ws")
    const r = await runCli(["validate", ws])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/all files conform to AIP schemas/)
  })

  it("lint prints info-level orphans on the freshly-init'd workspace (exit 0)", async () => {
    const ws = path.join(tmp, "ws")
    const r = await runCli(["lint", ws])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/INFO\s+\[orphan-all\]/)
    // exit 0 because no errors — orphans are info-level by KNOWLEDGE.md design
  })

  it("events:emit on a workspace appends to _log.md (exit 0)", async () => {
    const ws = path.join(tmp, "ws")
    const r = await runCli([
      "events:emit",
      "corpus.entry.promoted",
      "--payload",
      JSON.stringify({ slug: "foo", kind: "principle" }),
      ws,
    ])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(
      /emitted corpus\.entry\.promoted at .+ by ws:\/\/users\/test-actor/
    )
  })

  it("events:emit with invalid JSON payload exits 2", async () => {
    const ws = path.join(tmp, "ws")
    const r = await runCli([
      "events:emit",
      "corpus.entry.promoted",
      "--payload",
      "{not json",
      ws,
    ])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/must be valid JSON/)
  })

  it("events:emit with missing --payload exits 2", async () => {
    const ws = path.join(tmp, "ws")
    const r = await runCli([
      "events:emit",
      "corpus.entry.promoted",
      ws,
    ])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/requires --payload/)
  })

  it("events:tail prints the _log.md with AIP-10 header + emitted lines", async () => {
    const ws = path.join(tmp, "ws")
    const r = await runCli(["events:tail", ws])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/# Corpus activity log/)
    expect(r.stdout).toMatch(
      /corpus\.entry\.promoted\s+by ws:\/\/users\/test-actor/
    )
  })

  it("validate on a non-workspace exits 1 with a hint", async () => {
    const r = await runCli(["validate", path.join(tmp, "not-a-workspace")])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/no KNOWLEDGE\.md/)
    expect(r.stderr).toMatch(/corpus init/)
  })
})
