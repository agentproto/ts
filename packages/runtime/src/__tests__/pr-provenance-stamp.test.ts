/**
 * Unit tests for the daemon-lane PR provenance STAMPER (pr-provenance-stamp.ts).
 * The `gh` runner is injected so the whole orchestration runs with a fake:
 *   - a successful `gh pr create` → footer stamped onto the PR body + PR
 *     recorded against the executor session
 *   - idempotency: a body already carrying the marker is not re-edited
 *   - best-effort: non-create, failed, or un-attributable runs are skipped,
 *     and a throwing runner never propagates
 */

import { describe, expect, it, vi } from "vitest"
import { stampPrProvenance, stampFooterOnPr, type GhRunner, type StampRegistry } from "../pr-provenance-stamp.js"
import { MARKER, type FooterSession } from "../pr-provenance.js"

const EXECUTOR: FooterSession = {
  id: "sess_exec",
  kind: "agent-cli",
  status: "running",
  startedAt: "2026-07-21T10:00:00.000Z",
  label: "open-pr",
  cwd: "/work/wt",
  adapterSlug: "claude-code",
  harness: "claude-code",
  model: "opus-4.8",
  auth: { mode: "subscription" },
  accessProfile: { profileRef: "prof_1", label: "Jeremy Max" },
  parentSessionId: "sess_super",
}

const SUPER: FooterSession = { id: "sess_super", kind: "agent-cli", cwd: "/work" }

function fakeRegistry(sessions: FooterSession[]): StampRegistry & {
  recorded: Array<{ sessionId: string; adapter: string; number: number; url: string }>
} {
  const recorded: Array<{ sessionId: string; adapter: string; number: number; url: string }> = []
  return {
    recorded,
    list: () => sessions,
    get: (id: string) => sessions.find(s => s.id === id),
    recordOpenedPr: (sessionId, input) => {
      recorded.push({ sessionId, ...input })
      return undefined
    },
  }
}

const CREATE_ARGS = ["pr", "create", "--title", "t", "--body", "Original body."]
const PR_URL = "https://github.com/agentproto/ts/pull/601"

describe("stampPrProvenance", () => {
  it("stamps the footer onto the created PR and records it against the executor", async () => {
    const reg = fakeRegistry([EXECUTOR, SUPER])
    const calls: Array<readonly string[]> = []
    const run: GhRunner = vi.fn(async args => {
      calls.push(args)
      if (args[1] === "view") return { exitCode: 0, stdout: "Original body.\n" }
      return { exitCode: 0, stdout: "" }
    })

    const outcome = await stampPrProvenance({
      command: "gh",
      args: CREATE_ARGS,
      cwd: "/work/wt",
      exitCode: 0,
      stdout: `${PR_URL}\n`,
      registry: reg,
      run,
      host: "build-box",
    })

    expect(outcome).toMatchObject({ stamped: true, url: PR_URL, number: 601, sessionId: "sess_exec", alreadyStamped: false })

    // Viewed the body, then edited it with body + footer.
    expect(calls[0]).toEqual(["pr", "view", PR_URL, "--json", "body", "--jq", ".body"])
    const editCall = calls.find(c => c[1] === "edit")!
    expect(editCall[0]).toBe("pr")
    const newBody = editCall[4] as string
    expect(newBody.startsWith("Original body.")).toBe(true)
    expect(newBody).toContain(MARKER)
    expect(newBody).toContain("auth-profile `Jeremy Max`")
    expect(newBody).toContain("supervisor `sess_super`")

    // Recorded against the executor session.
    expect(reg.recorded).toEqual([
      { sessionId: "sess_exec", adapter: "claude-code", number: 601, url: PR_URL },
    ])
  })

  it("reads the checkpoint-branch trailer on the legacy opener path (no sandbox target, no openedBy)", async () => {
    const reg = fakeRegistry([EXECUTOR, SUPER])
    const calls: Array<readonly string[]> = []
    const run: GhRunner = vi.fn(async args => {
      calls.push(args)
      if (args[0] === "api") {
        return args[1] === "repos/agentproto/ts/commits/agentproto-checkpoint/wt/box-work"
          ? { exitCode: 0, stdout: "agentproto checkpoint: work\n\nAgentproto-Session: sess_box_gone\n" }
          : { exitCode: 1, stdout: "" }
      }
      if (args.includes("headRefName")) return { exitCode: 0, stdout: "wt/box-work\n" }
      if (args.includes("commits")) return { exitCode: 0, stdout: "plain commit\n" }
      if (args[1] === "view") return { exitCode: 0, stdout: "Original body.\n" }
      return { exitCode: 0, stdout: "" }
    })
    const outcome = await stampPrProvenance({
      command: "gh",
      args: CREATE_ARGS,
      cwd: "/work/wt",
      exitCode: 0,
      stdout: `${PR_URL}\n`,
      registry: reg,
      run,
      host: "build-box",
    })
    expect(outcome).toMatchObject({ stamped: true })
    const edit = calls.find(c => c[1] === "edit")!
    expect(edit[4]).toContain("Authored by `sess_box_gone`")
  })

  it("is idempotent: a body already carrying the marker is not re-edited", async () => {
    const reg = fakeRegistry([EXECUTOR, SUPER])
    const run: GhRunner = vi.fn(async args => {
      if (args[1] === "view") return { exitCode: 0, stdout: `Body.\n\n---\n<sub>${MARKER} — PR</sub>` }
      return { exitCode: 0, stdout: "" }
    })
    const outcome = await stampPrProvenance({
      command: "gh",
      args: CREATE_ARGS,
      cwd: "/work/wt",
      exitCode: 0,
      stdout: `${PR_URL}\n`,
      registry: reg,
      run,
    })
    expect(outcome).toMatchObject({ stamped: true, alreadyStamped: true })
    expect((run as ReturnType<typeof vi.fn>).mock.calls.some(([a]) => a[1] === "edit")).toBe(false)
    // An already-marked body was already attributed to its rightful session —
    // recording it again here would misattribute it onto this one.
    expect(reg.recorded).toHaveLength(0)
  })

  it("skips a non-create command without touching gh", async () => {
    const reg = fakeRegistry([EXECUTOR])
    const run = vi.fn<GhRunner>(async () => ({ exitCode: 0, stdout: "" }))
    const outcome = await stampPrProvenance({
      command: "gh",
      args: ["pr", "view", "1"],
      cwd: "/work/wt",
      exitCode: 0,
      stdout: PR_URL,
      registry: reg,
      run,
    })
    expect(outcome).toEqual({ stamped: false, reason: "not a gh pr create" })
    expect(run).not.toHaveBeenCalled()
  })

  it("skips a failed command", async () => {
    const outcome = await stampPrProvenance({
      command: "gh",
      args: CREATE_ARGS,
      cwd: "/work/wt",
      exitCode: 1,
      stdout: "",
      registry: fakeRegistry([EXECUTOR]),
      run: vi.fn<GhRunner>(async () => ({ exitCode: 0, stdout: "" })),
    })
    expect(outcome).toEqual({ stamped: false, reason: "command failed" })
  })

  it("prefers callerSessionId over the cwd-guess heuristic — an unrelated live session sharing the cwd must not win", async () => {
    // Reproduces the mis-attribution incident: a live, unrelated session
    // (BENCH) shares the exact same cwd as the real executor (EXECUTOR), and
    // is newer/alive — pickExecutorSession's heuristic alone would pick it.
    // callerSessionId names EXECUTOR directly and must win instead.
    const BENCH: FooterSession = {
      id: "sess_bench",
      kind: "agent-cli",
      status: "running",
      startedAt: "2026-07-21T12:00:00.000Z",
      cwd: "/work/wt",
    }
    const reg = fakeRegistry([EXECUTOR, SUPER, BENCH])
    const run: GhRunner = vi.fn(async args =>
      args[1] === "view" ? { exitCode: 0, stdout: "Original body.\n" } : { exitCode: 0, stdout: "" },
    )

    const outcome = await stampPrProvenance({
      command: "gh",
      args: CREATE_ARGS,
      cwd: "/work/wt",
      exitCode: 0,
      stdout: `${PR_URL}\n`,
      registry: reg,
      run,
      callerSessionId: "sess_exec",
    })

    expect(outcome).toMatchObject({ stamped: true, sessionId: "sess_exec" })
    expect(reg.recorded).toEqual([
      { sessionId: "sess_exec", adapter: "claude-code", number: 601, url: PR_URL },
    ])
  })

  it("falls back to the cwd-guess heuristic when callerSessionId is absent (shared /mcp mount)", async () => {
    const reg = fakeRegistry([EXECUTOR, SUPER])
    const run: GhRunner = vi.fn(async args =>
      args[1] === "view" ? { exitCode: 0, stdout: "Original body.\n" } : { exitCode: 0, stdout: "" },
    )
    const outcome = await stampPrProvenance({
      command: "gh",
      args: CREATE_ARGS,
      cwd: "/work/wt",
      exitCode: 0,
      stdout: `${PR_URL}\n`,
      registry: reg,
      run,
    })
    expect(outcome).toMatchObject({ stamped: true, sessionId: "sess_exec" })
  })

  it("falls back to the cwd-guess heuristic when callerSessionId doesn't resolve in the registry", async () => {
    const reg = fakeRegistry([EXECUTOR, SUPER])
    const run: GhRunner = vi.fn(async args =>
      args[1] === "view" ? { exitCode: 0, stdout: "Original body.\n" } : { exitCode: 0, stdout: "" },
    )
    const outcome = await stampPrProvenance({
      command: "gh",
      args: CREATE_ARGS,
      cwd: "/work/wt",
      exitCode: 0,
      stdout: `${PR_URL}\n`,
      registry: reg,
      run,
      callerSessionId: "sess_gone",
    })
    expect(outcome).toMatchObject({ stamped: true, sessionId: "sess_exec" })
  })

  it("skips when no executor session can be attributed", async () => {
    const outcome = await stampPrProvenance({
      command: "gh",
      args: CREATE_ARGS,
      cwd: "/work/wt",
      exitCode: 0,
      stdout: `${PR_URL}\n`,
      registry: fakeRegistry([{ id: "elsewhere", kind: "agent-cli", cwd: "/other" }]),
      run: vi.fn<GhRunner>(async () => ({ exitCode: 0, stdout: "" })),
    })
    expect(outcome).toEqual({ stamped: false, reason: "no executor session to attribute" })
  })

  it("never throws — a failing gh runner is swallowed into the outcome", async () => {
    const outcome = await stampPrProvenance({
      command: "gh",
      args: CREATE_ARGS,
      cwd: "/work/wt",
      exitCode: 0,
      stdout: `${PR_URL}\n`,
      registry: fakeRegistry([EXECUTOR]),
      run: async () => {
        throw new Error("gh not found")
      },
    })
    expect(outcome).toEqual({ stamped: false, reason: "gh not found" })
  })
})

describe("stampFooterOnPr", () => {
  it("views, appends the footer, edits, and records — from a pre-resolved PR", async () => {
    const reg = fakeRegistry([EXECUTOR, SUPER])
    const calls: Array<readonly string[]> = []
    const run: GhRunner = vi.fn(async args => {
      calls.push(args)
      if (args[1] === "view") return { exitCode: 0, stdout: "Original body.\n" }
      return { exitCode: 0, stdout: "" }
    })

    const outcome = await stampFooterOnPr({
      registry: reg,
      session: EXECUTOR,
      supervisor: SUPER,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/work/wt",
      run,
      host: "build-box",
    })

    expect(outcome).toMatchObject({ stamped: true, url: PR_URL, number: 601, sessionId: "sess_exec", alreadyStamped: false })
    expect(calls[0]).toEqual(["pr", "view", PR_URL, "--json", "body", "--jq", ".body"])
    const editCall = calls.find(c => c[1] === "edit")!
    expect(editCall[4] as string).toContain(MARKER)
    expect(editCall[4] as string).toContain("supervisor `sess_super`")
    expect(reg.recorded).toEqual([{ sessionId: "sess_exec", adapter: "claude-code", number: 601, url: PR_URL }])
  })

  it("skips the edit when the body already carries the marker", async () => {
    const reg = fakeRegistry([EXECUTOR])
    const run: GhRunner = vi.fn(async args =>
      args[1] === "view"
        ? { exitCode: 0, stdout: `Body.\n\n---\n<sub>${MARKER} — PR</sub>` }
        : { exitCode: 0, stdout: "" },
    )
    const outcome = await stampFooterOnPr({
      registry: reg,
      session: EXECUTOR,
      supervisor: null,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/w",
      run,
    })
    expect(outcome).toMatchObject({ stamped: true, alreadyStamped: true })
    expect((run as ReturnType<typeof vi.fn>).mock.calls.some(([a]) => a[1] === "edit")).toBe(false)
    // No re-record on an already-stamped body — see the idempotency test above.
    expect(reg.recorded).toHaveLength(0)
  })

  it("does not edit when the body read fails", async () => {
    const reg = fakeRegistry([EXECUTOR])
    const run: GhRunner = vi.fn(async args =>
      args[1] === "view" ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: "" },
    )
    const outcome = await stampFooterOnPr({
      registry: reg,
      session: EXECUTOR,
      supervisor: null,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/w",
      run,
    })
    expect(outcome).toEqual({ stamped: false, reason: "gh pr view exit 1" })
    expect((run as ReturnType<typeof vi.fn>).mock.calls.some(([a]) => a[1] === "edit")).toBe(false)
    expect(reg.recorded).toHaveLength(0)
  })

  it("never throws — a failing runner is swallowed", async () => {
    const outcome = await stampFooterOnPr({
      registry: fakeRegistry([EXECUTOR]),
      session: EXECUTOR,
      supervisor: null,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/w",
      run: async () => {
        throw new Error("boom")
      },
    })
    expect(outcome).toEqual({ stamped: false, reason: "boom" })
  })
})

describe("stampFooterOnPr — prose marker mention", () => {
  it("still stamps a body that MENTIONS the marker in prose (no rendered footer)", async () => {
    const reg = fakeRegistry([EXECUTOR])
    const calls: Array<readonly string[]> = []
    const run: GhRunner = vi.fn(async args => {
      calls.push(args)
      if (args[1] === "view")
        return { exitCode: 0, stdout: "This PR fixes the `@agentproto-bot` stamper.\n" }
      return { exitCode: 0, stdout: "" }
    })
    const outcome = await stampFooterOnPr({
      registry: reg,
      session: EXECUTOR,
      supervisor: null,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/w",
      run,
    })
    expect(outcome).toMatchObject({ stamped: true, alreadyStamped: false })
    const editCall = calls.find(c => c[1] === "edit")!
    expect(editCall[4] as string).toContain("<sub>")
    expect(reg.recorded).toHaveLength(1)
  })
})

describe("stampFooterOnPr — recognizing the gh PATH shim's own-session footer", () => {
  // gh-provenance-shim.ts's inlined buildFooter() — session id + adapter +
  // model + host + cwd ONLY, never auth-profile/cost/tokens (a bare `gh`
  // subprocess can't know any of that). Same shape a prior daemon stamp with
  // no known signals yet would also render, so recognizing it doesn't need
  // to distinguish "shim" from "us, earlier" — both are equally safe to
  // enrich because both already name this exact session.
  const shimFooterFor = (sessionId: string) =>
    `Original body.\n\n---\n<sub>🤖 **${MARKER}** — PR · session \`${sessionId}\` · claude-code · model \`opus-4.8\` · host \`h\` · cwd \`/wt\`</sub>`

  it("records it and upgrades it once recognized as OUR OWN session (auth-profile is a signal the shim could never render)", async () => {
    const reg = fakeRegistry([EXECUTOR, SUPER])
    const calls: Array<readonly string[]> = []
    const run: GhRunner = vi.fn(async args => {
      calls.push(args)
      if (args[1] === "view") return { exitCode: 0, stdout: shimFooterFor("sess_exec") }
      return { exitCode: 0, stdout: "" }
    })

    const outcome = await stampFooterOnPr({
      registry: reg,
      session: EXECUTOR,
      supervisor: SUPER,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/work/wt",
      run,
    })

    expect(outcome).toMatchObject({ stamped: true, alreadyStamped: true, refreshed: true })
    const editCall = calls.find(c => c[1] === "edit")!
    expect(editCall[4] as string).toContain("auth-profile `Jeremy Max`")
    expect(editCall[4] as string).toContain("supervisor `sess_super`")
    // Recorded exactly once, even though the body was already stamped — the
    // BUG this closes: before, an own-footer body other than "not yet
    // stamped" never reached `recordOpenedPr` at all, so a shim-stamped PR's
    // `openedPrs` stayed empty forever and the reconciler's cost-refresh
    // (which only ever iterates `openedPrs`) had nothing to find.
    expect(reg.recorded).toEqual([{ sessionId: "sess_exec", adapter: "claude-code", number: 601, url: PR_URL }])
  })

  it("does not touch or record a footer naming a DIFFERENT session (misattribution guard still holds)", async () => {
    const reg = fakeRegistry([EXECUTOR])
    const run: GhRunner = vi.fn(async args =>
      args[1] === "view" ? { exitCode: 0, stdout: shimFooterFor("sess_someone_else") } : { exitCode: 0, stdout: "" },
    )
    const outcome = await stampFooterOnPr({
      registry: reg,
      session: EXECUTOR,
      supervisor: null,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/w",
      run,
    })
    expect(outcome).toMatchObject({ stamped: true, alreadyStamped: true })
    expect((run as ReturnType<typeof vi.fn>).mock.calls.some(([a]) => a[1] === "edit")).toBe(false)
    expect(reg.recorded).toHaveLength(0)
  })

  it("does not re-edit an own-session footer that is already at least as rich as the fresh render", async () => {
    // A footer this daemon already fully rendered earlier (cost, auth
    // profile, tokens all present) must not be treated as a stale shim stamp
    // and rewritten on every subsequent (non-refresh) stamp attempt.
    const reg = fakeRegistry([EXECUTOR, SUPER])
    const fullBody =
      `Original body.\n\n---\n<sub>🤖 **${MARKER}** — PR · session \`sess_exec\` · claude-code / subscription · ` +
      "auth-profile `Jeremy Max` · model `opus-4.8` · supervisor `sess_super` · 100 in / 200 out · $0.5000 · " +
      "host `h` · cwd `/wt`</sub>"
    const run: GhRunner = vi.fn(async args =>
      args[1] === "view" ? { exitCode: 0, stdout: fullBody } : { exitCode: 0, stdout: "" },
    )
    const outcome = await stampFooterOnPr({
      registry: reg,
      session: { ...EXECUTOR, costUsd: 0.5, tokensIn: 100, tokensOut: 200 },
      supervisor: SUPER,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/work/wt",
      run,
    })
    expect(outcome).toMatchObject({ stamped: true, alreadyStamped: true, refreshed: false })
    expect((run as ReturnType<typeof vi.fn>).mock.calls.some(([a]) => a[1] === "edit")).toBe(false)
    // Still recorded — own-footer PRs are always recorded on first sight,
    // regardless of whether an upgrade was needed.
    expect(reg.recorded).toEqual([{ sessionId: "sess_exec", adapter: "claude-code", number: 601, url: PR_URL }])
  })
})

/** A registry whose ARCHIVED sessions are only visible through
 *  `list({ includeArchived: true })` — the real registry's shape. */
function registryWithArchived(
  live: FooterSession[],
  archived: FooterSession[],
): StampRegistry & { recorded: Array<{ sessionId: string; adapter: string; number: number; url: string }> } {
  const recorded: Array<{ sessionId: string; adapter: string; number: number; url: string }> = []
  return {
    recorded,
    list: (opts?: { includeArchived?: boolean }) => (opts?.includeArchived ? [...live, ...archived] : live),
    get: (id: string) => [...live, ...archived].find(s => s.id === id),
    recordOpenedPr: (sessionId, input) => {
      recorded.push({ sessionId, ...input })
      return undefined
    },
  }
}

/** A `gh` that answers the stamper's three reads (body / head / commits). */
function stampGh(opts: {
  prBody?: string
  headRefName?: string
  commitText?: string
  checkpointMessage?: string
  checkpointRef?: string
}) {
  const calls: Array<readonly string[]> = []
  const edits: string[] = []
  const run: GhRunner = async args => {
    calls.push(args)
    if (args[0] === "api") {
      const ok = opts.checkpointMessage !== undefined && String(args[1]).endsWith(opts.checkpointRef ?? "")
      return ok ? { exitCode: 0, stdout: opts.checkpointMessage ?? "" } : { exitCode: 1, stdout: "" }
    }
    if (args[1] === "view" && args.includes("headRefName")) {
      return { exitCode: 0, stdout: `${opts.headRefName ?? "wt/box-work"}\n` }
    }
    if (args[1] === "view" && args.includes("commits")) {
      return { exitCode: 0, stdout: opts.commitText ?? "" }
    }
    if (args[1] === "view") return { exitCode: 0, stdout: opts.prBody ?? "Original body.\n" }
    if (args[1] === "edit") {
      edits.push(args[args.indexOf("--body") + 1] ?? "")
      return { exitCode: 0, stdout: "" }
    }
    return { exitCode: 0, stdout: "" }
  }
  return { run, calls, edits }
}

describe("stampFooterOnPr — archived authors", () => {
  const ARCHIVED: FooterSession = {
    id: "sess_archived",
    kind: "agent-cli",
    startedAt: "2026-07-21T09:00:00.000Z",
    harness: "codex",
    model: "free-model",
    accessProfile: { profileRef: "prof_2", label: "Wallet 2" },
    costUsd: 0.0031,
    sandboxDeliveryTarget: { branch: "wt/box-work" },
  }

  it("credits an ARCHIVED session with its model, wallet and cost", async () => {
    const reg = registryWithArchived([EXECUTOR], [ARCHIVED])
    const gh = stampGh({ headRefName: "wt/box-work" })
    const outcome = await stampFooterOnPr({
      registry: reg,
      session: EXECUTOR,
      supervisor: SUPER,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/work/wt",
      run: gh.run,
    })
    expect(outcome).toMatchObject({ stamped: true })
    expect(gh.edits[0]).toContain("Authored by `sess_archived`")
    // Rich, not id-only: the descriptor was available all along.
    expect(gh.edits[0]).toContain("model `free-model`")
    expect(gh.edits[0]).toContain("auth-profile `Wallet 2`")
    expect(gh.edits[0]).toContain("$0.0031")
  })

  it("resolves a trailer id through get(), so an archived author is not id-only", async () => {
    const reg = registryWithArchived([EXECUTOR], [ARCHIVED])
    const gh = stampGh({
      headRefName: "wt/box-work",
      commitText: "real work\n\nAgentproto-Session: sess_archived\n",
    })
    const outcome = await stampFooterOnPr({
      registry: reg,
      session: EXECUTOR,
      supervisor: SUPER,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/work/wt",
      run: gh.run,
    })
    expect(outcome).toMatchObject({ stamped: true })
    expect(gh.edits[0]).toContain("Authored by `sess_archived` (codex · auth-profile `Wallet 2` · model `free-model` · $0.0031)")
  })
})

describe("stampFooterOnPr — the opener survives a refresh", () => {
  it("keeps the existing 'Opened by' when the caller omits it", async () => {
    // The posted footer names the opener and an author whose cost was not
    // known yet; the refresh knows it — the re-render must not drop the
    // opener on the way (the refresh caller only knows the session).
    const posted =
      `Original body.\n\n---\n<sub>🤖 **${MARKER}** — PR · session \`sess_exec\` · claude-code / subscription · ` +
      "auth-profile `Jeremy Max` · model `opus-4.8` · supervisor `sess_super` · Authored by `sess_box1` (codex) · " +
      "Opened by `sess_orch` · host `h` · cwd `/wt`</sub>"
    const gh = stampGh({ prBody: posted, headRefName: "wt/box-work" })
    const author: FooterSession = {
      id: "sess_box1",
      kind: "agent-cli",
      startedAt: "2026-07-21T08:00:00.000Z",
      harness: "codex",
      model: "free-model",
      costUsd: 0.0031,
      sandboxDeliveryTarget: { branch: "wt/box-work" },
    }
    const outcome = await stampFooterOnPr({
      registry: fakeRegistry([EXECUTOR, SUPER, author]),
      session: EXECUTOR,
      supervisor: SUPER,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/work/wt",
      refresh: true,
      run: gh.run,
    })
    expect(outcome).toMatchObject({ stamped: true, refreshed: true })
    // The re-render gained the author's amount AND kept the opener.
    expect(gh.edits[0]).toContain("$0.0031")
    expect(gh.edits[0]).toContain("Opened by `sess_orch`")
  })
})

describe("stampFooterOnPr — an own footer that gains authorship is re-rendered", () => {
  it("replaces a footer that has the cost but no authors with one that credits them", async () => {
    const posted =
      `Original body.\n\n---\n<sub>🤖 **${MARKER}** — PR · session \`sess_exec\` · claude-code / subscription · ` +
      "auth-profile `Jeremy Max` · model `opus-4.8` · supervisor `sess_super` · 100 in / 200 out · $0.5000 · " +
      "host `h` · cwd `/wt`</sub>"
    const gh = stampGh({ prBody: posted, headRefName: "wt/box-work" })
    const author: FooterSession = {
      id: "sess_box1",
      kind: "agent-cli",
      startedAt: "2026-07-21T08:00:00.000Z",
      harness: "codex",
      model: "free-model",
      costUsd: 0.0031,
      sandboxDeliveryTarget: { branch: "wt/box-work" },
    }
    const outcome = await stampFooterOnPr({
      registry: fakeRegistry([EXECUTOR, SUPER, author]),
      session: EXECUTOR,
      supervisor: SUPER,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/work/wt",
      run: gh.run,
    })
    expect(outcome).toMatchObject({ stamped: true, refreshed: true })
    expect(gh.edits[0]).toContain("Authored by `sess_box1`")
  })
})

describe("stampFooterOnPr — the checkpoint namespace the delivery actually used", () => {
  it("prefers the session's own per-spawn override over the daemon's global default", async () => {
    const gh = stampGh({
      headRefName: "wt/box-work",
      checkpointRef: "custom/cp/wt/box-work",
      checkpointMessage: "cp\n\nAgentproto-Session: sess_box_gone\n",
    })
    const outcome = await stampFooterOnPr({
      registry: fakeRegistry([EXECUTOR, SUPER]),
      session: { ...EXECUTOR, sandboxCheckpointOverride: { refPrefix: "custom/cp/" } },
      supervisor: SUPER,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/work/wt",
      checkpointRefPrefix: "global/cp/",
      run: gh.run,
    })
    expect(outcome).toMatchObject({ stamped: true })
    expect(gh.calls.some(c => c[0] === "api" && String(c[1]).endsWith("custom/cp/wt/box-work"))).toBe(true)
    expect(gh.edits[0]).toContain("Authored by `sess_box_gone`")
  })

  it("falls back to the global default when the session has no override", async () => {
    const gh = stampGh({
      headRefName: "wt/box-work",
      checkpointRef: "global/cp/wt/box-work",
      checkpointMessage: "cp\n\nAgentproto-Session: sess_box_gone\n",
    })
    const outcome = await stampFooterOnPr({
      registry: fakeRegistry([EXECUTOR, SUPER]),
      session: EXECUTOR,
      supervisor: SUPER,
      prNumber: 601,
      prUrl: PR_URL,
      cwd: "/work/wt",
      checkpointRefPrefix: "global/cp/",
      run: gh.run,
    })
    expect(outcome).toMatchObject({ stamped: true })
    expect(gh.calls.some(c => c[0] === "api" && String(c[1]).endsWith("global/cp/wt/box-work"))).toBe(true)
  })
})
