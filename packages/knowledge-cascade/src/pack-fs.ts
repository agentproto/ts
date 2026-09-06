/**
 * packFs — mount a pack directory as a read-only `FsPort` layer.
 *
 * A "pack" is a plain file tree (typically `<root>/entries/**`) shipped
 * read-only: a global default, a shared house style, an app-bundled corpus.
 * `packFs` wraps a `DiskFs` rooted at that directory in `ReadOnlyFs`, so a
 * misconfigured caller can never write into shared content — edits belong
 * in an override layer (see `mountCascade`).
 */

import { ReadOnlyFs, type FsPort } from "@agentproto/corpus"
import { DiskFs } from "./disk-fs.js"

export interface PackFsOptions {
  /** Absolute path to the pack directory (its root, not `entries/` itself). */
  readonly root: string
}

export function packFs(opts: PackFsOptions): FsPort {
  return new ReadOnlyFs(new DiskFs({ root: opts.root }))
}
