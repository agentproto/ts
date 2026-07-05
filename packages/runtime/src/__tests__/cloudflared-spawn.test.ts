import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"

import { spawnCloudflaredUntil } from "../remote-providers/cloudflared-spawn.js"

/**
 * The helper spawns `cloudflared` by default; these tests inject `node` as
 * the binary (via `binary`) and drive it with tiny `-e` scripts, so the
 * file-capture / readiness / timeout / early-exit logic is exercised
 * deterministically without a real tunnel client.
 */
describe("spawnCloudflaredUntil", () => {
  let dir: string
  const alive: ChildProcess[] = []

  const node = (script: string) => ({
    binary: process.execPath,
    argv: ["-e", script],
  })
  const stayAlive = "setInterval(() => {}, 1000)"

  afterEach(() => {
    for (const p of alive.splice(0)) {
      try {
        p.kill("SIGKILL")
      } catch {
        /* noop */
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("resolves with the regex match once it appears in the output", async () => {
    dir = mkdtempSync(join(tmpdir(), "cfd-spawn-"))
    const logPath = join(dir, "ok.log")
    const seen: string[] = []
    const { argv, binary } = node(
      `process.stdout.write("boot line\\n"); process.stdout.write("MARKER-xyz\\n"); ${stayAlive}`,
    )

    const res = await spawnCloudflaredUntil(argv, {
      binary,
      logPath,
      readyRegex: /MARKER-\w+/,
      timeoutMs: 5_000,
      timeoutMessage: "should not time out",
      onLog: line => seen.push(line),
    })
    alive.push(res.proc)

    expect(res.match).toBe("MARKER-xyz")
    // The forwarder streamed complete lines to onLog.
    expect(seen.some(l => l.includes("boot line"))).toBe(true)

    res.stopTail()
    res.proc.kill("SIGKILL")
  })

  it("rejects with the captured output tail on timeout", async () => {
    dir = mkdtempSync(join(tmpdir(), "cfd-spawn-"))
    const logPath = join(dir, "timeout.log")
    const { argv, binary } = node(
      `process.stdout.write("first\\n"); process.stdout.write("second\\n"); ${stayAlive}`,
    )

    await expect(
      spawnCloudflaredUntil(argv, {
        binary,
        logPath,
        readyRegex: /WILL-NEVER-MATCH/,
        timeoutMs: 600,
        timeoutMessage: "did not become ready in time",
      }),
    ).rejects.toThrow(/did not become ready in time[\s\S]*second/)
  })

  it("rejects with the tail when the process exits before it is ready", async () => {
    dir = mkdtempSync(join(tmpdir(), "cfd-spawn-"))
    const logPath = join(dir, "exit.log")
    const { argv, binary } = node(
      `process.stdout.write("boom\\n"); process.exit(3)`,
    )

    await expect(
      spawnCloudflaredUntil(argv, {
        binary,
        logPath,
        readyRegex: /never/,
        timeoutMs: 5_000,
        timeoutMessage: "unused",
      }),
    ).rejects.toThrow(/exited before it was ready[\s\S]*boom/)
  })
})
