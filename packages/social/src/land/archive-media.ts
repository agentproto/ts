/**
 * archive-media — walk a footprint and persist every media ref's bytes via the
 * injected MediaArchivePort, filling in `MediaRef.stored`. Pure orchestration:
 * the I/O (download + store) lives behind the port; this just maps records and
 * caps concurrency. Best-effort — a failed archive leaves the ref reference-only.
 */

import type { FootprintRecord, MediaRef, PostRef } from "../model/footprint.js"
import type { MediaArchivePort } from "../ports/media-archive.port.js"

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

async function archiveList(
  media: readonly MediaRef[],
  port: MediaArchivePort,
  limit: number
): Promise<MediaRef[]> {
  return mapLimit(media, limit, async (m) => {
    if (m.stored) return m
    const stored = await port.archive(m).catch(() => null)
    return stored ? { ...m, stored } : m
  })
}

async function archiveRef(
  ref: PostRef,
  port: MediaArchivePort,
  limit: number
): Promise<PostRef> {
  if (!ref.media?.length) return ref
  return { ...ref, media: await archiveList(ref.media, port, limit) }
}

export interface ArchiveMediaOptions {
  /** Max concurrent downloads (default 6). */
  readonly concurrency?: number
}

/**
 * Return a new record list with every media ref's bytes archived (its `stored`
 * descriptor filled in). Covers authored-post media, the quoted post's media,
 * and engagement targets' media.
 */
export async function archiveFootprintMedia(
  records: readonly FootprintRecord[],
  port: MediaArchivePort,
  opts: ArchiveMediaOptions = {}
): Promise<FootprintRecord[]> {
  const limit = opts.concurrency ?? 6
  return mapLimit(records, limit, async (r) => {
    if (r.kind === "post") {
      const media = r.media?.length ? await archiveList(r.media, port, limit) : r.media
      const quoted = r.quoted ? await archiveRef(r.quoted, port, limit) : r.quoted
      return { ...r, ...(media ? { media } : {}), ...(quoted ? { quoted } : {}) }
    }
    if (r.kind === "engagement-given") {
      return { ...r, target: await archiveRef(r.target, port, limit) }
    }
    return r
  })
}
