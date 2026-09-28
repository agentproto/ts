/**
 * Session-scoped artifact store — durable, content-addressed documents
 * (image, pdf, html, presentation, site, generic file) attached to an
 * agent-cli session, kept across restarts and browsable in the session's
 * "Artifacts" section, distinct from the ephemeral inline card a chat
 * message renders.
 *
 * Deliberately mirrors `transcript-writer.ts`'s `AttachmentEntry`, which
 * itself mirrors AIP-58's `ArtifactEntry` (`packages/workflow-runtime/src/
 * types.ts`) field-for-field — `key`/`path`/`sha256`/`size`/`contentType` —
 * so promoting an attachment to an artifact is a metadata copy, never a
 * data migration. What this module adds on top of a bare `ArtifactEntry`
 * is the session-artifact-specific envelope AIP-58 has no notion of:
 * `kind`, `label`, `pinned`, `createdBy`, `sourceRef`, and version history
 * under one stable `key`.
 *
 * Storage layout, under `sessionTranscriptDir(sessionId)`:
 *
 *   artifacts/<sha256>.<ext>      — one file per single-file version
 *   artifacts/<sha256>/           — one directory per "site" version
 *   artifacts.jsonl               — append-only ledger, one JSON line per
 *                                    mutation (`artifact.added` |
 *                                    `artifact.pinned`)
 *
 * The ledger is the single source of truth, same posture AIP-58 §5 takes
 * for its run event log: `listSessionArtifacts`/`getSessionArtifact` are
 * folds over it, never a second store that could disagree with it. A
 * `key`'s version history is append-only; nothing here ever rewrites a
 * prior version's file or ledger line.
 */

import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path"
import { sessionTranscriptDir } from "./transcript-writer.js"

export type ArtifactKind = "image" | "document" | "pdf" | "html" | "presentation" | "site" | "file"

export type ArtifactCreator = "agent" | "user"

export interface ArtifactVersionEntry {
  version: number
  /** Content hash — sha256 of the file's bytes for a single-file version,
   *  or a manifest hash (sorted relative paths + sizes) for a "site"
   *  directory version. Not a cryptographic content-integrity guarantee
   *  for the directory case, only a stable change-detection key. */
  sha256: string
  /** Relative to `sessionTranscriptDir(sessionId)` — `"artifacts/<sha>.<ext>"`
   *  for a single file, `"artifacts/<sha>"` (a directory) for a site. */
  path: string
  /** True when `path` names a directory (a "site"). */
  isDirectory: boolean
  size: number
  contentType?: string
  createdAt: string
  createdBy: ArtifactCreator
  sourceRef?: string
}

export interface ArtifactRecord {
  key: string
  kind: ArtifactKind
  label?: string
  pinned: boolean
  updatedAt: string
  versions: ArtifactVersionEntry[]
}

interface ArtifactAddedLogEntry {
  seq: number
  ts: string
  type: "artifact.added"
  key: string
  kind: ArtifactKind
  label?: string
  version: number
  sha256: string
  path: string
  isDirectory: boolean
  size: number
  contentType?: string
  createdBy: ArtifactCreator
  sourceRef?: string
}

interface ArtifactPinnedLogEntry {
  seq: number
  ts: string
  type: "artifact.pinned"
  key: string
  pinned: boolean
}

type ArtifactLogEntry = ArtifactAddedLogEntry | ArtifactPinnedLogEntry

export function sessionArtifactsDir(sessionId: string, baseDir?: string): string {
  return join(sessionTranscriptDir(sessionId, baseDir), "artifacts")
}

export function sessionArtifactsLogPath(sessionId: string, baseDir?: string): string {
  return join(sessionTranscriptDir(sessionId, baseDir), "artifacts.jsonl")
}

function readLogEntries(sessionId: string, baseDir?: string): ArtifactLogEntry[] {
  let raw: string
  try {
    raw = readFileSync(sessionArtifactsLogPath(sessionId, baseDir), "utf8")
  } catch {
    return []
  }
  const entries: ArtifactLogEntry[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as ArtifactLogEntry)
    } catch {
      // Ignore a torn final line (partial write mid-crash) — same tolerance
      // `transcript-writer.ts`'s `highestSeqOnDisk` applies to events.jsonl.
    }
  }
  return entries
}

function appendLogEntry<T extends ArtifactLogEntry>(sessionId: string, entry: Omit<T, "seq">, baseDir?: string): T {
  const dir = sessionTranscriptDir(sessionId, baseDir)
  mkdirSync(dir, { recursive: true })
  const path = sessionArtifactsLogPath(sessionId, baseDir)
  const existing = readLogEntries(sessionId, baseDir)
  const nextSeq = existing.reduce((max, e) => Math.max(max, e.seq), 0) + 1
  const full = { ...entry, seq: nextSeq } as T
  writeFileSync(path, `${JSON.stringify(full)}\n`, { flag: "a" })
  return full
}

/** Fold the ledger into current-state records, most-recently-updated first.
 *  Sorts by the entry's ledger `seq` (monotonic, unique), never by
 *  `updatedAt`'s ISO string alone — two mutations in the same millisecond
 *  carry an identical timestamp, which would make that comparison a tie. */
export function foldArtifactLog(entries: ArtifactLogEntry[]): ArtifactRecord[] {
  const byKey = new Map<string, ArtifactRecord>()
  const lastSeqByKey = new Map<string, number>()
  for (const entry of entries) {
    lastSeqByKey.set(entry.key, entry.seq)
    if (entry.type === "artifact.added") {
      const existing = byKey.get(entry.key)
      const version: ArtifactVersionEntry = {
        version: entry.version,
        sha256: entry.sha256,
        path: entry.path,
        isDirectory: entry.isDirectory,
        size: entry.size,
        ...(entry.contentType ? { contentType: entry.contentType } : {}),
        createdAt: entry.ts,
        createdBy: entry.createdBy,
        ...(entry.sourceRef ? { sourceRef: entry.sourceRef } : {}),
      }
      if (existing) {
        existing.versions.push(version)
        existing.kind = entry.kind
        if (entry.label !== undefined) existing.label = entry.label
        existing.updatedAt = entry.ts
      } else {
        byKey.set(entry.key, {
          key: entry.key,
          kind: entry.kind,
          ...(entry.label ? { label: entry.label } : {}),
          pinned: false,
          updatedAt: entry.ts,
          versions: [version],
        })
      }
    } else if (entry.type === "artifact.pinned") {
      const existing = byKey.get(entry.key)
      if (existing) {
        existing.pinned = entry.pinned
        existing.updatedAt = entry.ts
      }
    }
  }
  return [...byKey.values()].sort((a, b) => (lastSeqByKey.get(b.key) ?? 0) - (lastSeqByKey.get(a.key) ?? 0))
}

export function listSessionArtifacts(sessionId: string, baseDir?: string): ArtifactRecord[] {
  return foldArtifactLog(readLogEntries(sessionId, baseDir))
}

function findRecord(sessionId: string, key: string, baseDir?: string): ArtifactRecord | undefined {
  return listSessionArtifacts(sessionId, baseDir).find(r => r.key === key)
}

/** Extensions this store writes on disk, by mime type — deliberately a
 *  superset of `transcript-writer.ts`'s attachment table since artifacts
 *  cover presentation/site kinds attachments never see. Unknown mime types
 *  fall back to a name-derived extension, then `bin`. */
const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "application/json": "json",
  "text/html": "html",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-powerpoint": "ppt",
}

function extensionFor(mimeType: string | undefined, name: string | undefined): string {
  const dot = name?.lastIndexOf(".") ?? -1
  if (name && dot > 0 && dot < name.length - 1) {
    return name.slice(dot + 1).toLowerCase().slice(0, 10)
  }
  if (mimeType && EXTENSION_BY_MIME_TYPE[mimeType]) return EXTENSION_BY_MIME_TYPE[mimeType]
  return "bin"
}

function inferKind(ext: string, mimeType: string | undefined): ArtifactKind {
  if (mimeType?.startsWith("image/")) return "image"
  if (mimeType === "application/pdf" || ext === "pdf") return "pdf"
  if (mimeType === "text/html" || ext === "html" || ext === "htm") return "html"
  if (
    ext === "pptx" ||
    ext === "ppt" ||
    ext === "key" ||
    mimeType?.includes("presentation")
  ) {
    return "presentation"
  }
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext)) return "image"
  if (["md", "txt", "csv", "json", "docx", "doc"].includes(ext)) return "document"
  return "file"
}

function sanitizeKey(name: string): string {
  const base = name.replace(/\.[^./]+$/, "").trim()
  const slug = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return slug || "artifact"
}

/** sha256 of a directory tree's manifest (sorted relative path + size),
 *  NOT of file bytes — cheap change detection for a "site" directory
 *  version, not a content-integrity guarantee (see `ArtifactVersionEntry.
 *  sha256`'s doc). */
function hashDirectory(dir: string): string {
  const manifest: string[] = []
  const walk = (rel: string): void => {
    const abs = join(dir, rel)
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(childRel)
      } else if (entry.isFile()) {
        const size = statSync(join(abs, entry.name)).size
        manifest.push(`${childRel}:${size}`)
      }
    }
  }
  walk("")
  return createHash("sha256").update(manifest.join("\n")).digest("hex")
}

export interface AddSessionArtifactInput {
  /** Stable id this version is filed under. Versions accrue when the same
   *  key is added again with different content. Defaults to a slug of
   *  `name`, else the content hash. */
  key?: string
  kind?: ArtifactKind
  label?: string
  createdBy: ArtifactCreator
  /** e.g. `"attachment:attachments/<sha>.<ext>"`, `"workflow-run:<runId>/
   *  <artifactKey>"`, `"canvakit:<exportPath>"` — free-form provenance. */
  sourceRef?: string
  /** Inline content, base64-encoded. Mutually exclusive with `sourcePath`. */
  bytes?: string
  /** Display name — also the default `key`/extension source. */
  name?: string
  mimeType?: string
  /** Absolute path to an existing file or directory (e.g. a canvakit
   *  export) to copy into the store. A directory implies `kind: "site"`
   *  unless overridden. Mutually exclusive with `bytes`. */
  sourcePath?: string
}

export interface AddSessionArtifactResult {
  record: ArtifactRecord
  version: ArtifactVersionEntry
  /** False when the call deduped against an identical latest version
   *  (same key, same content hash) — no new version was written. */
  added: boolean
}

/**
 * Materialize a new artifact (or version of one) into the session's store
 * and append the `artifact.added` ledger entry. Deduplicates against an
 * unchanged latest version of the same `key` — re-adding identical bytes
 * (a retry, an unmodified re-export) never bloats the version history.
 */
export function addSessionArtifact(
  sessionId: string,
  input: AddSessionArtifactInput,
  baseDir?: string,
): AddSessionArtifactResult {
  if (!input.bytes && !input.sourcePath) {
    throw new Error("addSessionArtifact: one of `bytes` or `sourcePath` is required")
  }
  if (input.bytes && input.sourcePath) {
    throw new Error("addSessionArtifact: `bytes` and `sourcePath` are mutually exclusive")
  }
  const dir = sessionArtifactsDir(sessionId, baseDir)
  mkdirSync(dir, { recursive: true })

  let sha256: string
  let relPath: string
  let isDirectory: boolean
  let size: number
  let contentType: string | undefined
  let inferredKindSeed: string

  if (input.sourcePath) {
    if (!isAbsolute(input.sourcePath)) {
      throw new Error("addSessionArtifact: `sourcePath` must be an absolute path")
    }
    const st = statSync(input.sourcePath)
    if (st.isDirectory()) {
      isDirectory = true
      // Two-pass: hash the source tree first (stable regardless of target
      // dir name), copy only once into the content-addressed destination.
      sha256 = hashDirectory(input.sourcePath)
      relPath = join("artifacts", sha256)
      const target = join(dir, sha256)
      if (!existsSync(target)) cpSync(input.sourcePath, target, { recursive: true })
      size = 0
      inferredKindSeed = "site"
      contentType = undefined
    } else {
      const bytes = readFileSync(input.sourcePath)
      sha256 = createHash("sha256").update(bytes).digest("hex")
      const ext = extensionFor(input.mimeType, input.name ?? input.sourcePath)
      const filename = `${sha256}.${ext}`
      relPath = join("artifacts", filename)
      const target = join(dir, filename)
      if (!existsSync(target)) writeFileSync(target, bytes)
      isDirectory = false
      size = bytes.length
      contentType = input.mimeType
      inferredKindSeed = ext
    }
  } else {
    const bytes = Buffer.from(input.bytes!, "base64")
    sha256 = createHash("sha256").update(bytes).digest("hex")
    const ext = extensionFor(input.mimeType, input.name)
    const filename = `${sha256}.${ext}`
    relPath = join("artifacts", filename)
    const target = join(dir, filename)
    if (!existsSync(target)) writeFileSync(target, bytes)
    isDirectory = false
    size = bytes.length
    contentType = input.mimeType
    inferredKindSeed = ext
  }

  const kind: ArtifactKind = input.kind ?? (isDirectory ? "site" : inferKind(inferredKindSeed, input.mimeType))
  const key = input.key?.trim() || (input.name ? sanitizeKey(input.name) : sha256)

  const existing = findRecord(sessionId, key, baseDir)
  const latest = existing?.versions[existing.versions.length - 1]
  if (latest && latest.sha256 === sha256) {
    return { record: existing!, version: latest, added: false }
  }

  const version = (latest?.version ?? 0) + 1
  const entry = appendLogEntry<ArtifactAddedLogEntry>(
    sessionId,
    {
      ts: new Date().toISOString(),
      type: "artifact.added",
      key,
      kind,
      ...(input.label ? { label: input.label } : {}),
      version,
      sha256,
      path: relPath,
      isDirectory,
      size,
      ...(contentType ? { contentType } : {}),
      createdBy: input.createdBy,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    },
    baseDir,
  )
  const record = findRecord(sessionId, key, baseDir)!
  const versionEntry = record.versions[record.versions.length - 1]!
  void entry
  return { record, version: versionEntry, added: true }
}

export function pinSessionArtifact(
  sessionId: string,
  key: string,
  pinned: boolean,
  baseDir?: string,
): ArtifactRecord | undefined {
  if (!findRecord(sessionId, key, baseDir)) return undefined
  appendLogEntry<ArtifactPinnedLogEntry>(
    sessionId,
    { ts: new Date().toISOString(), type: "artifact.pinned", key, pinned },
    baseDir,
  )
  return findRecord(sessionId, key, baseDir)
}

export interface GetSessionArtifactResult {
  record: ArtifactRecord
  version: ArtifactVersionEntry
  /** Absent for a "site" (directory) version — browse it via the raw-serve
   *  route instead; nothing here bounds a whole directory's bytes. */
  content?: Buffer
  truncated: boolean
}

const DEFAULT_MAX_READ_BYTES = 512 * 1024

/** Fetch one artifact version's metadata plus its bounded file content
 *  (single-file kinds only). Mirrors `workflow-runner.ts`'s
 *  `readArtifact` cap/truncation shape so `session_artifact_get` and
 *  `workflow_artifact_get` read the same to a caller. */
export function getSessionArtifact(
  sessionId: string,
  key: string,
  opts: { version?: number; maxBytes?: number } = {},
  baseDir?: string,
): GetSessionArtifactResult | undefined {
  const record = findRecord(sessionId, key, baseDir)
  if (!record) return undefined
  const version = opts.version !== undefined ? record.versions.find(v => v.version === opts.version) : record.versions[record.versions.length - 1]
  if (!version) return undefined
  if (version.isDirectory) {
    return { record, version, truncated: false }
  }
  const abs = resolveArtifactPath(sessionId, version, baseDir)
  if (!abs) return { record, version, truncated: false }
  const full = readFileSync(abs)
  const cap = opts.maxBytes ?? DEFAULT_MAX_READ_BYTES
  const truncated = full.length > cap
  return { record, version, content: truncated ? full.subarray(0, cap) : full, truncated }
}

/** Absolute path to a version's file/directory root, containment-checked
 *  against the session's own artifacts dir — never trusts `version.path`
 *  to be safe on its own (defense in depth; every path in it is host-
 *  generated today, but a future caller-supplied `path` must not become a
 *  traversal vector by omission). Returns undefined when it would escape. */
export function resolveArtifactPath(sessionId: string, version: ArtifactVersionEntry, baseDir?: string): string | undefined {
  const root = sessionTranscriptDir(sessionId, baseDir)
  const abs = resolvePath(root, version.path)
  const rootResolved = resolvePath(root)
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) return undefined
  return abs
}

/** Resolve a sub-path inside a "site" version's directory for the raw-serve
 *  route (`GET /sessions/:id/artifacts/:key/raw/*`). Empty `subPath`
 *  defaults to `index.html`. Rejects any resolution that escapes the
 *  version's own directory (`..`, an absolute path smuggled in). */
export function resolveSiteFile(
  sessionId: string,
  version: ArtifactVersionEntry,
  subPath: string,
  baseDir?: string,
): string | undefined {
  if (!version.isDirectory) return undefined
  const dirAbs = resolveArtifactPath(sessionId, version, baseDir)
  if (!dirAbs) return undefined
  const cleaned = subPath.trim() || "index.html"
  const target = resolvePath(dirAbs, cleaned)
  if (target !== dirAbs && !target.startsWith(dirAbs + sep)) return undefined
  if (relative(dirAbs, target).startsWith("..")) return undefined
  return target
}
