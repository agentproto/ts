/**
 * Turn-bounded transcript chunking.
 *
 * Splits a conversation's turns into markdown chunks with a byte ceiling, but
 * NEVER inside a turn — a chunk boundary only ever falls between two turns.
 * This is what lets `ingest-pipeline.ts` write each chunk as its own file
 * under `sources/`, so the `files` BM25 adapter indexes it as its own doc:
 * one 800-turn session becomes N right-sized docs instead of one giant doc
 * whose BM25 ranking degrades with length and whose snippet is always the
 * first ~300 bytes (the start of the transcript, rarely the relevant part).
 *
 * Pure functions, no I/O — `renderTurn`/`labelRole` intentionally mirror
 * corpus's `ConversationImporter.renderTranscript` (`Role: text` blocks
 * joined by a blank line) so a single-chunk transcript renders byte-identical
 * to the pre-chunking whole-document body.
 */

import type { ConversationTurn } from "@agentproto/corpus"

/** Target ceiling per chunk — the "~2-4KB" bound from the retrieval-quality
 *  brief: big enough that BM25 has real context per doc, small enough that a
 *  hit's snippet lands near the matched passage instead of far from it. */
export const DEFAULT_CHUNK_MAX_BYTES = 3500

export interface TranscriptChunk {
  /** 0-based position among this session's chunks. */
  readonly index: number
  readonly turns: readonly ConversationTurn[]
  /** 0-based index of this chunk's first turn in the session's full
   *  (preamble-stripped, non-empty) turn list. */
  readonly turnStart: number
  /** 0-based index of this chunk's last turn (inclusive). */
  readonly turnEnd: number
}

/** Group `turns` into byte-bounded chunks, splitting only between turns. A
 *  single turn larger than `maxBytes` still becomes its own (oversized)
 *  chunk — never split mid-turn. Empty input yields no chunks. */
export function chunkTurns(
  turns: readonly ConversationTurn[],
  maxBytes: number = DEFAULT_CHUNK_MAX_BYTES,
): TranscriptChunk[] {
  const groups: ConversationTurn[][] = []
  let current: ConversationTurn[] = []
  let currentBytes = 0

  for (const turn of turns) {
    const turnBytes = byteLength(renderTurn(turn))
    const joinBytes = current.length > 0 ? 2 : 0 // the "\n\n" that will separate it from the prior turn
    if (current.length > 0 && currentBytes + joinBytes + turnBytes > maxBytes) {
      groups.push(current)
      current = []
      currentBytes = 0
    }
    currentBytes += (current.length > 0 ? 2 : 0) + turnBytes
    current.push(turn)
  }
  if (current.length > 0) groups.push(current)

  let cursor = 0
  return groups.map((group, index) => {
    const turnStart = cursor
    const turnEnd = cursor + group.length - 1
    cursor += group.length
    return { index, turns: group, turnStart, turnEnd }
  })
}

/** The deterministic `KnowledgeIngestInput.uri` for one session's chunk.
 *  Chunk 0 keeps the bare `sessionId` — so a single-chunk session (the
 *  common case) writes to the EXACT path the pre-chunking pipeline used
 *  (`sources/<sessionId>.md`), a free backward-compat win. Reused on
 *  reindex to regenerate old chunk uris for tombstoning (see
 *  `ingest-pipeline.ts`) without needing to record them separately. */
export function chunkUri(sessionId: string, index: number): string {
  return index === 0 ? sessionId : `${sessionId}#${index}`
}

export function renderChunkBody(turns: readonly ConversationTurn[]): string {
  return turns.map(renderTurn).join("\n\n")
}

function renderTurn(turn: ConversationTurn): string {
  return `${labelRole(turn.role)}: ${turn.text.trim()}`
}

function labelRole(role: string): string {
  const r = role.trim()
  if (!r) return "Speaker"
  return r.charAt(0).toUpperCase() + r.slice(1)
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength
}

export interface ChunkMarkdownInput {
  readonly title: string
  readonly sessionId: string
  readonly chunkIndex: number
  readonly chunkCount: number
  readonly turnStart: number
  readonly turnEnd: number
  /** Total non-empty turn count for the WHOLE session (not just this chunk) —
   *  matches the `turnCount` field the pre-chunking pipeline wrote. */
  readonly sessionTurnCount: number
  readonly body: string
}

/** Render one chunk's markdown — frontmatter (parsed by the files adapter's
 *  `parseFrontmatterMetadata`) plus the chunk's own turns. `sessionId` +
 *  `chunkIndex`/`chunkCount`/`turnStart`/`turnEnd` let a query hit on any
 *  chunk still identify the parent session and roughly where in it the hit
 *  landed. */
export function renderChunkMarkdown(input: ChunkMarkdownInput): string {
  const lines = [
    "---",
    `title: ${input.title.replace(/:/g, " -")}`,
    `sessionId: ${input.sessionId}`,
    `slug: ${input.sessionId}`,
    "sourceKind: conversation",
    `chunkIndex: ${input.chunkIndex}`,
    `chunkCount: ${input.chunkCount}`,
    `turnStart: ${input.turnStart}`,
    `turnEnd: ${input.turnEnd}`,
    `turnCount: ${input.sessionTurnCount}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.body,
    "",
  ]
  return lines.join("\n")
}
