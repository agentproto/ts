/**
 * PCM16 even-chunk alignment.
 *
 * PCM16 is 2 bytes per sample: every chunk a vendor hands out MUST be
 * even-aligned, or the client's `Int16Array` decode silently drops the
 * trailing byte. Vendors do not promise it, so the kit does: an aligner
 * keeps the odd tail of one chunk and merges it into the next, so no byte
 * is lost and no half-sample ever reaches the caller.
 */
export class Pcm16ChunkAligner {
  private tail: Uint8Array | null = null

  /**
   * Hand one raw chunk in, get the even-aligned part out. The returned view
   * is valid until the next call; it is empty when the chunk was a single
   * dangling byte.
   */
  push(chunk: Uint8Array): Uint8Array {
    if (chunk.byteLength === 0) return chunk
    const merged = this.tail ? concat(this.tail, chunk) : chunk
    const evenLength = merged.byteLength - (merged.byteLength % 2)
    this.tail =
      evenLength < merged.byteLength ? merged.subarray(evenLength) : null
    return merged.subarray(0, evenLength)
  }

  /**
   * End of stream: what is left can only be 0 or 1 byte — a dangling
   * half-sample that is never emitted. Returns the empty view when there
   * is nothing aligned left.
   */
  flush(): Uint8Array {
    const rest = this.tail
    this.tail = null
    if (!rest || rest.byteLength < 2) return new Uint8Array(0)
    return rest.subarray(0, rest.byteLength - (rest.byteLength % 2))
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

/** True when `bytes` can be decoded as PCM16 without losing a byte. */
export function isEvenPcm16(bytes: Uint8Array): boolean {
  return bytes.byteLength % 2 === 0
}
