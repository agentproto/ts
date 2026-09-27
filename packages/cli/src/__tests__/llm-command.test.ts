/**
 * `agentproto llm endpoints <list|test|add|remove|detect>` — reads/writes
 * ~/.agentproto/llm-endpoints.json (LLM_ENDPOINT_ENDPOINTS_FILE overrides).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
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

  it("shows the connector id (defaulting to openai-compatible) even when unreachable", async () => {
    await writeFile(
      process.env.LLM_ENDPOINT_ENDPOINTS_FILE!,
      JSON.stringify({ endpoints: [{ id: "down", kind: "openai", baseUrl: "http://127.0.0.1:1/v1" }] }),
    )
    const out = captureStdout()
    const code = await runLlm(["endpoints", "test"])
    out.restore()
    expect(code).toBe(1)
    expect(out.text()).toContain("connector=openai-compatible")
  })

  it("--json includes the connector id per result", async () => {
    await writeFile(
      process.env.LLM_ENDPOINT_ENDPOINTS_FILE!,
      JSON.stringify({
        endpoints: [
          { id: "lmstudio", kind: "openai", baseUrl: "http://127.0.0.1:1/v1", connector: "lmstudio" },
        ],
      }),
    )
    const out = captureStdout()
    const code = await runLlm(["endpoints", "test", "--json"])
    out.restore()
    expect(code).toBe(1)
    const parsed = JSON.parse(out.text())
    expect(parsed.results[0].connector).toBe("lmstudio")
  })

  it("shows per-model connector detail (state, ctx) for a reachable endpoint", async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "test-model" }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0

    await writeFile(
      process.env.LLM_ENDPOINT_ENDPOINTS_FILE!,
      JSON.stringify({
        endpoints: [
          {
            id: "fake",
            kind: "openai",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            connector: "openai-compatible",
          },
        ],
      }),
    )
    const out = captureStdout()
    const code = await runLlm(["endpoints", "test"])
    out.restore()
    await new Promise<void>((resolve) => server.close(() => resolve()))

    expect(code).toBe(0)
    const text = out.text()
    expect(text).toContain("✓ reachable")
    expect(text).toContain("connector=openai-compatible")
    expect(text).toContain("test-model")
    expect(text).toContain("state=unknown")
  })
})

describe("agentproto llm endpoints add", () => {
  it("writes a new entry (explicit --connector, no probing)", async () => {
    const out = captureStdout()
    const code = await runLlm([
      "endpoints",
      "add",
      "lmstudio",
      "--url",
      "http://127.0.0.1:1234/v1",
      "--connector",
      "lmstudio",
    ])
    out.restore()
    expect(code).toBe(0)
    expect(out.text()).toContain('Added endpoint "lmstudio"')
    expect(out.text()).toContain("connector: lmstudio")

    const written = JSON.parse(await readFile(process.env.LLM_ENDPOINT_ENDPOINTS_FILE!, "utf-8"))
    expect(written.endpoints).toEqual([
      { id: "lmstudio", kind: "openai", baseUrl: "http://127.0.0.1:1234/v1", connector: "lmstudio" },
    ])
  })

  it("rejects a duplicate id without writing", async () => {
    await writeFile(
      process.env.LLM_ENDPOINT_ENDPOINTS_FILE!,
      JSON.stringify({
        endpoints: [{ id: "bonsai", kind: "openai", baseUrl: "http://192.168.1.20:8081/v1" }],
      }),
    )
    const errOut: string[] = []
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((c: string) => {
      errOut.push(String(c))
      return true
    }) as typeof process.stderr.write)
    const code = await runLlm([
      "endpoints",
      "add",
      "bonsai",
      "--url",
      "http://192.168.1.30:9090/v1",
      "--connector",
      "openai-compatible",
    ])
    errSpy.mockRestore()
    expect(code).toBe(1)
    expect(errOut.join("")).toContain("duplicate endpoint id")

    const stillOnDisk = JSON.parse(await readFile(process.env.LLM_ENDPOINT_ENDPOINTS_FILE!, "utf-8"))
    expect(stillOnDisk.endpoints).toHaveLength(1)
  })

  it("an explicit --connector skips probing entirely, even against an unreachable url", async () => {
    const out = captureStdout()
    const code = await runLlm([
      "endpoints",
      "add",
      "nothing-here",
      "--url",
      "http://127.0.0.1:1/v1",
      "--connector",
      "openai-compatible",
    ])
    out.restore()
    expect(code).toBe(0)
    const written = JSON.parse(await readFile(process.env.LLM_ENDPOINT_ENDPOINTS_FILE!, "utf-8"))
    expect(written.endpoints[0].connector).toBe("openai-compatible")
  })

  it("--connector auto against an unreachable url falls back to openai-compatible with a warning, exit 0", async () => {
    const errOut: string[] = []
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((c: string) => {
      errOut.push(String(c))
      return true
    }) as typeof process.stderr.write)
    const out = captureStdout()
    const code = await runLlm(["endpoints", "add", "remote-not-up-yet", "--url", "http://127.0.0.1:1/v1"])
    out.restore()
    errSpy.mockRestore()
    expect(code).toBe(0)
    expect(errOut.join("")).toContain("nothing OpenAI-compatible answered")

    const written = JSON.parse(await readFile(process.env.LLM_ENDPOINT_ENDPOINTS_FILE!, "utf-8"))
    expect(written.endpoints[0].connector).toBe("openai-compatible")
  })

  it("--json emits the written EndpointConfig, never a key value", async () => {
    const out = captureStdout()
    const code = await runLlm([
      "endpoints",
      "add",
      "keyed",
      "--url",
      "http://127.0.0.1:1/v1",
      "--connector",
      "openai-compatible",
      "--api-key-env",
      "SOME_KEY_ENV",
      "--json",
    ])
    out.restore()
    expect(code).toBe(0)
    const parsed = JSON.parse(out.text())
    expect(parsed).toEqual({
      id: "keyed",
      kind: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      connector: "openai-compatible",
      apiKeyEnv: "SOME_KEY_ENV",
    })
  })
})

describe("agentproto llm endpoints remove", () => {
  it("deletes an existing entry", async () => {
    await writeFile(
      process.env.LLM_ENDPOINT_ENDPOINTS_FILE!,
      JSON.stringify({
        endpoints: [
          { id: "bonsai", kind: "openai", baseUrl: "http://192.168.1.20:8081/v1" },
          { id: "ollama", kind: "openai", baseUrl: "http://192.168.1.20:11434/v1" },
        ],
      }),
    )
    const out = captureStdout()
    const code = await runLlm(["endpoints", "remove", "bonsai"])
    out.restore()
    expect(code).toBe(0)
    expect(out.text()).toContain('Removed endpoint "bonsai"')

    const written = JSON.parse(await readFile(process.env.LLM_ENDPOINT_ENDPOINTS_FILE!, "utf-8"))
    expect(written.endpoints.map((e: { id: string }) => e.id)).toEqual(["ollama"])
  })

  it("errors on an unknown name without touching the file", async () => {
    await writeFile(
      process.env.LLM_ENDPOINT_ENDPOINTS_FILE!,
      JSON.stringify({ endpoints: [{ id: "bonsai", kind: "openai", baseUrl: "http://192.168.1.20:8081/v1" }] }),
    )
    const errOut: string[] = []
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((c: string) => {
      errOut.push(String(c))
      return true
    }) as typeof process.stderr.write)
    const code = await runLlm(["endpoints", "remove", "nope"])
    errSpy.mockRestore()
    expect(code).toBe(1)
    expect(errOut.join("")).toContain('no endpoint named "nope"')

    const stillOnDisk = JSON.parse(await readFile(process.env.LLM_ENDPOINT_ENDPOINTS_FILE!, "utf-8"))
    expect(stillOnDisk.endpoints).toHaveLength(1)
  })
})

describe("agentproto llm endpoints detect", () => {
  it("--dry-run reports without writing the file", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in test"))
    const out = captureStdout()
    const code = await runLlm(["endpoints", "detect", "--dry-run"])
    out.restore()
    fetchSpy.mockRestore()
    expect(code).toBe(0)
    expect(out.text()).toContain("no local model server detected")
    await expect(readFile(process.env.LLM_ENDPOINT_ENDPOINTS_FILE!, "utf-8")).rejects.toThrow()
  })

  it("--dry-run --json reports nothing detected without writing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in test"))
    const out = captureStdout()
    const code = await runLlm(["endpoints", "detect", "--dry-run", "--json"])
    out.restore()
    fetchSpy.mockRestore()
    expect(code).toBe(0)
    const parsed = JSON.parse(out.text())
    expect(parsed.detected).toEqual([])
    await expect(readFile(process.env.LLM_ENDPOINT_ENDPOINTS_FILE!, "utf-8")).rejects.toThrow()
  })

  it("never re-points an existing LAN-configured endpoint at localhost — reports it as skipped instead", async () => {
    await writeFile(
      process.env.LLM_ENDPOINT_ENDPOINTS_FILE!,
      JSON.stringify({ endpoints: [{ id: "lmstudio", kind: "openai", baseUrl: "http://192.168.1.20:1234/v1", connector: "lmstudio" }] }),
    )
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "http://127.0.0.1:1234/api/v0/models") {
        return new Response(JSON.stringify({ data: [{ id: "m", state: "loaded", loaded_context_length: 4096 }] }), { status: 200 })
      }
      throw new Error("no network in test")
    }) as typeof fetch)
    const out = captureStdout()
    const code = await runLlm(["endpoints", "detect"])
    out.restore()
    fetchSpy.mockRestore()
    expect(code).toBe(0)
    expect(out.text()).toContain('existing endpoint "lmstudio" points elsewhere')
    const written = JSON.parse(await readFile(process.env.LLM_ENDPOINT_ENDPOINTS_FILE!, "utf-8"))
    expect(written.endpoints).toEqual([{ id: "lmstudio", kind: "openai", baseUrl: "http://192.168.1.20:1234/v1", connector: "lmstudio" }])
  })
})
