/**
 * `agentproto models` surfaces the live-synced context window / max output
 * next to the pricing columns — both the ✓/✗ text lines (`ctx 1M/out 128k`)
 * and the --json model objects (`contextWindow`/`maxOutput`, formatted
 * `1M`/`200k`, null when no CONTEXT_WINDOWS provider carries the id).
 *
 * The adapter registry + provider store are mocked: this command's join
 * logic (pricing → provider → runnable → display) is what's under test,
 * not the real registry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("../registry/resolve.js", () => ({
  listAdaptersWithCatalog: vi.fn(),
}))
vi.mock("../registry/catalog.js", () => ({ CATALOG: {} }))
vi.mock("@agentproto/runtime/providers-store", () => ({
  loadProviders: vi.fn(async () => ({ providers: {} })),
  providerEnvVar: (provider: string) => `${provider.toUpperCase()}_API_KEY`,
}))

import { listAdaptersWithCatalog } from "../registry/resolve.js"
import { runModels } from "../commands/models.js"

const mocked = vi.mocked(listAdaptersWithCatalog)

/** Capture process.stdout while running the command. */
async function capture(args: readonly string[]): Promise<{ out: string; code: number }> {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk))
    return true
  }) as typeof process.stdout.write)
  try {
    const code = await runModels(args)
    return { out: chunks.join(""), code }
  } finally {
    spy.mockRestore()
  }
}

const ADAPTER = {
  slug: "claude-code",
  status: "ready",
  models: ["claude-opus-4-8", "totally-unknown-model"],
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key"
  mocked.mockReset()
  mocked.mockResolvedValue([ADAPTER as never])
})

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY
})

describe("runModels — contextWindow/maxOutput surfacing", () => {
  it("text lines append `ctx …/out …` for ids CONTEXT_WINDOWS covers, nothing for ids it doesn't", async () => {
    const { out, code } = await capture([])
    expect(code).toBe(0)
    const known = out.split("\n").find(l => l.includes("claude-opus-4-8"))
    expect(known).toContain("anthropic")
    expect(known).toContain("$5/$25 per 1M")
    expect(known).toContain("ctx 1M/out 128k")
    const unknown = out.split("\n").find(l => l.includes("totally-unknown-model"))
    expect(unknown).not.toContain("ctx ")
  })

  it("--json model objects carry formatted contextWindow/maxOutput (null when unknown)", async () => {
    const { out, code } = await capture(["--json"])
    expect(code).toBe(0)
    const parsed = JSON.parse(out) as {
      adapters: Array<{ models: Array<{ id: string; contextWindow: string | null; maxOutput: string | null }> }>
    }
    const models = parsed.adapters[0]!.models
    const known = models.find(m => m.id === "claude-opus-4-8")
    expect(known?.contextWindow).toBe("1M")
    expect(known?.maxOutput).toBe("128k")
    const unknown = models.find(m => m.id === "totally-unknown-model")
    expect(unknown?.contextWindow).toBeNull()
    expect(unknown?.maxOutput).toBeNull()
  })
})

describe("runModels — copilot-cli (adapter-owned auth, Copilot price list)", () => {
  const COPILOT = {
    slug: "copilot-cli",
    status: "ready",
    models: ["mai-code-2", "mai-code-2-flash", "claude-sonnet-5.5", "auto", "brand-new-model"],
  }

  it("prices MAI Code 2 / Flash and marks them runnable without any provider key", async () => {
    delete process.env.ANTHROPIC_API_KEY
    mocked.mockResolvedValue([COPILOT as never])
    const { out } = await capture([])
    expect(out.split("\n").find(l => l.includes("mai-code-2-flash"))).toMatch(/^ {2}✓ .*\$0\.05\/\$0\.25 per 1M/)
    expect(out.split("\n").find(l => / mai-code-2 /.test(l))).toMatch(/^ {2}✓ .*\$0\.5\/\$2\.5 per 1M/)
    expect(out.split("\n").find(l => l.includes("claude-sonnet-5.5"))).toMatch(/^ {2}✓ .*\$2\/\$10 per 1M/)
  })

  it("never shows a silent blank: an unpriced id says why, in text and in --json", async () => {
    mocked.mockResolvedValue([COPILOT as never])
    const { out } = await capture([])
    expect(out.split("\n").find(l => l.includes("brand-new-model"))).toContain("price n/a:")
    const json = JSON.parse((await capture(["--json"])).out) as {
      adapters: Array<{ models: Array<{ id: string; inputPer1M: number | null; priceNote?: string }> }>
    }
    const row = json.adapters[0]!.models.find(m => m.id === "brand-new-model")
    expect(row?.inputPer1M).toBeNull()
    expect(row?.priceNote).toMatch(/no price/)
  })

  it("a copilot-cli adapter that is not ready marks its models unavailable", async () => {
    mocked.mockResolvedValue([{ ...COPILOT, status: "available" } as never])
    const { out } = await capture([])
    expect(out.split("\n").find(l => l.includes("mai-code-2-flash"))).toMatch(/^ {2}✗ /)
  })
})
