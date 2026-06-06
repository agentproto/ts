/**
 * MediaArchivePort — persist a media ref's BYTES durably (vs the reference-only
 * default, where `MediaRef.url` rots). The host injects the impl: local-fs for
 * a workstation, a StoragePort/GCS adapter for cloud. Content-addressed by
 * sha256 so the same asset is stored once and the key is stable.
 *
 * Pure kit defines only the contract; `archiveFootprintMedia` (land/) walks a
 * footprint and fills in `MediaRef.stored` via this port.
 */

import type { MediaRef } from "../model/footprint.js"

export type StoredMedia = NonNullable<MediaRef["stored"]>

export interface MediaArchivePort {
  /**
   * Download + persist the bytes for one media ref. Returns the stored
   * descriptor, or null if the fetch/store failed (caller keeps the
   * reference-only ref — archiving is best-effort, never fatal to a capture).
   */
  archive(media: MediaRef): Promise<StoredMedia | null>
}
