/**
 * Conversation terminals — a native provider TUI in a PTY is a trackable
 * session linked to its provider conversation (this slice's refactor):
 *
 *   - `isConversationTerminal` splits provider TUIs (claude/hermes/grok/npx
 *     TUIs) from plain shells (`bash`, `bash -lc …`) and command rows.
 *   - `spawnPty` stamps `adapterSlug`/`nativeTerminalResume` for a native
 *     launch and the link probe binds the ONE fresh global-store transcript
 *     (never a sibling), records `adapterSessionId` + `resumeMetadata` +
 *     a conversations.jsonl row, and derives the title ONCE from the
 *     transcript's own first user message.
 *   - The graceful-exit `claude --resume <uuid>` hint is sniffed from PTY
 *     output too, not just agent-cli lines.
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry } from "../sessions.js"
import type { PtyFactory, SessionsRegistry } from "../sessions.js"
import {
  claudeCodeProjectDir,
  conversationTerminalSlugFor,
  isConversationTerminal,
} from "../conversation-store.js"
import { conversationIndexPath } from "../conversation-index.js"

describe("isConversationTerminal / conversationTerminalSlugFor", () => {
  it("classifies provider TUIs as conversation terminals", () => {
    expect(isConversationTerminal({ kind: "terminal", argv: ["claude"] })).toBe(true)
    expect(isConversationTerminal({ kind: "terminal", argv: ["/usr/local/bin/claude"] })).toBe(true)
    expect(isConversationTerminal({ kind: "terminal", adapterSlug: "claude-code" })).toBe(true)
    expect(isConversationTerminal({ kind: "terminal", argv: ["hermes", "--tui"] })).toBe(true)
    // grok: launchable + trackable even though no conversation store exists
    // yet — classify-only, title falls back to the label.
    expect(isConversationTerminal({ kind: "terminal", argv: ["grok"] })).toBe(true)
    expect(conversationTerminalSlugFor({ argv: ["grok"] })).toBe("grok-cli")
    // npx-launched TUI: the FULL launch argv must prefix the session's argv.
    expect(isConversationTerminal({ kind: "terminal", argv: ["npx", "-y", "opencode-ai"] })).toBe(true)
    expect(isConversationTerminal({ kind: "terminal", argv: ["npx", "-y", "some-random-pkg"] })).toBe(false)
    // Direct-installed (PATH) TUI binaries are the SAME terminal as the
    // npx arm — the npx spec's installed bin, not the package name.
    expect(isConversationTerminal({ kind: "terminal", argv: ["opencode"] })).toBe(true)
    expect(conversationTerminalSlugFor({ argv: ["/usr/local/bin/opencode"] })).toBe("opencode")
    expect(isConversationTerminal({ kind: "terminal", argv: ["mastracode"] })).toBe(true)
    expect(conversationTerminalSlugFor({ argv: ["mastracode", "--model", "x"] })).toBe("mastracode")
    // ...and the npx arms keep matching too.
    expect(conversationTerminalSlugFor({ argv: ["npx", "-y", "mastracode"] })).toBe("mastracode")
    // The npx package NAME alone is not a bare bin.
    expect(isConversationTerminal({ kind: "terminal", argv: ["opencode-ai"] })).toBe(false)
    // A recorded conversation-store resume id is proof by itself.
    expect(
      isConversationTerminal({
        kind: "terminal",
        argv: ["bash"],
        resumeMetadata: { claudeResumeId: "0e483f81-1a44-4bec-9667-b37158450296" },
      }),
    ).toBe(true)
  })

  it("keeps plain shells and command rows Activity-only", () => {
    expect(isConversationTerminal({ kind: "terminal", argv: ["bash"] })).toBe(false)
    expect(isConversationTerminal({ kind: "terminal", argv: ["bash", "-lc", "claude --version"] })).toBe(false)
    expect(isConversationTerminal({ kind: "terminal", argv: ["zsh"] })).toBe(false)
    expect(isConversationTerminal({ kind: "terminal", argv: ["sh"] })).toBe(false)
    expect(isConversationTerminal({ kind: "command", argv: ["claude"] })).toBe(false)
  })
})

/** Per-spawn PTY harness: captures each spawned PTY's onData callback so a
 *  test can feed output bytes through the registry's real byte path. */
function ptyHarness(): {
  factory: PtyFactory
  spawned: Array<{ feed: (chunk: string) => void }>
} {
  const spawned: Array<{ feed: (chunk: string) => void }> = []
  const factory: PtyFactory = () => {
    const handlers: Array<(chunk: string) => void> = []
    spawned.push({ feed: chunk => handlers.forEach(h => h(chunk)) })
    return {
      pid: 4242,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: (cb: (chunk: string) => void) => {
        handlers.push(cb)
      },
      onExit: () => {},
    }
  }
  return { factory, spawned }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor: condition not met in time")
    await new Promise(r => setTimeout(r, 15))
  }
}

describe("conversation-terminal link probe + index", () => {
  let fakeHome: string | undefined
  let originalHome: string | undefined
  let registry: SessionsRegistry | undefined

  afterEach(() => {
    registry?.shutdown()
    registry = undefined
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    fakeHome = undefined
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  function setup(): {
    bucketsRoot: string
    harness: ReturnType<typeof ptyHarness>
    registry: SessionsRegistry
  } {
    originalHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "conv-terminal-link-"))
    process.env.HOME = fakeHome
    const bucketsRoot = join(fakeHome, ".agentproto", "workspaces")
    const harness = ptyHarness()
    registry = createSessionsRegistry({
      bucketsRoot,
      workspacesConfigPath: join(fakeHome, ".agentproto", "workspaces.json"),
      transcriptDir: join(fakeHome, ".agentproto", "sessions"),
      spawnPty: harness.factory,
      conversationLinkProbeMs: { initialMs: 10, intervalMs: 25 },
    })
    return { bucketsRoot, harness, registry }
  }

  function writeClaudeTranscript(cwd: string, uuid: string, firstUserText?: string): string {
    const dir = claudeCodeProjectDir(cwd)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${uuid}.jsonl`)
    const lines = firstUserText
      ? [
          JSON.stringify({
            type: "user",
            timestamp: new Date().toISOString(),
            message: { role: "user", content: firstUserText },
          }),
        ]
      : []
    writeFileSync(path, lines.join("\n") + (lines.length ? "\n" : ""))
    return path
  }

  function lastIndexRecord(bucketsRoot: string): Record<string, unknown> | undefined {
    const path = conversationIndexPath(bucketsRoot, "default")
    if (!existsSync(path)) return undefined
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    const last = lines.at(-1)
    return last ? (JSON.parse(last) as Record<string, unknown>) : undefined
  }

  it("links the ONE fresh transcript: adapterSessionId + resumeMetadata + index row + title from the first user line", async () => {
    const { bucketsRoot, harness, registry } = setup()
    const cwd = "/fake/conv-term-proj"
    const uuid = "aaaaaaaa-1111-2222-3333-444444444444"

    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd,
      argv: ["claude"],
      cols: 80,
      rows: 24,
      label: "claude-code",
    })
    // Spawn-time identity stamps for a native launch.
    expect(desc.adapterSlug).toBe("claude-code")
    expect(desc.nativeTerminalResume).toBe(true)
    expect(desc.renamedByUser).toBe(false)
    expect(desc.adapterSessionId).toBeUndefined()

    const transcriptPath = writeClaudeTranscript(cwd, uuid, "Fix the flaky watchdog test in CI")
    // Probe waits for FIRST OUTPUT before touching the fs.
    harness.spawned[0]!.feed("[2J claude tui banner\r\n")

    await waitFor(() => registry.get(desc.id)?.adapterSessionId !== undefined)
    const linked = registry.get(desc.id)!
    expect(linked.adapterSessionId).toBe(uuid)
    expect(linked.resumeMetadata?.claudeResumeId).toBe(uuid)
    expect(linked.linkStatus).toBeUndefined()
    // Title derived from the transcript's OWN first user message; it beats
    // the spawn label because spawnPty stamps renamedByUser: false.
    expect(linked.title).toBe("Fix the flaky watchdog test in CI")

    await waitFor(() => lastIndexRecord(bucketsRoot) !== undefined)
    const record = lastIndexRecord(bucketsRoot)!
    expect(record.sessionId).toBe(desc.id)
    expect(record.adapterSlug).toBe("claude-code")
    expect(record.adapterSessionId).toBe(uuid)
    expect((record.native as { kind: string; path: string }).kind).toBe("claude-jsonl")
    expect((record.native as { kind: string; path: string }).path).toBe(transcriptPath)
    expect(record.title).toBe("Fix the flaky watchdog test in CI")
  })

  it("stamps the exact native id when restarting OpenCode with -s", () => {
    const { registry } = setup()
    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd: "/fake/opencode-resume",
      argv: ["opencode", "-s", "ses_own123"],
      cols: 80,
      rows: 24,
    })
    expect(desc.adapterSlug).toBe("opencode")
    expect(desc.nativeTerminalResume).toBe(true)
    expect(desc.adapterSessionId).toBe("ses_own123")
    expect(desc.resumeMetadata?.openCodeResumeId).toBe("ses_own123")
  })

  it("the title is read once — a later transcript edit does not retitle the row", async () => {
    const { harness, registry } = setup()
    const cwd = "/fake/conv-term-title-once"
    const uuid = "bbbbbbbb-1111-2222-3333-444444444444"

    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd,
      argv: ["claude"],
      cols: 80,
      rows: 24,
    })
    const path = writeClaudeTranscript(cwd, uuid, "Original first prompt")
    harness.spawned[0]!.feed("banner\r\n")
    await waitFor(() => registry.get(desc.id)?.title !== undefined)
    expect(registry.get(desc.id)?.title).toBe("Original first prompt")

    writeFileSync(
      path,
      JSON.stringify({
        type: "user",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Rewritten prompt that must NOT win" },
      }) + "\n",
    )
    // Two probe intervals later the title is untouched — the probe stopped
    // at link time and the title was derived exactly once.
    await new Promise(r => setTimeout(r, 80))
    expect(registry.get(desc.id)?.title).toBe("Original first prompt")
  })

  it("ambiguous discover binds NOTHING: several fresh transcripts ⇒ linkStatus ambiguous, no id, no index row", async () => {
    const { bucketsRoot, harness, registry } = setup()
    const cwd = "/fake/conv-term-ambiguous"

    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd,
      argv: ["claude"],
      cols: 80,
      rows: 24,
    })
    writeClaudeTranscript(cwd, "cccccccc-1111-2222-3333-444444444444", "one")
    writeClaudeTranscript(cwd, "dddddddd-1111-2222-3333-444444444444", "two")
    harness.spawned[0]!.feed("banner\r\n")

    await waitFor(() => registry.get(desc.id)?.linkStatus === "ambiguous")
    const after = registry.get(desc.id)!
    expect(after.adapterSessionId).toBeUndefined()
    expect(after.resumeMetadata?.claudeResumeId).toBeUndefined()
    expect(lastIndexRecord(bucketsRoot)).toBeUndefined()
  })

  it("a bash PTY gets no probe, no stamps, and no index row — even when its output looks like a resume hint", async () => {
    const { bucketsRoot, harness, registry } = setup()
    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd: "/fake/plain-shell",
      argv: ["bash"],
      cols: 80,
      rows: 24,
    })
    expect(desc.adapterSlug).toBeUndefined()
    expect(desc.nativeTerminalResume).toBeUndefined()
    harness.spawned[0]!.feed(
      "\r\nResume this session with: claude --resume 0e483f81-1a44-4bec-9667-b37158450296\r\n",
    )
    await new Promise(r => setTimeout(r, 80))
    const after = registry.get(desc.id)!
    expect(after.resumeMetadata).toBeUndefined()
    expect(after.adapterSessionId).toBeUndefined()
    expect(lastIndexRecord(bucketsRoot)).toBeUndefined()
  })

  it("sniffs the graceful-exit `claude --resume <uuid>` hint from CONVERSATION-terminal output and records the link", async () => {
    const { bucketsRoot, harness, registry } = setup()
    const cwd = "/fake/conv-term-hint"
    const uuid = "eeeeeeee-1111-2222-3333-444444444444"

    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd,
      argv: ["claude"],
      cols: 80,
      rows: 24,
    })
    harness.spawned[0]!.feed(`\r\nResume this session with: claude --resume ${uuid}\r\n`)

    await waitFor(() => registry.get(desc.id)?.resumeMetadata?.claudeResumeId !== undefined)
    expect(registry.get(desc.id)?.resumeMetadata?.claudeResumeId).toBe(uuid)
    await waitFor(() => lastIndexRecord(bucketsRoot) !== undefined)
    expect(lastIndexRecord(bucketsRoot)?.adapterSessionId).toBe(uuid)
  })
})
