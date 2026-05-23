/**
 * File substrate — append-only markdown journal.
 *
 * Each turn is delimited by a header line:
 *   === TURN id=<id> participant=<pid> ts=<iso> ===
 *   <body lines…>
 *
 * Ids are content-hashed, so re-running an append with the same body
 * is idempotent at the row level.
 *
 * Caveats:
 *   - `appendFile` does not fsync. A power-loss between buffered write
 *     and disk flush can lose the most recent turn(s); callers that
 *     need durability across crashes should layer their own fsync.
 *   - The parser splits on lines matching `=== TURN ... ===`. Turn
 *     content containing such a line will corrupt subsequent parses.
 *     Treat turn content as untrusted? Sanitize before append.
 */

import { appendFile, readFile, writeFile, mkdir, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { createHash } from "node:crypto"
import type { Substrate, Turn, TurnInput, TurnId } from "../ports.js"

export type FileSubstrateOptions = {
  /** Absolute path to the journal file. */
  readonly path: string
}

const HEADER_RE =
  /^=== TURN id=([^\s]+) participant=([^\s]+) ts=([^\s]+) ===$/

export class FileSubstrate implements Substrate {
  readonly kind = "file"

  constructor(private readonly opts: FileSubstrateOptions) {}

  async append(input: TurnInput): Promise<Turn> {
    const timestamp = input.timestamp ?? new Date().toISOString()
    const id = hashTurnId(input.participantId, timestamp, input.content)
    const turn: Turn = {
      id,
      participantId: input.participantId,
      timestamp,
      content: input.content,
      meta: input.meta,
    }
    await ensureDir(this.opts.path)
    const block = formatTurnBlock(turn)
    await appendFile(this.opts.path, block, "utf8")
    return turn
  }

  async read(since?: TurnId): Promise<readonly Turn[]> {
    let raw: string
    try {
      raw = await readFile(this.opts.path, "utf8")
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
    const turns = parseJournal(raw)
    if (since === undefined) return turns
    const cutoff = turns.findIndex((t) => t.id === since)
    if (cutoff === -1) return turns
    return turns.slice(cutoff + 1)
  }
}

/**
 * Reset the journal by truncating it. Useful for tests. Not part of the
 * Substrate interface — callers must reach for the adapter directly.
 */
export async function resetFileSubstrate(path: string): Promise<void> {
  await ensureDir(path)
  await writeFile(path, "", "utf8")
}

function formatTurnBlock(turn: Turn): string {
  const header = `=== TURN id=${turn.id} participant=${turn.participantId} ts=${turn.timestamp} ===\n`
  const body = turn.content.endsWith("\n") ? turn.content : `${turn.content}\n`
  return `${header}${body}`
}

function parseJournal(raw: string): Turn[] {
  const lines = raw.split("\n")
  const turns: Turn[] = []
  let current: { id: string; pid: string; ts: string; buf: string[] } | null = null

  for (const line of lines) {
    const match = HEADER_RE.exec(line)
    if (match && match[1] && match[2] && match[3]) {
      if (current) turns.push(materialise(current))
      current = { id: match[1], pid: match[2], ts: match[3], buf: [] }
      continue
    }
    if (current) current.buf.push(line)
  }
  if (current) turns.push(materialise(current))
  return turns
}

function materialise(c: {
  id: string
  pid: string
  ts: string
  buf: string[]
}): Turn {
  // Drop the trailing empty line that appendFile leaves between blocks.
  let body = c.buf.join("\n")
  while (body.endsWith("\n")) body = body.slice(0, -1)
  return {
    id: c.id,
    participantId: c.pid,
    timestamp: c.ts,
    content: body,
  }
}

function hashTurnId(pid: string, ts: string, content: string): string {
  const h = createHash("sha256")
  h.update(pid)
  h.update("\x00")
  h.update(ts)
  h.update("\x00")
  h.update(content)
  return `t_${h.digest("hex").slice(0, 12)}`
}

async function ensureDir(path: string): Promise<void> {
  const dir = dirname(path)
  try {
    await stat(dir)
  } catch (err) {
    if (isNotFound(err)) {
      await mkdir(dir, { recursive: true })
      return
    }
    throw err
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  )
}
