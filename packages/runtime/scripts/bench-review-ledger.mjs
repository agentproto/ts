#!/usr/bin/env node
/**
 * Before/after numbers for the `session_tree` review-badge cache
 * (review-ledger.ts's parsed-entry cache, path -> {mtimeMs, size, entry}).
 *
 * #1507 added `resolveReviewBadges` to `session_tree`, backed by one
 * `ReviewLedger.list({requesterSessionIds})` call — index-backed (never a
 * full directory scan), but every entry file on that index was re-read and
 * re-JSON-parsed on every single `session_tree` call, including the
 * unchanged ones a polling sessions panel re-requests every few seconds.
 * This script spins up N sessions, each with one ledger entry, wires a REAL
 * `ReviewRunner`/`ReviewLedger` (real files on disk, same as the daemon) into
 * a real `session_tree` MCP tool call, and times the STEADY STATE: one
 * untimed warmup call (V8 JIT + first-request MCP handshake cost, unrelated
 * to the ledger and present in both variants) followed by 8 timed calls,
 * reported as a median — this is what a sessions panel polling every few
 * seconds actually pays, over and over, for however long nothing changes.
 * Run this file once as-is (the fix) and once with review-ledger.ts reverted
 * to its pre-fix content (e.g. `git show <parent>:...`) for the "before"
 * side of the comparison — see the PR body for both runs' numbers.
 *
 * Run with vite-node (resolves this package's `.js`-suffixed relative
 * imports against the `.ts` sources, no build step required):
 *
 *   pnpm --filter @agentproto/runtime bench:review-ledger
 *   pnpm --filter @agentproto/runtime bench:review-ledger -- --n 500
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { ATTESTATION_SCHEMA } from "@agentproto/review"
import { registerSessionTools } from "../src/session-tools.js"
import { createSessionsRegistry } from "../src/sessions.js"
import { createSessionEventBus } from "../src/session-event-bus.js"
import { createReviewRunner } from "../src/review-runner.js"
import { createReviewLedger } from "../src/review-ledger.js"

let acpCounter = 0
function fakeAgentSession() {
  return {
    sessionId: `acp_${acpCounter++}`,
    async *send() {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function fakeAttestation(i, requesterSessionId) {
  const head = i.toString(16).padStart(40, "0")
  return {
    schema: ATTESTATION_SCHEMA,
    runId: `run-${i}`,
    reviewId: "bench",
    manifestSha: "m".repeat(64),
    binding: "default",
    target: { repoRemote: "github.com/acme/demo", baseSha: "b".repeat(40), headSha: head },
    rangeSha: i.toString(16).padStart(64, "0"),
    lanes: [],
    verdict: i % 5 === 0 ? "block" : "pass",
    attestor: { daemon: "bench", presets: [] },
    rubrics: [],
    requester: { sessionId: requesterSessionId },
    createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  }
}

async function buildTree(n, ledgerRoot, { noBadges = false } = {}) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const ledger = createReviewLedger({ root: ledgerRoot })
  const reviewRunner = createReviewRunner({ ledger })
  const { server } = await createMcpServer({ specs: [], name: "bench", version: "0" })
  // `noBadges`: no reviewRunner wired at all — the pre-#1507 code path
  // (`resolveReviewBadges` is skipped entirely, see
  // session-tree-review-badges.test.ts's "is absent when no reviewRunner is
  // wired"). Used as the actual pre-#1507 floor to validate against, not
  // just a relative before/after of this fix.
  registerSessionTools(server, { workspace: process.cwd(), registry, ...(noBadges ? {} : { reviewRunner }) })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "bench", version: "0.0.1" })
  await client.connect(clientTransport)

  for (let i = 0; i < n; i++) {
    const s = registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: fakeAgentSession(), adapterSlug: "mock" })
    await ledger.put({
      attestation: fakeAttestation(i, s.id),
      host: { repoRoot: "/tmp/repo", manifestPath: "/tmp/repo/REVIEW.md" },
    })
  }
  return client
}

async function timeCalls(client, count) {
  const ms = []
  for (let i = 0; i < count; i++) {
    const start = performance.now()
    await client.callTool({ name: "session_tree", arguments: {} })
    ms.push(performance.now() - start)
  }
  return ms
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

async function bench(n, opts = {}) {
  const ledgerRoot = await mkdtemp(join(tmpdir(), "agp-bench-review-ledger-"))
  try {
    const client = await buildTree(n, ledgerRoot, opts)
    // One untimed call first: it pays V8 JIT warmup + first-request MCP
    // handshake cost that has nothing to do with the ledger cache and would
    // otherwise swamp the comparison below.
    await client.callTool({ name: "session_tree", arguments: {} })
    const steady = await timeCalls(client, 8)
    const steadyMs = median(steady)
    const label = opts.noBadges ? " (no reviewRunner — pre-#1507 floor)" : ""
    console.log(`n=${n}: steady-state session_tree call (median of 8, post-warmup) = ${steadyMs.toFixed(1)}ms${label}`)
    return { n, steadyMs }
  } finally {
    await rm(ledgerRoot, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const nFlagIndex = args.indexOf("--n")
  const ns = nFlagIndex >= 0 ? [Number(args[nFlagIndex + 1])] : [60, 500]
  const baseline = args.includes("--baseline")
  console.log("session_tree review-badge cache — steady-state (repeated-poll) latency\n")
  for (const n of ns) await bench(n, { noBadges: baseline })
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
