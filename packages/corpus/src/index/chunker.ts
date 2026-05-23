/**
 * Chunking strategy for corpus entries.
 *
 * Split an entry body into chunks that fit the backing engine's
 * `maxChunkBytes` capability. Naive but predictable — overlap window
 * keeps semantic continuity across boundaries; smarter sentence /
 * semantic chunking can land later behind the same call.
 *
 * Matches the qdrant adapter's CHUNK_TARGET_CHARS / CHUNK_OVERLAP_CHARS
 * numerology so corpus + qdrant agree on chunk shape end-to-end.
 */

export interface ChunkerOptions {
  /** Soft target per chunk (characters). Default 1500 ≈ 375 tokens. */
  readonly targetChars?: number
  /** Overlap window between adjacent chunks. Default 150. */
  readonly overlapChars?: number
  /** Hard ceiling — backing engine's maxChunkBytes (Buffer-byte). */
  readonly maxBytes?: number
}

const DEFAULT_TARGET = 1500
const DEFAULT_OVERLAP = 150
const DEFAULT_MAX_BYTES = 64 * 1024

export function chunkText(text: string, opts: ChunkerOptions = {}): string[] {
  const target = opts.targetChars ?? DEFAULT_TARGET
  const overlap = opts.overlapChars ?? DEFAULT_OVERLAP
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  if (overlap >= target) {
    throw new Error("chunkText: overlap must be < target")
  }

  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  if (byteLength(trimmed) <= maxBytes && trimmed.length <= target) {
    return [trimmed]
  }

  const chunks: string[] = []
  let cursor = 0
  while (cursor < trimmed.length) {
    let end = Math.min(cursor + target, trimmed.length)
    let slice = trimmed.slice(cursor, end)
    // If the slice exceeds the hard byte ceiling, bisect by char
    // until it fits. Pessimistic but correct for multibyte runs.
    while (byteLength(slice) > maxBytes && slice.length > 1) {
      end = cursor + Math.floor((end - cursor) * 0.9)
      slice = trimmed.slice(cursor, end)
    }
    chunks.push(slice)
    if (end >= trimmed.length) break
    cursor = end - overlap
    if (cursor < 0) cursor = 0
  }
  return chunks
}

function byteLength(s: string): number {
  // TextEncoder is built-in across Node ≥18, Bun, browsers.
  return new TextEncoder().encode(s).length
}
