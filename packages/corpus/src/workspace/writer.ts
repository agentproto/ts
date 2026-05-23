/**
 * CorpusWorkspaceWriter — atomic file writes with versionToken
 * optimistic-concurrency guard.
 *
 * Every write goes through `writeFile(path, content, expected?)`:
 *   - If `expected` is provided, the writer reads the current file's
 *     content hash and refuses to write if it doesn't match → throws
 *     CorpusVersionConflictError. Caller retries with the fresh
 *     versionToken.
 *   - If `expected` is null, the writer requires the file to NOT
 *     exist (create-only).
 *   - If `expected` is undefined, the writer overwrites unconditionally
 *     (use sparingly — bypasses the concurrency-correctness story).
 *
 * Multi-file transactions (e.g. promote entry + update _index.md +
 * append _log.md) use FsPort.lock on a sentinel path so concurrent
 * promoters serialize cleanly.
 *
 * The writer is the ONLY component allowed to call FsPort.writeFile
 * for workspace content. The reader/validator/linter never write.
 * The event emitter writes only _log.md via append.
 */

import { createHash } from "node:crypto"
import matter from "gray-matter"
import type { FsPort, FsLockHandle } from "../ports/fs.port.js"

export class CorpusVersionConflictError extends Error {
  constructor(
    readonly path: string,
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `CorpusVersionConflictError: ${path} versionToken mismatch — expected ${expected}, found ${actual}. Re-read the file and retry with the fresh token.`
    )
    this.name = "CorpusVersionConflictError"
  }
}

export interface CorpusWorkspaceWriterOptions {
  readonly fs: FsPort
}

/**
 * Frontmatter + body source pair, used by helpers like `writeEntry`
 * that need to serialize the .md back from structured data.
 */
export interface MarkdownDoc {
  readonly frontmatter: Readonly<Record<string, unknown>>
  readonly body: string
}

export class CorpusWorkspaceWriter {
  constructor(private readonly opts: CorpusWorkspaceWriterOptions) {}

  /**
   * Compute the versionToken for raw file content. Exposed so the
   * caller can stage a write and pass the same hash function used
   * inside the writer.
   */
  static versionTokenOf(content: string): string {
    return "sha256:" + createHash("sha256").update(content).digest("hex")
  }

  /**
   * Atomic write with optimistic concurrency check.
   *
   *   - expected === undefined → unconditional overwrite (use sparingly)
   *   - expected === null      → create-only (refuses if exists)
   *   - expected === string    → CAS check (refuses if current hash differs)
   *
   * Returns the new versionToken on success.
   */
  async writeFile(
    path: string,
    content: string,
    expected?: string | null
  ): Promise<string> {
    if (expected === null) {
      if (await this.opts.fs.exists(path)) {
        throw new CorpusVersionConflictError(path, "<must-not-exist>", "<exists>")
      }
    } else if (typeof expected === "string") {
      const existing = await this.opts.fs.exists(path)
      if (!existing) {
        throw new CorpusVersionConflictError(path, expected, "<missing>")
      }
      const current = await this.opts.fs.readFile(path)
      const actual = CorpusWorkspaceWriter.versionTokenOf(current)
      if (actual !== expected) {
        throw new CorpusVersionConflictError(path, expected, actual)
      }
    }
    await this.opts.fs.writeFile(path, content)
    return CorpusWorkspaceWriter.versionTokenOf(content)
  }

  /**
   * Serialize a markdown doc (frontmatter + body) and write atomically.
   * Frontmatter keys are stringified in a stable order so version
   * tokens are deterministic across emitter rebuilds.
   */
  async writeMarkdown(
    path: string,
    doc: MarkdownDoc,
    expected?: string | null
  ): Promise<string> {
    const content = serializeMarkdown(doc)
    return this.writeFile(path, content, expected)
  }

  /**
   * Run `fn` while holding a workspace-scoped lock. Used for
   * multi-file transactions (promote entry + update _index.md + log
   * append). The lock path is host-specific; we default to
   * `_log.md` because it's the file every transaction touches.
   *
   * `lockPath` is workspace-relative.
   */
  async transaction<T>(
    lockPath: string,
    fn: () => Promise<T>
  ): Promise<T> {
    let handle: FsLockHandle | null = null
    try {
      handle = await this.opts.fs.lock(lockPath)
      return await fn()
    } finally {
      if (handle) await handle.release()
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Serialize a MarkdownDoc back to `--- frontmatter --- body` form.
 * gray-matter's `stringify` does this; we wrap it for the deterministic
 * key-order convention.
 */
function serializeMarkdown(doc: MarkdownDoc): string {
  // gray-matter.stringify takes (content, data) — body first, then
  // frontmatter object.
  return matter.stringify(doc.body.startsWith("\n") ? doc.body : "\n" + doc.body, doc.frontmatter)
}
