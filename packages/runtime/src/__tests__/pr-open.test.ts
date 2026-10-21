/**
 * Unit tests for the daemon-side `pr_open` lane (pr-open.ts):
 * `gh pr create` runs on the HOST under the HOST's gh (boxes never get a
 * token), attributed to the authoring session whose work branch was pushed —
 * with the branch's authors listed on the footer and the opener ("Opened by")
 * recorded as whoever invoked the open.
 */

import { execSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildFooter } from "../pr-provenance.js"
import { checkPrOpenScope, openPrForSession, prCreateArgs, resolvePrOpenWorkspace, type OpenPrRegistry } from "../pr-open.js"
import { stampFooterOnPr } from "../pr-provenance-stamp.js"
import { buildProbeCommand } from "../sandbox-delivery.js"

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
  workspaceSlug?: string
  sandboxCheckpointOverride?: { refPrefix?: string } | false
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
function fakeGh(
  opts: {
    commitText?: string
    checkpointMessage?: string
    headRefName?: string
    prBody?: string
    editExit?: number
    refPrefix?: string
  } = {},
) {
  const calls: Array<{ args: readonly string[]; cwd: string }> = []
  const edits: string[] = []
  const run = async (args: readonly string[], cwd: string) => {
    calls.push({ args, cwd })
    if (args[1] === "create") return { exitCode: 0, stdout: "https://github.com/agentproto/agentproto/pull/77" }
    if (args[0] === "api") {
      return args[1] === `repos/agentproto/agentproto/commits/${opts.refPrefix ?? "agentproto-checkpoint/"}${opts.headRefName ?? "wt/feat"}` && opts.checkpointMessage !== undefined
        ? { exitCode: 0, stdout: opts.checkpointMessage }
        : { exitCode: 1, stdout: "" }
    }
    if (args[1] === "view" && args.includes("headRefName")) return { exitCode: 0, stdout: `${opts.headRefName ?? "wt/feat"}\n` }
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

  it("credits a session known only by the trailer on the checkpoint branch tip (never on the PR commits)", async () => {
    const gh = fakeGh({ commitText: "real work commit\n", checkpointMessage: "agentproto checkpoint: work\n\nAgentproto-Session: sess_gone\n" })
    const outcome = await openPrForSession({ ...input, registry: makeRegistry(rows), run: gh.run })
    expect(outcome).toMatchObject({ opened: true, stamped: true })
    expect(gh.edits[0]).toContain("Authored by `sess_gone`")
    expect(gh.calls.some(c => c.args[0] === "api" && String(c.args[1]).endsWith("agentproto-checkpoint/wt/feat"))).toBe(true)
  })

  it("keys attribution off the PR head, not the resolved session's own branch (legacy opener path)", async () => {
    // The resolved session is a host orchestrator with NO delivery branch;
    // the PR head is the box's branch, which only the registry + checkpoint know.
    const gh = fakeGh({ headRefName: "wt/feat", checkpointMessage: "cp\n\nAgentproto-Session: sess_gone\n" })
    const orchestrator = row({ id: "sess_orchestrator", costUsd: 469 })
    const outcome = await stampFooterOnPr({
      registry: makeRegistry([...rows, orchestrator]),
      session: orchestrator,
      supervisor: null,
      prNumber: 77,
      prUrl: "https://github.com/agentproto/agentproto/pull/77",
      cwd: "/w",
      run: gh.run,
      host: "h",
    })
    expect(outcome).toMatchObject({ stamped: true })
    expect(gh.edits[0]).toContain("Authored by `sess_box1`")
    expect(gh.edits[0]).toContain("Authored by `sess_gone`")
    expect(gh.edits[0]).not.toContain("$469")
  })

  it("reads the checkpoint through the configured refPrefix", async () => {
    const gh = fakeGh({
      refPrefix: "custom/cp/",
      checkpointMessage: "cp\n\nAgentproto-Session: sess_gone\n",
    })
    const outcome = await openPrForSession({
      ...input,
      registry: makeRegistry(rows),
      run: gh.run,
      checkpointRefPrefix: "custom/cp/",
    })
    expect(outcome).toMatchObject({ opened: true, stamped: true })
    expect(gh.edits[0]).toContain("Authored by `sess_gone`")
  })

  it("credits the session from a REAL delivery-produced snapshot commit (producer/consumer pair)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-open-probe-"))
    try {
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      }
      const sh = (cmd: string) => execSync(cmd, { cwd: dir, env, encoding: "utf8" })
      sh("git init -q -b main && git commit -q --allow-empty -m base")
      const baseSha = sh("git rev-parse HEAD").trim()
      sh("git checkout -q -b wt/feat")
      writeFileSync(join(dir, "dirty.txt"), "uncommitted\n")
      // The producer: the exact command delivery runs in the box.
      const probe = buildProbeCommand(
        { checkoutDir: dir, branch: "wt/feat", baseSha },
        { sessionId: "sess_real_author" },
      )
      sh(probe)
      const message = sh("git log -1 --format=%B refs/agentproto/checkpoint")
      // The consumer: the stamper, reading that commit message back.
      const gh = fakeGh({ checkpointMessage: message })
      const outcome = await openPrForSession({ ...input, registry: makeRegistry(rows), run: gh.run })
      expect(outcome).toMatchObject({ opened: true, stamped: true })
      expect(gh.edits[0]).toContain("Authored by `sess_real_author`")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("still stamps when the checkpoint branch does not exist", async () => {
    const gh = fakeGh({ commitText: "real work commit\n" })
    const outcome = await openPrForSession({ ...input, registry: makeRegistry(rows), run: gh.run })
    expect(outcome).toMatchObject({ opened: true, stamped: true })
    expect(gh.edits[0]).not.toContain("sess_gone")
  })

  it("credits an ARCHIVED target session (get()-able, absent from list()) with its model, wallet and cost", async () => {
    // The archived-session case: the registry can still RESOLVE the target,
    // so the PR must credit it as an author, not reduce it to a bare id.
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
    expect(gh.edits[0]).toContain("Authored by `sess_orchestrator`")
    expect(gh.edits[0]).toContain("$469.0000")
  })

  it("never credits the OPENER's ledger as the PR's wallet (no author resolves)", async () => {
    // The opener is not the target and no author resolves: the footer names
    // the opener, but its cumulative spend is NOT the PR's cost.
    const gh = fakeGh()
    const outcome = await openPrForSession({
      ...input,
      sessionId: "sess_box1",
      registry: {
        get: id => (id === "sess_box1" ? row({ id, sandboxDeliveryTarget: { branch: "wt/feat" } }) : undefined),
        list: () => [],
        recordOpenedPr: () => {},
      },
      openedBy: "sess_orchestrator",
      run: gh.run,
    })
    expect(outcome).toMatchObject({ opened: true })
    expect(gh.edits[0]).toContain("Opened by `sess_orchestrator`")
    expect(gh.edits[0]).not.toContain("$469")
  })

  it("does not credit another workspace's session that used the same branch name", async () => {
    // Branch names are repo-local: `wt/feat` in workspace "other" is a
    // different branch of a different repo.
    const gh = fakeGh()
    const outcome = await openPrForSession({
      ...input,
      registry: makeRegistry([
        row({ id: "sess_box1", workspaceSlug: "ts", sandboxDeliveryTarget: { branch: "wt/feat" }, costUsd: 0.0031 }),
        row({ id: "sess_elsewhere", workspaceSlug: "other", sandboxDeliveryTarget: { branch: "wt/feat" }, costUsd: 42 }),
      ]),
      run: gh.run,
    })
    expect(outcome).toMatchObject({ opened: true, stamped: true })
    expect(gh.edits[0]).toContain("Authored by `sess_box1`")
    expect(gh.edits[0]).not.toContain("sess_elsewhere")
    expect(gh.edits[0]).not.toContain("$42")
  })

  it("reads the checkpoint under the target session's own refPrefix override", async () => {
    const gh = fakeGh({
      refPrefix: "custom/cp/",
      checkpointMessage: "cp\n\nAgentproto-Session: sess_gone\n",
    })
    const outcome = await openPrForSession({
      ...input,
      registry: makeRegistry([
        row({ id: "sess_box1", sandboxDeliveryTarget: { branch: "wt/feat" }, sandboxCheckpointOverride: { refPrefix: "custom/cp/" } }),
      ]),
      run: gh.run,
      checkpointRefPrefix: "global/cp/",
    })
    expect(outcome).toMatchObject({ opened: true, stamped: true })
    expect(gh.edits[0]).toContain("Authored by `sess_gone`")
    expect(gh.calls.some(c => c.args[0] === "api" && String(c.args[1]).endsWith("custom/cp/wt/feat"))).toBe(true)
    expect(gh.calls.some(c => c.args[0] === "api" && String(c.args[1]).includes("global/cp/"))).toBe(false)
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

describe("checkPrOpenScope", () => {
  const rows = [
    { id: "orch" },
    { id: "child", parentSessionId: "orch" },
    { id: "grandchild", parentSessionId: "child" },
    { id: "loopA", parentSessionId: "loopB" },
    { id: "loopB", parentSessionId: "loopA" },
  ]

  it("allows the target itself and its ancestors", () => {
    expect(checkPrOpenScope({ callerSessionId: "grandchild", targetId: "grandchild", rows })).toBeUndefined()
    expect(checkPrOpenScope({ callerSessionId: "child", targetId: "grandchild", rows })).toBeUndefined()
    expect(checkPrOpenScope({ callerSessionId: "orch", targetId: "grandchild", rows })).toBeUndefined()
  })

  it("refuses descendants-to-ancestor, strangers, and survives a parent loop", () => {
    expect(checkPrOpenScope({ callerSessionId: "child", targetId: "orch", rows })).toContain("may only open a PR")
    expect(checkPrOpenScope({ callerSessionId: "stranger", targetId: "child", rows })).toContain("may only open a PR")
    expect(checkPrOpenScope({ callerSessionId: "orch", targetId: "loopA", rows })).toContain("may only open a PR")
  })

  it("does not scope the operator (no caller id)", () => {
    expect(checkPrOpenScope({ targetId: "child", rows })).toBeUndefined()
  })
})

describe("resolvePrOpenWorkspace", () => {
  const ws = { workspaces: [{ slug: "a", path: "/repos/a" }, { slug: "b", path: "/repos/b" }] }

  it("a box session runs gh in its workspace's host checkout", () => {
    expect(resolvePrOpenWorkspace({ id: "s", workspaceSlug: "b", cwd: "/home/user/workspace", sandboxId: "sbx" }, ws))
      .toEqual({ ghCwd: "/repos/b", allowlistRoot: "/repos/b" })
    expect(resolvePrOpenWorkspace({ id: "s", workspaceSlug: "zz", remote: true }, ws)).toHaveProperty("error")
  })

  it("a host session runs gh in its worktree, gated by its repo's allowlist", () => {
    expect(
      resolvePrOpenWorkspace(
        { id: "s", workspaceSlug: "a", cwd: "/wt/x/sub", worktreePath: "/wt/x", mainRepoPath: "/repos/b" },
        ws,
      ),
    ).toEqual({ ghCwd: "/wt/x", allowlistRoot: "/repos/b" })
    expect(resolvePrOpenWorkspace({ id: "s", workspaceSlug: "default", cwd: "/repos/b/pkg" }, ws)).toEqual({
      ghCwd: "/repos/b/pkg",
      allowlistRoot: "/repos/b",
    })
    expect(resolvePrOpenWorkspace({ id: "s", cwd: "/elsewhere" }, ws)).toEqual({
      ghCwd: "/elsewhere",
      allowlistRoot: "/elsewhere",
    })
    expect(resolvePrOpenWorkspace({ id: "s" }, ws)).toHaveProperty("error")
  })
})

describe("openPrForSession authorizeArgs", () => {
  it("refuses before gh runs when the argv is not authorized, and passes the exact argv", async () => {
    const registry = makeRegistry([row({ id: "box", sandboxDeliveryTarget: { branch: "wt/feat" } })])
    const gh = fakeGh()
    const seen: Array<readonly string[]> = []
    const outcome = await openPrForSession({
      sessionId: "box",
      registry,
      workspacePath: "/tmp",
      title: "T",
      body: "B",
      run: gh.run,
      authorizeArgs: args => {
        seen.push(args)
        return "nope"
      },
    })
    expect(outcome).toEqual({ opened: false, reason: "nope" })
    expect(seen).toEqual([prCreateArgs("wt/feat", "T", "B")])
    expect(gh.calls).toEqual([])
  })
})
