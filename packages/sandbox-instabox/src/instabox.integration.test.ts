/**
 * Opt-in InstaBox integration test: SKIPPED unless the host environment has
 * `INSTABOX_API_KEY` set (a real `ibk_...` key, no mocks). Runs against
 * https://api.instabox.sh and ALWAYS deletes the machine it boots, via
 * `finally { await booted.stop() }`. Do not run it casually: it consumes
 * real box minutes against the account's 5-machine cap.
 *
 * Run manually: pnpm --filter @agentproto/sandbox-instabox test:integration
 */

import { describe, it, expect } from "vitest"
import { instaboxSandboxProvider } from "./provider.js"
import type { SandboxSpec, SandboxBootOpts } from "@agentproto/sandbox"

const apiKey = process.env.INSTABOX_API_KEY

const describeIntegration = apiKey === undefined ? describe.skip : describe

describeIntegration("instabox integration (live account)", () => {
  const spec = {
    provider: "instabox",
    config: { apiKey },
  } as SandboxSpec
  const opts: SandboxBootOpts = { env: {} }

  it("boots a box, execs, round-trips a binary file, probes health, and always stops it", async () => {
    const booted = await instaboxSandboxProvider.boot(spec, opts)
    try {
      expect(booted).toMatchObject({ sandboxId: expect.stringMatching(/^m_/) })
      expect(booted.mcpUrl).toContain("instabox.tech")

      const echo = await booted.exec?.({ command: "echo instabox-integration", timeoutMs: 30_000 })
      expect(echo?.exitCode).toBe(0)
      expect(echo?.stdout).toContain("instabox-integration")

      // Binary round trip: bytes that would silently corrupt through any
      // text-encoding path.
      const binary = new Uint8Array(300_000)
      binary[1] = 0x80
      binary[2] = 0xff
      await booted.writeFile?.("/data/home/integration.bin", binary)
      const roundTrip = await booted.readFile?.("/data/home/integration.bin")
      expect(Array.from(binary.subarray(0, 4))).toEqual(Array.from(roundTrip?.subarray(0, 4) ?? []))
      expect(Buffer.from(binary).equals(Buffer.from(roundTrip ?? new Uint8Array(0)))).toBe(true)

      const health = await fetch(`${booted.mcpUrl.replace(/\/mcp$/, "")}/health`)
      expect(health.ok).toBe(true)
    } finally {
      await booted.stop()
    }
  })
})
