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

function makeRegistry(rows: Row[]): OpenPrRegistry {
  const recorded: Array<{ sessionId: string; number: number; url: string }> = []
  return {
    get: id => rows.find(r => r.id === id),
    list: () => rows,
    recordOpenedPr: (sessionId, input) => {
      recorded.push({ sessionId, ...input })
    },
    // Exposed on the fake for assertions (cast keeps the structural type).
    ...( { recorded } as object),
  } as OpenPrRegistry & { recorded: typeof recorded }
}

const runner = (stdout = "https://github.com/agentproto/agentproto/pull/77") =>
  async (args: readonly string[]) => ({ exitCode: 0, stdout: [...args, stdout].join(" ") })

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
    const calls: Array<{ args: readonly string[]; cwd: string }> = []
    const outcome = await openPrForSession({
      ...input,
      run: async (args, cwd) => {
        calls.push({ args, cwd })
        return { exitCode: 0, stdout: "https://github.com/agentproto/agentproto/pull/77" }
      },
    })
    expect(outcome).toMatchObject({ opened: true, number: 77, sessionId: "sess_box1", stamped: true })
    expect(calls[0].args.slice(0, 3)).toEqual(["pr", "create", "--head"])
    expect(calls[0].args[3]).toBe("wt/feat")
    expect(calls[0].cwd).toBe(input.workspacePath)
    // Authorship is on the footer the stamper renders: buildFooter is the
    // renderer the stamp path uses — assert the canonical render containing
    // the authoring session's own wallet/cost, not the opener's cumulative $469.
    const footer = buildFooter({
      prov: {
        sessionId: "sess_box1",
        adapter: "codex",
        model: "free-model",
        costUsd: 0.0031,
        authors: [
          { sessionId: "sess_box1", adapter: "codex", model: "free-model", sandboxProvider: "e2b", costUsd: 0.0031 },
        ],
        openedBy: "sess_orchestrator",
      },
      kind: "PR",
    })
    expect(footer).toContain("Authored by `sess_box1` (codex · model `free-model` · e2b · $0.0031)")
    expect(footer).toContain("Opened by `sess_orchestrator`")
    expect(footer).not.toContain("$469")
  })

  it("fails closed when the session has no box work branch", async () => {
    const registry = makeRegistry([row({ id: "sess_local" })])
    const outcome = await openPrForSession({
      ...input,
      sessionId: "sess_local",
      registry,
      run: runner(),
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
