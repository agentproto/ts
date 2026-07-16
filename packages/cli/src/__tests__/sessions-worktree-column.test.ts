/**
 * `agentproto sessions` must show which worktree an agent is in — the
 * session→worktree edge recorded at spawn (`SessionDescriptor.worktreePath`).
 * Without it the table answers "what is running" but not "where", and a
 * human juggling several worktrees can't tell two agents apart.
 *
 * The column is conditional, which is the part worth pinning: it appears only
 * when some row actually has a worktree, so a daemon whose sessions all run
 * in plain checkouts doesn't grow a column of em-dashes.
 *
 * Fake-daemon pattern borrowed from sessions-json-fields.test.ts: intercept
 * `discoverDaemon` + `httpGetJson` so no socket IO happens, then assert on
 * what was written to stdout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions } from "../commands/sessions.js"
import type { SessionDescriptor } from "@agentproto/runtime"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)

/** An agent spawned in a provisioned worktree — path + generation id. */
const inWorktree: SessionDescriptor = {
  id: "sess_wt0001",
  kind: "agent-cli",
  workspaceSlug: "default",
  command: "claude-code",
  pid: 12345,
  status: "running",
  startedAt: "2026-07-16T22:41:00.000Z",
  cwd: "/Volumes/Code/_worktrees/ts/session-worktree-identity/packages/runtime",
  worktreePath: "/Volumes/Code/_worktrees/ts/session-worktree-identity",
  worktreeId: "wt_f6bbf517",
  adapterSlug: "claude-code",
}

/** An agent in a plain checkout — no worktree fields at all, as for every
 *  session persisted before they existed. */
const inCheckout: SessionDescriptor = {
  id: "sess_main01",
  kind: "agent-cli",
  workspaceSlug: "default",
  command: "hermes acp",
  pid: 12346,
  status: "running",
  startedAt: "2026-07-16T22:42:00.000Z",
  cwd: "/Volumes/Code/agentproto/ts",
  adapterSlug: "hermes",
}

describe("agentproto sessions — WORKTREE column", () => {
  let stdout: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(() => {
    stdout = []
    stdoutSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stdout as any, "write")
      .mockImplementation((chunk: unknown) => {
        stdout.push(String(chunk))
        return true
      })
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("shows the worktree's leaf directory when a session is in one", async () => {
    httpGetJson.mockResolvedValue({ sessions: [inWorktree, inCheckout] })

    expect(await runSessions([])).toBe(0)

    const out = stdout.join("")
    expect(out).toContain("WORKTREE")
    // The leaf name, not the full path — the path is in --json / DETAIL.
    expect(out).toContain("session-worktree-identity")
    expect(out).not.toContain("/Volumes/Code/_worktrees")
    // The plain-checkout row still renders, just with nothing in the column.
    expect(out).toContain("sess_main01")
    expect(out).toContain("—")
  })

  it("truncates a worktree name too long for the column", async () => {
    const longName = "feat-a-very-long-branch-name-that-will-not-fit-in-the-column"
    httpGetJson.mockResolvedValue({
      sessions: [{ ...inWorktree, worktreePath: `/Volumes/Code/_worktrees/ts/${longName}` }],
    })

    expect(await runSessions([])).toBe(0)

    const out = stdout.join("")
    expect(out).not.toContain(longName)
    expect(out).toContain("feat-a-very-long-branch-name-th…")
  })

  it("omits the column entirely when no session is in a worktree", async () => {
    httpGetJson.mockResolvedValue({ sessions: [inCheckout] })

    expect(await runSessions([])).toBe(0)

    const out = stdout.join("")
    expect(out).not.toContain("WORKTREE")
    expect(out).toContain("sess_main01")
  })

  it("carries worktreePath + worktreeId through --json", async () => {
    httpGetJson.mockResolvedValue({ sessions: [inWorktree, inCheckout] })

    expect(await runSessions(["--json"])).toBe(0)

    const rows = JSON.parse(stdout.join("")) as SessionDescriptor[]
    expect(rows.find(r => r.id === "sess_wt0001")).toMatchObject({
      worktreePath: "/Volumes/Code/_worktrees/ts/session-worktree-identity",
      worktreeId: "wt_f6bbf517",
    })
    expect(rows.find(r => r.id === "sess_main01")?.worktreePath).toBeUndefined()
  })
})
