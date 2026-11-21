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
  listAdaptersWithAcp: vi.fn(),
}))
vi.mock("../registry/catalog.js", () => ({ CATALOG: {} }))
vi.mock("@agentproto/runtime/providers-store", () => ({
  loadProviders: vi.fn(async () => ({ providers: {} })),
  providerEnvVar: (provider: string) => `${provider.toUpperCase()}_API_KEY`,
}))

import { listAdaptersWithAcp } from "../registry/resolve.js"
import { runModels } from "../commands/models.js"

const mocked = vi.mocked(listAdaptersWithAcp)

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

describe("runModels — generic-ACP harnesses (the merged listing)", () => {
  // `agentproto models mistral-vibe` used to return EMPTY: mistral-vibe is
  // declared in the ACP generic catalog (acp-generic.ts), not the npm
  // catalog, and the command only read the native listing (issue
  // 2026-11-21). Now it reads the same merged listing `adapter_list` and
  // the runtime catalog join serve.
  const MISTRAL_VIBE = {
    slug: "mistral-vibe",
    status: "ready",
    models: ["mistral-large-4-0", "zai-glm-5-3"],
    provider: "mistral",
    source: "acp-catalog",
  }

  beforeEach(() => {
    process.env.MISTRAL_API_KEY = "test-key"
  })

  afterEach(() => {
    delete process.env.MISTRAL_API_KEY
  })

  it("lists a generic-ACP adapter's models and marks them runnable with the provider key", async () => {
    mocked.mockResolvedValue([MISTRAL_VIBE as never])
    const { out, code } = await capture(["mistral-vibe"])
    expect(code).toBe(0)
    const row = out.split("\n").find(l => l.includes("mistral-large-4-0"))
    expect(row).toMatch(/^ {2}✓ mistral-large-4-0/)
    expect(out.split("\n").find(l => l.includes("zai-glm-5-3"))).toBeDefined()
  })

  it("--json includes the generic-ACP adapter with per-model provider rows", async () => {
    mocked.mockResolvedValue([MISTRAL_VIBE as never])
    const { out } = await capture(["mistral-vibe", "--json"])
    const parsed = JSON.parse(out) as {
      adapters: Array<{ adapter: string; models: Array<{ id: string; provider: string; runnable: boolean }> }>
    }
    expect(parsed.adapters[0]!.adapter).toBe("mistral-vibe")
    const large = parsed.adapters[0]!.models.find(m => m.id === "mistral-large-4-0")!
    expect(large.provider).toBe("mistral")
    expect(large.runnable).toBe(true)
  })

  it("without the MISTRAL key the row is ✗ and the footer names the fix", async () => {
    delete process.env.MISTRAL_API_KEY
    mocked.mockResolvedValue([MISTRAL_VIBE as never])
    const { out } = await capture(["mistral-vibe"])
    expect(out.split("\n").find(l => l.includes("mistral-large-4-0"))).toMatch(/^ {2}✗ /)
    expect(out).toContain("agentproto auth provider set mistral <api-key>")
  })
})
