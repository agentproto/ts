import { EventEmitter } from "node:events"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

import type { AgentCliConnectOptions } from "@agentproto/harness"
import { createAgentCliClient } from "../client.js"
import { pi } from "../index.js"
import {
  PROVIDER_OVERRIDES_CONFIG_ENV,
  buildOpencodeProviderOverrides,
  escapePiConfigLiteral,
  parseProviderOverridesConfig,
} from "../provider-overrides.js"
import providerOverridesExtension from "../provider-overrides-extension.js"

const SECRET = "console-bearer-SECRET-value"

/** The org block the opencode console sub-account resolution hands the spawn
 *  (adapters/opencode/src/subaccounts.ts → `OPENCODE_CONFIG_CONTENT`). */
function goSubaccountEnv(orgId = "org_hodl"): Record<string, string> {
  return {
    OPENCODE_CONSOLE_TOKEN: SECRET,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      provider: {
        "opencode-go": {
          options: {
            apiKey: "{env:OPENCODE_CONSOLE_TOKEN}",
            headers: { "x-opencode-org-id": orgId },
          },
        },
      },
    }),
  }
}

function makeFakeChild() {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
    killed: boolean
  }
  child.stdout = stdout
  child.stderr = stderr
  child.killed = false
  child.kill = vi.fn()
  child.stdin = {
    end: vi.fn(),
    write: vi.fn((data: string) => {
      const msg = JSON.parse(data) as { id: string; type: string }
      if (msg.type === "get_state") {
        queueMicrotask(() => {
          stdout.emit(
            "data",
            `${JSON.stringify({
              id: msg.id,
              type: "response",
              command: "get_state",
              success: true,
              data: { sessionId: "sess-fake" },
            })}\n`,
          )
        })
      }
    }),
  }
  return child
}

function connectOpts(overrides: Partial<AgentCliConnectOptions> = {}): AgentCliConnectOptions {
  return { cwd: "/tmp", env: {}, abortSignal: new AbortController().signal, ...overrides }
}

describe("adapter-pi manifest: OpenCode Zen / Go", () => {
  it("routes both OpenCode endpoints' api-key profiles to OPENCODE_API_KEY", () => {
    expect(pi.models?.env?.opencode).toBe("OPENCODE_API_KEY")
    expect(pi.models?.env?.["opencode-go"]).toBe("OPENCODE_API_KEY")
    expect(pi.auth?.state?.env).toContain("OPENCODE_API_KEY")
  })

  it("lists opencode/* and opencode-go/* models from the shared catalog", () => {
    const allowed = (pi.models?.allowed ?? []).filter(
      (m): m is { id: string; provider: string } => typeof m === "object",
    )
    const zen = allowed.filter(m => m.provider === "opencode")
    const go = allowed.filter(m => m.provider === "opencode-go")
    expect(zen.length).toBeGreaterThan(0)
    expect(go.length).toBeGreaterThan(0)
    expect(zen.every(m => m.id.startsWith("opencode/"))).toBe(true)
    expect(go.every(m => m.id.startsWith("opencode-go/"))).toBe(true)
    expect(zen.some(m => m.id === "opencode/deepseek-v4.1-flash")).toBe(true)
    expect(go.some(m => m.id === "opencode-go/deepseek-v4.1-flash")).toBe(true)
  })
})

describe("buildOpencodeProviderOverrides", () => {
  it("is a no-op for a plain Zen/Go api-key spawn (key already in OPENCODE_API_KEY)", () => {
    expect(buildOpencodeProviderOverrides({ OPENCODE_API_KEY: SECRET })).toBeUndefined()
  })

  it("turns a Go console-org block into a bearer env ref + org header", () => {
    const built = buildOpencodeProviderOverrides(goSubaccountEnv())
    expect(built?.config).toEqual({
      providers: {
        "opencode-go": {
          apiKey: "${OPENCODE_CONSOLE_TOKEN}",
          headers: { "x-opencode-org-id": "org_hodl" },
        },
      },
    })
    expect(built?.env).toEqual({})
    expect(JSON.stringify(built?.config)).not.toContain(SECRET)
  })

  it("leaves x-opencode-session to pi, which already sends its own stable session id", () => {
    const built = buildOpencodeProviderOverrides(goSubaccountEnv())
    expect(built?.config.providers["opencode-go"]?.headers).not.toHaveProperty("x-opencode-session")
  })

  it("defaults the bearer to OPENCODE_CONSOLE_TOKEN when the block names no apiKey", () => {
    const built = buildOpencodeProviderOverrides({
      OPENCODE_CONSOLE_TOKEN: SECRET,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { "opencode-go": { options: { headers: { "x-opencode-org-id": "org_b" } } } },
      }),
    })
    expect(built?.config.providers["opencode-go"]?.apiKey).toBe("${OPENCODE_CONSOLE_TOKEN}")
  })

  it("moves a literal apiKey into the child env instead of the config", () => {
    const built = buildOpencodeProviderOverrides({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { opencode: { options: { apiKey: SECRET } } } }),
    })
    expect(built?.config.providers.opencode?.apiKey).toBe("${AGENTPROTO_PI_OPENCODE_API_KEY}")
    expect(built?.env).toEqual({ AGENTPROTO_PI_OPENCODE_API_KEY: SECRET })
    expect(JSON.stringify(built?.config)).not.toContain(SECRET)
  })

  it("escapes header literals so pi never interpolates or executes them", () => {
    const built = buildOpencodeProviderOverrides({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { "opencode-go": { options: { headers: { a: "!rm -rf /", b: "x$HOME", c: "{env:ORG}" } } } },
      }),
    })
    expect(built?.config.providers["opencode-go"]?.headers).toEqual({
      a: "$!rm -rf /",
      b: "x$$HOME",
      c: "${ORG}",
    })
    expect(escapePiConfigLiteral("plain")).toBe("plain")
  })

  it("ignores providers pi does not own and malformed content", () => {
    expect(
      buildOpencodeProviderOverrides({
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { anthropic: { options: { apiKey: "x" } } } }),
      }),
    ).toBeUndefined()
    expect(buildOpencodeProviderOverrides({ OPENCODE_CONFIG_CONTENT: "{not json" })).toBeUndefined()
  })
})

describe("provider-overrides extension", () => {
  it("registers each provider override with pi", () => {
    const registered: Array<[string, unknown]> = []
    const built = buildOpencodeProviderOverrides(goSubaccountEnv())!
    const path = join(tmpdir(), `pi-provider-overrides-test-${process.pid}.json`)
    writeFileSync(path, JSON.stringify(built.config))
    const prev = process.env[PROVIDER_OVERRIDES_CONFIG_ENV]
    process.env[PROVIDER_OVERRIDES_CONFIG_ENV] = path
    try {
      providerOverridesExtension({ registerProvider: (name, config) => registered.push([name, config]) })
    } finally {
      if (prev === undefined) delete process.env[PROVIDER_OVERRIDES_CONFIG_ENV]
      else process.env[PROVIDER_OVERRIDES_CONFIG_ENV] = prev
      rmSync(path, { force: true })
    }
    expect(registered).toEqual([["opencode-go", built.config.providers["opencode-go"]]])
  })

  it("drops non-string fields when parsing", () => {
    expect(
      parseProviderOverridesConfig({ providers: { x: { apiKey: 1, headers: { h: "v", n: 2 } } } }),
    ).toEqual({ providers: { x: { headers: { h: "v" } } } })
  })
})

describe("adapter-pi client: Go console-org spawn", () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => makeFakeChild())
  })

  it("loads the override extension and points it at a secret-free config", async () => {
    const client = createAgentCliClient(pi)
    await client.connect(connectOpts({ env: goSubaccountEnv(), model: "opencode-go/deepseek-v4.1-flash" }))
    const [, args, spawnOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ]
    const e = args.indexOf("-e")
    expect(e).toBeGreaterThan(-1)
    expect(args[e + 1]).toMatch(/provider-overrides-extension\.mjs$/)
    const configPath = spawnOpts.env[PROVIDER_OVERRIDES_CONFIG_ENV]!
    const written = readFileSync(configPath, "utf8")
    expect(written).not.toContain(SECRET)
    expect(JSON.parse(written)).toEqual({
      providers: {
        "opencode-go": {
          apiKey: "${OPENCODE_CONSOLE_TOKEN}",
          headers: { "x-opencode-org-id": "org_hodl" },
        },
      },
    })
    // The bearer itself still reaches pi, through env only.
    expect(spawnOpts.env.OPENCODE_CONSOLE_TOKEN).toBe(SECRET)
    await client.close()
    expect(existsSync(configPath)).toBe(false)
  })

  it("keeps the override in lean mode (auth, not context)", async () => {
    const client = createAgentCliClient(pi)
    await client.connect(connectOpts({ env: goSubaccountEnv(), mode: "lean" }))
    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args).toContain("--no-extensions")
    expect(args.some(a => /provider-overrides-extension\.mjs$/.test(a))).toBe(true)
    await client.close()
  })

  it("adds nothing for a plain Zen api-key spawn", async () => {
    const client = createAgentCliClient(pi)
    await client.connect(connectOpts({ env: { OPENCODE_API_KEY: SECRET }, model: "opencode/deepseek-v4.1-flash" }))
    const [, args, spawnOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ]
    expect(args).not.toContain("-e")
    expect(spawnOpts.env[PROVIDER_OVERRIDES_CONFIG_ENV]).toBeUndefined()
    expect(spawnOpts.env.OPENCODE_API_KEY).toBe(SECRET)
    await client.close()
  })
})
