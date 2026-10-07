/**
 * `cloudflare-quick` must always be hermetic to the LOCAL user's own
 * `~/.cloudflared/config.yml` — if that file carries hostname-specific
 * ingress rules (from an unrelated named tunnel the user set up once),
 * cloudflared's quick-tunnel `--url` forward gets shadowed by them and
 * every request 404s at the edge (`ingressRule=2
 * originService=http_status:404`), even though the tunnel itself looks
 * "up". `quick.ts` works around this by writing its own per-run sentinel
 * config (no `ingress:` key) and passing it via `--config`, which makes
 * cloudflared ignore `~/.cloudflared/config.yml` entirely. This test pins
 * that: the exact argv cloudflared is spawned with, and that the sentinel
 * file it points at carries no `ingress:` key (the thing that would
 * resurrect the shadowing bug if a future edit added one back).
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventEmitter } from "node:events"

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    execFile: (
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, { stdout: "cloudflared version 2026.1.0\n", stderr: "" })
    },
  }
})

const spawnCalls: Array<{ argv: string[] }> = []

vi.mock("../remote-providers/cloudflared-spawn.js", () => ({
  spawnCloudflaredUntil: vi.fn(async (argv: string[]) => {
    spawnCalls.push({ argv })
    const proc = Object.assign(new EventEmitter(), { pid: 4242, kill: () => {} })
    return {
      proc,
      match: "https://fake-tunnel-id.trycloudflare.com",
      stopTail: () => {},
    }
  }),
}))

// Imported AFTER the mocks above so quick.ts picks up the mocked modules.
const { quickTunnelProvider } = await import("../remote-providers/quick.js")

describe("quickTunnelProvider — hermetic against ~/.cloudflared/config.yml", () => {
  let workspace: string

  afterEach(() => {
    spawnCalls.length = 0
    vi.clearAllMocks()
    if (workspace) rmSync(workspace, { recursive: true, force: true })
  })

  it("spawns with --config <sentinel> --url <target>, and the sentinel carries no ingress key", async () => {
    workspace = mkdtempSync(join(tmpdir(), "quick-provider-test-"))
    const provider = quickTunnelProvider()

    const result = await provider.start({
      target: { host: "127.0.0.1", port: 5173 },
      workspace,
    })

    expect(result.publicUrl).toBe("https://fake-tunnel-id.trycloudflare.com")
    expect(spawnCalls).toHaveLength(1)
    const argv = spawnCalls[0]!.argv

    expect(argv[0]).toBe("tunnel")
    const configIdx = argv.indexOf("--config")
    expect(configIdx).toBeGreaterThanOrEqual(0)
    const configPath = argv[configIdx + 1]!
    expect(argv).toContain("--url")
    expect(argv[argv.indexOf("--url") + 1]).toBe("http://127.0.0.1:5173")

    // The whole point: no top-level `ingress:` key, so `~/.cloudflared/
    // config.yml`'s own ingress rules can never shadow the --url rule
    // cloudflared builds from the inline flag.
    const configBody = readFileSync(configPath, "utf8")
    expect(configBody).not.toMatch(/^ingress:/m)

    await provider.stop()
  })
})
