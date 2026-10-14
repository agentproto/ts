/**
 * Full-transcript handoff for a restarted session that could not resume
 * natively (the blank-fallback / box-restart paths — see
 * `session-restart-core.ts`'s `resumeFallback` gate).
 *
 * A restarted session used to get only `buildResumeContextDigest`'s ~7k-char
 * summary injected as `pendingResumeContext` — a long session lost its goal,
 * its plan, and everything it had already tried. This module does two things
 * instead:
 *
 *   1. Exports the prior session's FULL daemon transcript to Markdown and
 *      writes it to a stable path — inside the box at
 *      `/home/user/.agentproto/prior-sessions/<id>.md` for a sandbox restart
 *      (outside the repo checkout, so the delivery hook never commits it),
 *      or into the fresh session's own host transcript dir for a local
 *      blank-fallback — so the restarted agent can READ the whole history
 *      instead of being handed a digest of it.
 *
 *   2. Builds a structured handoff prompt — a frame saying what happened /
 *      what was restored / what was lost, a `renderCheckpointPrompt` of a
 *      deterministic (extractor-only, no LLM handoff turn: the prior agent
 *      is dead) checkpoint, the most recent turns (~24k chars), and the
 *      transcript path(s) with an instruction to read them — and injects it
 *      once via `SessionDescriptor.pendingResumeContext`.
 *
 * Everything here is best-effort: a failure falls back to the old digest
 * (or to no injection at all), and never fails the restart itself.
 */

import { Buffer } from "node:buffer"
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises"
import { join } from "node:path"
import {
  buildContextCheckpoint,
  persistCheckpoint,
  renderCheckpointPrompt,
  type ContextCheckpoint,
} from "./context-checkpoint.js"
import {
  CONTEXT_CONTINUITY_DEFAULTS,
  computeContextPct,
} from "./context-continuity.js"
import {
  exportDaemonEventsSession,
  renderMarkdown,
  type ExportedMessage,
} from "./transcript-export.js"
import { sessionTranscriptDir } from "./transcript-writer.js"
import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"

/** In-box directory holding full prior-session transcripts — outside any
 *  repo checkout so the workspace delivery hook never commits it. */
export const BOX_PRIOR_SESSION_DIR = "/home/user/.agentproto/prior-sessions"

/** Tool-result bodies in the in-box full transcript: generous (the whole
 *  point is completeness) but still bounded so one giant tool result can't
 *  make the write path quadratic. */
export const BOX_TRANSCRIPT_TOOL_CHAR_CAP = 2000

/** Character budget for the most-recent-turns slice inlined into the
 *  handoff prompt itself (the full transcript lives in the file). */
const RECENT_TURNS_CHAR_BUDGET = 24_000

/** Tool-result bodies in the inlined recent-turns slice — tighter than the
 *  file's cap, since these ride the first prompt. */
const RECENT_TURNS_TOOL_CHAR_CAP = 400

/** Max restart hops walked back for ancestor transcript files: when `prev`
 *  was itself a restart, ITS ancestors' transcripts are written too, but at
 *  most this many links up the `resumedFrom` chain. */
export const ANCESTOR_HOP_CAP = 5

/** What a restart hands back so CLI/VS Code/session-chat can say
 *  "conversation restored from transcript (N messages)". */
export interface RestartHandoff {
  /** Primary in-box (or host) path of the full prior transcript. */
  transcriptPath: string
  /** Checkpoint id built from the prior transcript (deterministic
   *  extractors only — the prior agent is dead, so no handoff turn). */
  checkpointId: string
  /** Rendered length of the recent-turns slice inlined in the prompt. */
  recentChars: number
  /** Messages recovered from the prior session's daemon transcript. */
  totalMessages: number
}

/** Minimal file seam both `SandboxAgentSessionHost` and a raw
 *  `BootedSandbox` satisfy — the host forwards the booted sandbox's
 *  `writeFile`/`exec`, so one writer covers the re-attach and fresh-box
 *  paths. */
export interface BoxFileSink {
  writeFile?(path: string, data: Uint8Array): Promise<void>
  exec?(opts: {
    command: string
    cwd?: string
  }): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>
}

/** Result of a handoff build — `text` becomes `pendingResumeContext`. */
export interface BuiltRestartHandoff {
  text: string
  handoff: RestartHandoff
  /** True when the handoff contains actual recovered conversation
   *  content (mirrors `ResumeContextDigestResult.hasContent`). */
  digestRecovered: boolean
}

function renderTranscriptMarkdown(
  messages: ExportedMessage[],
  maxToolChars: number,
): string {
  return renderMarkdown({ meta: {}, messages }, { maxToolChars })
}

/** Export `sessionId`'s daemon transcript as full-fidelity Markdown.
 *  Returns undefined when there is no transcript (missing or empty) —
 *  the caller falls back to the old digest. */
async function exportTranscriptMarkdown(
  sessionId: string,
  maxToolChars: number,
): Promise<{ markdown: string; totalMessages: number } | undefined> {
  let messages: ExportedMessage[]
  try {
    messages = (await exportDaemonEventsSession(sessionId)).messages
  } catch {
    return undefined
  }
  if (messages.length === 0) return undefined
  return {
    markdown: renderTranscriptMarkdown(messages, maxToolChars),
    totalMessages: messages.length,
  }
}

/** Base64 chunk size for the exec fallback write path — ~48 KiB of UTF-8
 *  per shell command, well under ARG_MAX on any box. */
const EXEC_B64_CHUNK = 48 * 1024

async function writeViaExec(sink: BoxFileSink, path: string, markdown: string): Promise<void> {
  if (!sink.exec) throw new Error("box file sink has neither writeFile nor exec")
  const dir = path.slice(0, path.lastIndexOf("/"))
  const mk = await sink.exec({ command: `mkdir -p '${dir}'` })
  if (mk.exitCode !== 0) {
    throw new Error(`mkdir '${dir}' failed (exit ${mk.exitCode}): ${mk.stderr}`)
  }
  const b64 = Buffer.from(markdown, "utf8").toString("base64")
  for (let i = 0, first = true; i < b64.length; i += EXEC_B64_CHUNK, first = false) {
    const chunk = b64.slice(i, i + EXEC_B64_CHUNK)
    const redirect = first ? ">" : ">>"
    const res = await sink.exec({
      command: `printf '%s' '${chunk}' | base64 -d ${redirect} '${path}'`,
    })
    if (res.exitCode !== 0) {
      throw new Error(`write '${path}' failed (exit ${res.exitCode}): ${res.stderr}`)
    }
  }
}

/** Write one transcript into the box — `writeFile` when the provider
 *  exposes it, else base64 chunks over `exec`. Throws on failure so the
 *  caller can decide whether the PRIMARY file's absence means "fall back". */
export async function writeTranscriptToBox(
  sink: BoxFileSink,
  path: string,
  markdown: string,
): Promise<void> {
  if (sink.writeFile) {
    await sink.writeFile(path, new Uint8Array(Buffer.from(markdown, "utf8")))
    return
  }
  await writeViaExec(sink, path, markdown)
}

/** In-box path of a prior session's full transcript file. */
export function boxPriorSessionPath(sessionId: string): string {
  return `${BOX_PRIOR_SESSION_DIR}/${sessionId}.md`
}

/**
 * Export the full transcript of `prev` (and, when `prev` was itself a
 * restart, of its `resumedFrom` ancestors — at most {@link ANCESTOR_HOP_CAP}
 * hops) and write each into the box. The PRIMARY file (prev's own) must be
 * written for this to count as success: its failure yields `{ ok: false }`
 * so the caller falls back to the old digest. An ancestor failure just
 * drops that file — the chain is a bonus, never a blocker.
 */
export async function writeBoxPriorTranscripts(
  sink: BoxFileSink,
  prev: SessionDescriptor,
  registry: SessionsRegistry,
): Promise<{ ok: boolean; paths: string[] }> {
  const paths: string[] = []
  const primary = await exportTranscriptMarkdown(prev.id, BOX_TRANSCRIPT_TOOL_CHAR_CAP)
  if (!primary) return { ok: false, paths }
  const primaryPath = boxPriorSessionPath(prev.id)
  try {
    await writeTranscriptToBox(sink, primaryPath, primary.markdown)
  } catch {
    return { ok: false, paths }
  }
  paths.push(primaryPath)

  let cursor: SessionDescriptor | undefined = prev
  for (let hop = 0; hop < ANCESTOR_HOP_CAP && cursor?.resumedFrom; hop++) {
    const ancestor = registry.get(cursor.resumedFrom)
    if (!ancestor) break
    const exported = await exportTranscriptMarkdown(ancestor.id, BOX_TRANSCRIPT_TOOL_CHAR_CAP)
    if (!exported) break
    const path = boxPriorSessionPath(ancestor.id)
    try {
      await writeTranscriptToBox(sink, path, exported.markdown)
    } catch {
      break
    }
    paths.push(path)
    cursor = ancestor
  }
  return { ok: true, paths }
}
