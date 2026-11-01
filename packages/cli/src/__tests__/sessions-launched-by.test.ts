/**
 * `agentproto sessions` shows WHO launched a session: the derived `LAUNCHED
 * BY` column between AGE and COMMAND. It is conditional (no column of dashes
 * when every row is a plain root), resolves a parent's label from the SAME
 * list, truncates at 40 characters, and prints `-` for a row with nothing to
 * say once the column is shown.
 *
 * Fake-daemon pattern borrowed from `sessions-worktree-column.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions } from "../commands/sessions.js"
import { launchedByText } from "@agentproto/runtime"
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

function session(id: string, over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id,
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude-code --print",
    pid: 1,
    status: "running",
    startedAt: "2026-11-01T10:00:00.000Z",
    ...over,
  }
}

function plainLines(stdout: readonly string[]): string[] {
  return stdout
    .join("")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .filter(l => l !== "")
}

/** Split a rendered table line into its cells (two-or-more spaces separate
 *  columns; a cell's own text only ever contains single spaces). */
function cells(line: string): string[] {
  return line.trimEnd().split(/\s{2,}/)
}

function cellFor(stdout: readonly string[], id: string, column: string): string {
  const lines = plainLines(stdout)
  const header = cells(lines[0]!)
  const col = header.indexOf(column)
  expect(col).toBeGreaterThanOrEqual(0)
  const row = lines.find(l => cells(l)[header.indexOf("ID")] === id)
  expect(row).toBeDefined()
  return cells(row!)[col]!
}

describe("agentproto sessions: LAUNCHED BY column", () => {
  let stdout: string[]

  beforeEach(() => {
    stdout = []
    vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
      stdout.push(String(chunk))
      return true
    })
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    httpGetJson.mockReset()
  })

  it("prints exactly the old table when no row has provenance", async () => {
    httpGetJson.mockResolvedValue({
      sessions: [session("sess_root1"), session("sess_root2", { status: "exited" })],
    })

    expect(await runSessions([])).toBe(0)

    const lines = plainLines(stdout)
    expect(cells(lines[0]!)).toEqual(["PIN", "ID", "KIND", "WORKSPACE", "STATUS", "AGE", "COMMAND"])
    expect(lines.join("\n")).not.toContain("LAUNCHED BY")
  })

  it("resolves the parent's label from the same list", async () => {
    httpGetJson.mockResolvedValue({
      sessions: [
        session("sess_parent", { label: "brain" }),
        session("sess_child", { parentSessionId: "sess_parent" }),
      ],
    })

    expect(await runSessions([])).toBe(0)

    expect(cellFor(stdout, "sess_child", "LAUNCHED BY")).toBe(
      "session sess_parent (brain)",
    )
  })

  it("shows just the id when the parent is not in the list", async () => {
    httpGetJson.mockResolvedValue({
      sessions: [session("sess_child", { parentSessionId: "sess_absent" })],
    })

    expect(await runSessions([])).toBe(0)

    expect(cellFor(stdout, "sess_child", "LAUNCHED BY")).toBe("session sess_absent")
  })

  it("shows an operator-launched root with its origin", async () => {
    httpGetJson.mockResolvedValue({
      sessions: [session("sess_op", { operatorLabel: "jeremy", origin: "vscode" })],
    })

    expect(await runSessions([])).toBe(0)

    expect(cellFor(stdout, "sess_op", "LAUNCHED BY")).toBe("operator via vscode")
  })

  it("shows an origin-only row", async () => {
    httpGetJson.mockResolvedValue({
      sessions: [session("sess_cron", { origin: "cron" })],
    })

    expect(await runSessions([])).toBe(0)

    expect(cellFor(stdout, "sess_cron", "LAUNCHED BY")).toBe("cron")
  })

  it("truncates the cell at 40 characters", async () => {
    const longParent = "sess_a_very_long_parent_identifier_that_will_not_fit"
    const row = session("sess_child", { parentSessionId: longParent })
    httpGetJson.mockResolvedValue({ sessions: [row] })

    expect(await runSessions([])).toBe(0)

    const full = launchedByText({ kind: "session", sessionId: longParent })
    expect(full.length).toBeGreaterThan(40)
    const expected = full.slice(0, 39) + "…"
    expect(cellFor(stdout, "sess_child", "LAUNCHED BY")).toBe(expected)
    // The column is capped at 40 wide (plus the two-space gutter), so a long
    // parent id cannot push COMMAND further right.
    const header = plainLines(stdout)[0]!
    expect(header.indexOf("COMMAND") - header.indexOf("LAUNCHED BY")).toBe(40 + 2)
  })

  it("prints - for a row with nothing once another row shows a value", async () => {
    httpGetJson.mockResolvedValue({
      sessions: [session("sess_cron", { origin: "cron" }), session("sess_plain")],
    })

    expect(await runSessions([])).toBe(0)

    expect(cellFor(stdout, "sess_cron", "LAUNCHED BY")).toBe("cron")
    expect(cellFor(stdout, "sess_plain", "LAUNCHED BY")).toBe("-")
  })
})
