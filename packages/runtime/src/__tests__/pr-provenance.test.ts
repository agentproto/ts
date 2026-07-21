/**
 * Unit tests for the pure PR-provenance footer core (pr-provenance.ts):
 *   - buildFooter stays BYTE-IDENTICAL to the runner-lane format that
 *     scripts/lib/__tests__/provenance-footer.test.mjs pins (one format,
 *     re-exported — not a parallel one), and renders the daemon-lane
 *     additions (auth profile, supervisor, source "daemon" host/cwd)
 *   - sessionFooterProvenance maps a SessionDescriptor-shaped executor +
 *     supervisor onto the footer's provenance shape
 *   - parseGhPrCreate recognises a `gh pr create` and extracts url + number
 *   - pickExecutorSession attributes a command to the right agent session
 *   - appendFooterOnce is idempotent on the marker
 */

import { describe, expect, it } from "vitest"
import {
  appendFooterOnce,
  buildFooter,
  buildSessionPrFooter,
  MARKER,
  parseGhPrCreate,
  pickExecutorSession,
  sessionFooterProvenance,
  type FooterSession,
} from "../pr-provenance.js"

describe("buildFooter — format parity with the runner lanes", () => {
  const baseProv = {
    sessionId: "sess_abc123",
    label: "fix-foo",
    adapter: "claude-code",
    model: "kimi-k2.7-code",
    tokensIn: 12345,
    tokensOut: 67890,
    costUsd: 0.1234,
  }

  it("CI shape is byte-identical to the existing render (run link, no host/cwd)", () => {
    const footer = buildFooter({
      prov: { ...baseProv, source: "adapter" },
      authMode: "subscription",
      runId: "123456789",
      runUrl: "https://github.com/agentproto/ts/actions/runs/123456789",
      sha: "abcdef1234567890",
      kind: "PR",
    })
    expect(footer).toBe(
      "\n\n---\n" +
        "<sub>🤖 **@agentproto-bot** — PR · session `sess_abc123` (`fix-foo`) · " +
        "claude-code / subscription · model `kimi-k2.7-code` · 12.3k in / 67.9k out · $0.1234 · " +
        "run [123456789](https://github.com/agentproto/ts/actions/runs/123456789) · " +
        "sha `abcdef1`</sub>",
    )
  })

  it("local shape renders host/cwd + cost and omits the run link", () => {
    const footer = buildFooter({
      prov: {
        ...baseProv,
        source: "local",
        host: "jeremy-mac-studio",
        cwd: "/Volumes/SSDExternalMacStudio/Code/_agentproto-worktrees/ts/local-pr-provenance-audit",
      },
      authMode: "subscription",
      sha: "abcdef1234567890",
      kind: "PR",
    })
    expect(footer).toBe(
      "\n\n---\n" +
        "<sub>🤖 **@agentproto-bot** — PR · session `sess_abc123` (`fix-foo`) · " +
        "claude-code / subscription · model `kimi-k2.7-code` · 12.3k in / 67.9k out · $0.1234 (local) · " +
        "host `jeremy-mac-studio` · cwd `local-pr-provenance-audit` · " +
        "sha `abcdef1`</sub>",
    )
  })

  it("omits the auth-profile part when absent (back-compat with runner lanes)", () => {
    const footer = buildFooter({ prov: { ...baseProv, source: "adapter" }, authMode: "subscription", kind: "PR" })
    expect(footer).not.toContain("auth-profile")
  })

  it("exposes the deterministic marker", () => {
    expect(MARKER).toBe("@agentproto-bot")
  })
})

describe("buildFooter — daemon-lane additions", () => {
  it("renders the bound auth-profile identity after the engine, before the model", () => {
    const footer = buildFooter({
      prov: {
        sessionId: "sess_d1",
        label: "daemon-run",
        adapter: "claude-code",
        authProfile: "Jeremy Max",
        model: "opus-4.8",
        source: "daemon",
      },
      authMode: "subscription",
      kind: "PR",
    })
    expect(footer).toContain("claude-code / subscription · auth-profile `Jeremy Max` · model `opus-4.8`")
  })

  it("renders the supervisor and, for source=daemon, host/cwd (no run link)", () => {
    const footer = buildFooter({
      prov: {
        sessionId: "sess_child",
        adapter: "codex",
        parentSessionId: "sess_parent",
        source: "daemon",
        host: "build-box",
        cwd: "/work/pr-provenance-daemon-path",
      },
      authMode: "api-key",
      // A runId is present but source=daemon must still prefer host/cwd:
      runId: "999",
      runUrl: "https://x/999",
      kind: "PR",
    })
    expect(footer).toContain("supervisor `sess_parent`")
    expect(footer).toContain("host `build-box` · cwd `pr-provenance-daemon-path`")
    expect(footer).not.toContain("run [999]")
  })
})

describe("sessionFooterProvenance", () => {
  const session: FooterSession = {
    id: "sess_exec",
    kind: "agent-cli",
    status: "running",
    startedAt: "2026-07-21T10:00:00.000Z",
    label: "open-pr",
    cwd: "/work/wt",
    adapterSlug: "claude-code",
    harness: "claude-code",
    model: "opus-4.8",
    costUsd: 0.5,
    tokensIn: 100,
    tokensOut: 200,
    auth: { mode: "subscription" },
    accessProfile: { profileRef: "prof_1", label: "Jeremy Max" },
  }

  it("maps executor + supervisor onto the footer prov shape (identity, not secret)", () => {
    const { prov, authMode } = sessionFooterProvenance(session, {
      supervisor: { id: "sess_super" },
      host: "build-box",
    })
    expect(prov).toMatchObject({
      sessionId: "sess_exec",
      label: "open-pr",
      adapter: "claude-code",
      model: "opus-4.8",
      authProfile: "Jeremy Max",
      parentSessionId: "sess_super",
      source: "daemon",
      host: "build-box",
      cwd: "/work/wt",
      costUsd: 0.5,
      tokensIn: 100,
      tokensOut: 200,
    })
    expect(authMode).toBe("subscription")
  })

  it("prefers the profile label, falls back to its ref, never leaks a credential", () => {
    const { prov } = sessionFooterProvenance(
      { ...session, accessProfile: { profileRef: "prof_only" } },
      {},
    )
    expect(prov.authProfile).toBe("prof_only")
  })

  it("buildSessionPrFooter renders a full daemon footer end to end", () => {
    const footer = buildSessionPrFooter(session, { supervisor: { id: "sess_super" }, host: "build-box" })
    expect(footer).toContain("session `sess_exec` (`open-pr`)")
    expect(footer).toContain("claude-code / subscription")
    expect(footer).toContain("auth-profile `Jeremy Max`")
    expect(footer).toContain("supervisor `sess_super`")
    expect(footer).not.toContain("legacy fallback")
  })
})

describe("parseGhPrCreate", () => {
  it("extracts url + number from a successful create", () => {
    expect(
      parseGhPrCreate("gh", ["pr", "create", "--title", "x"], "https://github.com/agentproto/ts/pull/601\n"),
    ).toEqual({ url: "https://github.com/agentproto/ts/pull/601", number: 601 })
  })

  it("takes the LAST pull URL so an advisory notice can't shadow the real one", () => {
    const stdout =
      "Warning: see https://github.com/agentproto/ts/pull/1 for context\nhttps://github.com/agentproto/ts/pull/602\n"
    expect(parseGhPrCreate("/usr/bin/gh", ["pr", "create"], stdout)).toEqual({
      url: "https://github.com/agentproto/ts/pull/602",
      number: 602,
    })
  })

  it("returns null for non-create gh commands and non-gh commands", () => {
    expect(parseGhPrCreate("gh", ["pr", "view", "1"], "https://x/pull/1")).toBeNull()
    expect(parseGhPrCreate("gh", ["issue", "create"], "https://x/pull/1")).toBeNull()
    expect(parseGhPrCreate("git", ["pr", "create"], "https://x/pull/1")).toBeNull()
  })

  it("returns null when a create printed no PR URL", () => {
    expect(parseGhPrCreate("gh", ["pr", "create"], "aborting: already exists\n")).toBeNull()
  })
})

describe("pickExecutorSession", () => {
  const mk = (over: Partial<FooterSession>): FooterSession => ({
    id: "s",
    kind: "agent-cli",
    status: "running",
    startedAt: "2026-07-21T10:00:00.000Z",
    cwd: "/work/wt",
    ...over,
  })

  it("prefers the newest LIVE agent-cli session whose cwd is related", () => {
    const sessions = [
      mk({ id: "old", startedAt: "2026-07-21T09:00:00.000Z" }),
      mk({ id: "new", startedAt: "2026-07-21T11:00:00.000Z" }),
      mk({ id: "cmd", kind: "command" }),
    ]
    expect(pickExecutorSession(sessions, "/work/wt/sub/dir")?.id).toBe("new")
  })

  it("falls back to the newest matching session when none are alive", () => {
    const sessions = [
      mk({ id: "a", status: "exited", startedAt: "2026-07-21T09:00:00.000Z" }),
      mk({ id: "b", status: "exited", startedAt: "2026-07-21T10:30:00.000Z" }),
    ]
    expect(pickExecutorSession(sessions, "/work/wt")?.id).toBe("b")
  })

  it("returns undefined when no agent-cli session matches the cwd", () => {
    expect(pickExecutorSession([mk({ cwd: "/elsewhere" })], "/work/wt")).toBeUndefined()
    expect(pickExecutorSession([mk({ kind: "command" })], "/work/wt")).toBeUndefined()
  })
})

describe("appendFooterOnce", () => {
  it("appends the footer once and is idempotent on the marker", () => {
    const footer = `\n\n---\n<sub>🤖 **${MARKER}** — PR</sub>`
    const once = appendFooterOnce("Body text.", footer)
    expect(once).toBe("Body text." + footer)
    expect(appendFooterOnce(once, footer)).toBe(once)
  })
})
