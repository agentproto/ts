/**
 * `agentproto llm endpoints <list|test>` — reads
 * ~/.agentproto/llm-endpoints.json (LLM_ENDPOINT_ENDPOINTS_FILE overrides).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLlm } from "../commands/llm.js"

let dir: string
const SAVED = process.env.LLM_ENDPOINT_ENDPOINTS_FILE

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "llm-command-test-"))
  process.env.LLM_ENDPOINT_ENDPOINTS_FILE = join(dir, "llm-endpoints.json")
})

afterEach(async () => {
  if (SAVED === undefined) delete process.env.LLM_ENDPOINT_ENDPOINTS_FILE
  else process.env.LLM_ENDPOINT_ENDPOINTS_FILE = SAVED
  await rm(dir, { recursive: true, force: true })
})

function captureStdout() {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((c: string) => {
    chunks.push(String(c))
    return true
  }) as typeof process.stdout.write)
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() }
}

describe("agentproto llm --help / endpoints --help", () => {
  it("prints usage and exits 0", async () => {
    const out = captureStdout()
    const code = await runLlm(["--help"])
    out.restore()
    expect(code).toBe(0)
    expect(out.text()).toContain("agentproto llm")
  })

  it("endpoints --help prints usage and exits 0", async () => {
    const out = captureStdout()
    const code = await runLlm(["endpoints", "--help"])
    out.restore()
    expect(code).toBe(0)
    expect(out.text()).toContain("agentproto llm endpoints")
  })

  it("an unknown subcommand exits 2", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const code = await runLlm(["bogus"])
    errSpy.mockRestore()
    expect(code).toBe(2)
  })
})

describe("agentproto llm endpoints list", () => {
  it("no endpoints file: says so and exits 0", async () => {
    const out = captureStdout()
    const code = await runLlm(["endpoints", "list"])
    out.restore()
    expect(code).toBe(0)
    expect(out.text()).toContain("no endpoints configured")
  })

  it("lists configured endpoints with key status, no --json", async () => {
    await writeFile(
      process.env.LLM_ENDPOINT_ENDPOINTS_FILE!,
      JSON.stringify({
        endpoints: [
          { id: "bonsai", kind: "openai", baseUrl: "http://192.168.1.20:8081/v1", apiKeyEnv: "LLM_CMD_TEST_KEY" },
          { id: "ollama", kind: "openai", baseUrl: "http://192.168.1.20:11434/v1" },
        ],
      }),
    )
    const out = captureStdout()
    const code = await runLlm(["endpoints", "list"])
    out.restore()
    expect(code).toBe(0)
    const text = out.text()
    expect(text).toContain("bonsai")
    expect(text).toContain("http://192.168.1.20:8081/v1")
    expect(text).toContain("unset — keyless request")
    expect(text).toContain("ollama")
    expect(text).toContain("(keyless — no apiKeyEnv)")
  })

  it("--json emits machine-readable output, never the key value", async () => {
    process.env.LLM_CMD_TEST_KEY2 = "super-secret-value"
    await writeFile(
      process.env.LLM_ENDPOINT_ENDPOINTS_FILE!,
      JSON.stringify({
        endpoints: [{ id: "bonsai", kind: "openai", baseUrl: "http://192.168.1.20:8081/v1", apiKeyEnv: "LLM_CMD_TEST_KEY2" }],
      }),
    )
    const out = captureStdout()
    const code = await runLlm(["endpoints", "list", "--json"])
    out.restore()
    delete process.env.LLM_CMD_TEST_KEY2
    expect(code).toBe(0)
    const parsed = JSON.parse(out.text())
    expect(parsed.endpoints).toEqual([
      { id: "bonsai", baseUrl: "http://192.168.1.20:8081/v1", apiKeyEnv: "LLM_CMD_TEST_KEY2", apiKeySet: true },
    ])
    expect(out.text()).not.toContain("super-secret-value")
  })

  it("an invalid endpoints file exits 1 with the field-scoped errors", async () => {
    await writeFile(process.env.LLM_ENDPOINT_ENDPOINTS_FILE!, "{ not json")
    const errOut: string[] = []
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((c: string) => {
      errOut.push(String(c))
      return true
    }) as typeof process.stderr.write)
    const code = await runLlm(["endpoints", "list"])
    errSpy.mockRestore()
    expect(code).toBe(1)
    expect(errOut.join("")).toContain("invalid JSON")
  })
})

describe("agentproto llm endpoints test", () => {
  it("no endpoints configured: says so and exits 0", async () => {
    const out = captureStdout()
    const code = await runLlm(["endpoints", "test"])
    out.restore()
    expect(code).toBe(0)
    expect(out.text()).toContain("no endpoints configured")
  })

  it("an unreachable endpoint (nothing listening) exits 1 and reports it", async () => {
    await writeFile(
      process.env.LLM_ENDPOINT_ENDPOINTS_FILE!,
      JSON.stringify({ endpoints: [{ id: "down", kind: "openai", baseUrl: "http://127.0.0.1:1/v1" }] }),
    )
    const out = captureStdout()
    const code = await runLlm(["endpoints", "test"])
    out.restore()
    expect(code).toBe(1)
    expect(out.text()).toContain("unreachable")
    expect(out.text()).toContain("down")
  })
})
