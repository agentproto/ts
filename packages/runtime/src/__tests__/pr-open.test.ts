/**
 * Unit tests for the daemon-side `pr_open` lane (pr-open.ts):
 * `gh pr create` runs on the HOST under the HOST's gh (boxes never get a
 * token), attributed to the authoring session whose work branch was pushed —
 * with the branch's authors listed on the footer and the opener ("Opened by")
 * recorded as whoever invoked the open.
 */

import { describe, expect, it } from "vitest"
import { buildFooter } from "../pr-provenance.js"
import { openPrForSession, type OpenPrRegistry } from "../pr-open.js"

type Row = {
  id: string
  kind?: string
  harness?: string
  model?: string
  costUsd?: number
  startedAt?: string
  parentSessionId?: string
  sandboxProvider?: string
  sandboxDeliveryTarget?: { branch: string }
}

const row = (over: Row): Row => ({ kind: "agent-cli", ...over })

type Recorded = { sessionId: string; adapter: string; number: number; url: string }

function makeRegistry(rows: Row[]): OpenPrRegistry & { recorded: Recorded[] } {
  const recorded: Recorded[] = []
  return {
    get: id => rows.find(r => r.id === id),
    list: () => rows,
    recordOpenedPr: (sessionId, input) => {
      recorded.push({ sessionId, ...input })
    },
    recorded,
  }
}

/** A fake `gh`: create prints the PR url, `pr view --json commits` replays
 *  `commitText`, `pr view --json body` replays `prBody`, `pr edit` captures
 *  the new body. */
function fakeGh(opts: { commitText?: string; prBody?: string; editExit?: number } = {}) {
  const calls: Array<{ args: readonly string[]; cwd: string }> = []
  const edits: string[] = []
  const run = async (args: readonly string[], cwd: string) => {
    calls.push({ args, cwd })
    if (args[1] === "create") return { exitCode: 0, stdout: "https://github.com/agentproto/agentproto/pull/77" }
    if (args[1] === "view" && args.includes("commits")) return { exitCode: 0, stdout: opts.commitText ?? "" }
    if (args[1] === "view") return { exitCode: 0, stdout: opts.prBody ?? "does things" }
    if (args[1] === "edit") {
      edits.push(args[args.indexOf("--body") + 1] ?? "")
      return { exitCode: opts.editExit ?? 0, stdout: "" }
    }
    return { exitCode: 1, stdout: "" }
  }
  return { run, calls, edits }
}

describe("openPrForSession — gh runs on the host, attributed to the authoring session", () => {
  const rows: Row[] = [
    row({
      id: "sess_box1",
      startedAt: "2026-10-20T10:00:00Z",
      harness: "codex",
      model: "free-model",
      costUsd: 0.0031,
      sandboxProvider: "e2b",
      sandboxDeliveryTarget: { branch: "wt/feat" },
    }),
    row({
      id: "sess_orchestrator",
      startedAt: "2026-10-20T09:00:00Z",
      model: "orchestrator",
      costUsd: 469,
      // The orchestrator has authors' cumulative spend but NO work branch —
      // it just runs gh.
    }),
  ]
  const input = {
    sessionId: "sess_box1",
    registry: makeRegistry(rows),
    workspacePath: "/home/me/agentproto/ts",
    title: "feat: box work",
    body: "does things",
    openedBy: "sess_orchestrator",
  }

  it("opens the PR with the box branch's head and stamps an authorship footer", async () => {
    const registry = makeRegistry(rows)
    const gh = fakeGh()
    const outcome = await openPrForSession({ ...input, registry, run: gh.run })
    expect(outcome).toMatchObject({ opened: true, number: 77, sessionId: "sess_box1", stamped: true })
    const create = gh.calls[0]
    expect(create?.args.slice(0, 4)).toEqual(["pr", "create", "--head", "wt/feat"])
    expect(create?.cwd).toBe(input.workspacePath)
    const footer = gh.edits[0] ?? ""
    expect(footer).toContain("Authored by `sess_box1` (codex · model `free-model` · e2b · $0.0031)")
    expect(footer).toContain("Opened by `sess_orchestrator`")
    expect(footer).not.toContain("$469")
    expect(registry.recorded).toEqual([expect.objectContaining({ sessionId: "sess_box1", number: 77 })])
  })

  it("credits a session known only by an Agentproto-Session trailer on the PR's commits", async () => {
    const gh = fakeGh({ commitText: "checkpoint\n\nAgentproto-Session: sess_gone\n" })
    const outcome = await openPrForSession({ ...input, registry: makeRegistry(rows), run: gh.run })
    expect(outcome).toMatchObject({ opened: true, stamped: true })
    expect(gh.edits[0]).toContain("Authored by `sess_gone`")
    expect(gh.edits[0]).toContain("Authored by `sess_box1`")
  })

  it("still names the opener and hides its ledger when no authors resolve", async () => {
    // The authoring session is `get`-able but absent from `list()` (the
    // archived-session case), and no commit carries a trailer: no authors.
    const gh = fakeGh()
    const outcome = await openPrForSession({
      ...input,
      sessionId: "sess_orchestrator",
      registry: {
        get: id => (id === "sess_orchestrator" ? row({ id, sandboxDeliveryTarget: { branch: "wt/feat" }, costUsd: 469 }) : undefined),
        list: () => [],
        recordOpenedPr: () => {},
      },
      openedBy: "sess_box1",
      run: gh.run,
    })
    expect(outcome).toMatchObject({ opened: true })
    expect(gh.edits[0]).toContain("Opened by `sess_box1`")
    expect(gh.edits[0]).not.toContain("$469")
  })

  it("records the PR even when the footer edit fails", async () => {
    const registry = makeRegistry(rows)
    const gh = fakeGh({ editExit: 1 })
    const outcome = await openPrForSession({ ...input, registry, run: gh.run })
    expect(outcome).toMatchObject({ opened: true, stamped: false })
    expect(registry.recorded).toEqual([expect.objectContaining({ sessionId: "sess_box1", number: 77 })])
  })

  it("fails closed when the session has no box work branch", async () => {
    const registry = makeRegistry([row({ id: "sess_local" })])
    const outcome = await openPrForSession({
      ...input,
      sessionId: "sess_local",
      registry,
      run: fakeGh().run,
    })
    expect(outcome).toMatchObject({ opened: false })
    const reason = "reason" in outcome ? outcome.reason : ""
    expect(reason).toContain("no sandbox work branch")
  })

  it("fails closed when gh exits non-zero and records nothing", async () => {
    const registry = makeRegistry(rows)
    const outcome = await openPrForSession({
      ...input,
      registry,
      run: async () => ({ exitCode: 1, stdout: "" }),
    })
    expect(outcome).toMatchObject({ opened: false })
  })
})
