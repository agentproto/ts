/**
 * Live e2e proof — the PR-4 acceptance gate. Drives the real `ask_codebase`
 * pipeline (validate → `askCodebaseBuiltin.body` → validate) backed by the
 * live gbrain-pg container through `GbrainLocalProvider`, exercising all three
 * modes against a known agentproto/ts symbol.
 *
 * Guarded to run ONLY when `gbrain-pg` is reachable: a synchronous
 * `docker exec … gbrain --version` probe at load time gates the suite, so CI
 * (or any host without the container) skips it gracefully — mirroring how
 * `sandbox-e2b` guards its real-backend test on `E2B_API_KEY`.
 */

import { execFileSync } from "node:child_process"
import { describe, it, expect } from "vitest"
import { gbrainLocalProvider } from "../gbrain-local.js"
import { loadGbrainLocalEnv } from "../env.js"
import { runAskCodebase } from "../mcp-server.js"

function gbrainPgReachable(): boolean {
  const env = loadGbrainLocalEnv()
  try {
    execFileSync("docker", ["exec", env.container, env.binary, "--version"], {
      timeout: 10_000,
      stdio: "ignore",
    })
    return true
  } catch {
    return false
  }
}

const REACHABLE = gbrainPgReachable()
const KNOWN_SYMBOL = "ImporterRunner"
const KNOWN_FILE = "packages/corpus/src/importers/runner.ts"

describe.skipIf(!REACHABLE)("ask_codebase e2e vs live gbrain-pg (via gbrain-local)", () => {
  const provider = gbrainLocalProvider()
  const run = (args: unknown) => runAskCodebase(provider, args, new AbortController().signal)

  it(
    "define: resolves a known symbol to its definition",
    async () => {
      const out = await run({ question: `define ${KNOWN_SYMBOL}`, mode: "define", symbol: KNOWN_SYMBOL })
      expect(out.mode).toBe("define")
      expect(out.symbol).not.toBeNull()
      expect(out.symbol?.file).toBe(KNOWN_FILE)
      expect(out.symbol?.kind).toBe("class")
      expect(out.answer).toContain(KNOWN_SYMBOL)
    },
    30_000,
  )

  it(
    "callgraph: returns callers + callees for a known symbol",
    async () => {
      const out = await run({ question: `callgraph ${KNOWN_SYMBOL}`, mode: "callgraph", symbol: KNOWN_SYMBOL })
      expect(out.mode).toBe("callgraph")
      expect(Array.isArray(out.callers)).toBe(true)
      expect(Array.isArray(out.callees)).toBe(true)
      expect(out.answer).toContain("caller(s)")
      // edges resolve the queried symbol on one endpoint
      for (const edge of out.callers ?? []) {
        expect([edge.from, edge.to]).toContain(KNOWN_SYMBOL)
      }
    },
    30_000,
  )

  it(
    "blend: returns ranked hits for a semantic query",
    async () => {
      const out = await run({ question: "CorpusImporter enumerate", mode: "blend", limit: 5 })
      expect(out.mode).toBe("blend")
      expect(out.hits).toBeDefined()
      expect(out.hits?.length ?? 0).toBeGreaterThan(0)
      expect(out.answer).toContain("result(s)")
    },
    30_000,
  )
})
