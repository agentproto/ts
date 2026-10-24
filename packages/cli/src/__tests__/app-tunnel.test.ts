/**
 * `agentproto app tunnel` (`commands/app.ts`) against a mocked daemon /mcp
 * client: the flags it forwards to the daemon's `app_tunnel` tool. The app
 * manifest load is mocked too, so the test exercises the CLI's argument
 * plumbing (not app's loader) — `--public` must reach the daemon as
 * `public: true`, and its absence must NOT send the key at all (the tool
 * defaults to a private, signed link).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const h = vi.hoisted(() => {
  return {
    calls: [] as { name: string; arguments: Record<string, unknown> }[],
    responses: {} as Record<string, unknown>,
  }
})

vi.mock("../app-serve.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../app-serve.js")>()
  return {
    ...mod,
    resolveDaemonMcpUrl: vi.fn(async () => "http://127.0.0.1:18790/mcp"),
    createDaemonMcpClientGetter: vi.fn(
      (_url: string, _name: string) =>
        async () => ({
          callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
            h.calls.push({ name: req.name, arguments: req.arguments })
            const r = h.responses[req.name]
            if (r instanceof Error) throw r
            return r
          },
        }),
    ),
  }
})

vi.mock("@agentproto/app", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@agentproto/app")>()
  return {
    ...mod,
    loadAppHandle: vi.fn(async () => ({ ui: { port: 4321 } })),
  }
})

type AppModule = typeof import("../commands/app.js")
let appModule: AppModule | null = null

function result(texts: unknown[]): unknown {
  return {
    isError: false,
    content: texts.map((text) => ({ type: "text", text: typeof text === "string" ? text : JSON.stringify(text) })),
  }
}

beforeEach(async () => {
  h.calls.length = 0
  h.responses = {}
  h.responses.app_tunnel = result([{ tunnelId: "t1", url: "https://x.example", provider: "quick", targetPort: 4321 }])
  appModule = await import("../commands/app.js")
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function of(fn: (m: AppModule) => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const so = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => { out.push(String(c)); return true })
  const se = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { err.push(String(c)); return true })
  const code = await fn(appModule!)
  so.mockRestore()
  se.mockRestore()
  return { code, out: out.join(""), err: err.join("") }
}

describe("app tunnel", () => {
  it("sends only targetPort by default (no public key — the tool keeps its signed-link default)", async () => {
    const { code } = await of((m) => m.runAppTunnel(["/tmp/some-app"]))
    expect(code).toBe(0)
    expect(h.calls).toEqual([{ name: "app_tunnel", arguments: { targetPort: 4321 } }])
  })

  it("forwards --public as public: true (mirrors the app_tunnel MCP tool)", async () => {
    const { code } = await of((m) => m.runAppTunnel(["/tmp/some-app", "--public"]))
    expect(code).toBe(0)
    expect(h.calls).toEqual([{ name: "app_tunnel", arguments: { targetPort: 4321, public: true } }])
  })

  it("combines --public with the other flags", async () => {
    await of((m) =>
      m.runAppTunnel([
        "/tmp/some-app",
        "--session",
        "sess_1",
        "--name",
        "demo",
        "--public",
        "--json",
      ]),
    )
    expect(h.calls).toEqual([
      {
        name: "app_tunnel",
        arguments: { targetPort: 4321, session: "sess_1", name: "demo", public: true },
      },
    ])
  })
})
