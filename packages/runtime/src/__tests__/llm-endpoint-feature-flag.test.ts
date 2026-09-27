import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveEffectiveLlmEndpointFlag } from "../llm-endpoint-feature-flag.js"
import { setLlmEndpointLink } from "../llm-endpoint-links-store.js"

// Both `~/.agentproto/llm-endpoints.json` and `~/.agentproto/llm-endpoint-
// links.json` resolve under os.homedir() → $HOME on POSIX, so a temp HOME
// isolates these tests (same isolation llm-endpoint-links-store.test.ts uses).
let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-llm-flag-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

async function writeEndpointsFile(body: unknown): Promise<void> {
  const dir = join(home, ".agentproto")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "llm-endpoints.json"), JSON.stringify(body), "utf8")
}

async function writeRoutesFile(body: unknown): Promise<void> {
  const dir = join(home, ".agentproto")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "routes.json"), JSON.stringify(body), "utf8")
}

describe("resolveEffectiveLlmEndpointFlag", () => {
  it("an explicit `true` always wins, even with no signals on disk", async () => {
    await expect(resolveEffectiveLlmEndpointFlag(true)).resolves.toBe(true)
  })

  it("an explicit `false` always wins, even with signals on disk", async () => {
    await writeEndpointsFile({ endpoints: [{ id: "lan", kind: "openai", baseUrl: "http://x" }] })
    await expect(resolveEffectiveLlmEndpointFlag(false)).resolves.toBe(false)
  })

  it("defaults OFF when unset and no signal exists", async () => {
    await expect(resolveEffectiveLlmEndpointFlag(undefined)).resolves.toBe(false)
  })

  it("defaults ON when unset and a named endpoint is configured", async () => {
    await writeEndpointsFile({ endpoints: [{ id: "lan", kind: "openai", baseUrl: "http://x" }] })
    await expect(resolveEffectiveLlmEndpointFlag(undefined)).resolves.toBe(true)
  })

  it("an empty endpoints array is not a signal", async () => {
    await writeEndpointsFile({ endpoints: [] })
    await expect(resolveEffectiveLlmEndpointFlag(undefined)).resolves.toBe(false)
  })

  it("a malformed endpoints file reads as no signal (not an error)", async () => {
    const dir = join(home, ".agentproto")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "llm-endpoints.json"), "{not json", "utf8")
    await expect(resolveEffectiveLlmEndpointFlag(undefined)).resolves.toBe(false)
  })

  it("defaults ON when unset and an upstream credential link exists", async () => {
    await setLlmEndpointLink("anthropic", "claude-subs")
    await expect(resolveEffectiveLlmEndpointFlag(undefined)).resolves.toBe(true)
  })

  it("defaults ON when unset and an operator route names the llm-endpoint gateway", async () => {
    await writeRoutesFile({ "llm-endpoint": { label: "Custom", baseUrl: "http://127.0.0.1:19090" } })
    await expect(resolveEffectiveLlmEndpointFlag(undefined)).resolves.toBe(true)
  })

  it("an operator route for a DIFFERENT gateway id is not a signal", async () => {
    await writeRoutesFile({ "some-other-gateway": { label: "Other", baseUrl: "http://127.0.0.1:19091" } })
    await expect(resolveEffectiveLlmEndpointFlag(undefined)).resolves.toBe(false)
  })
})
