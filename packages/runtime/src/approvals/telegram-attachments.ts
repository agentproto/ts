/**
 * Files an approval card attaches on Telegram: `preview.attachments`, a list
 * of file names relative to the folder the approval is about (for the job
 * kit: `cv.pdf`, the capture of the filled form).
 *
 * The preview is written by whoever opened the approval, so every name is
 * untrusted. A name is only ever read when it is a plain relative path with no
 * `..` segment AND its real path (symlinks followed) is still inside the real
 * path of the folder. Anything else, a missing file or one over Telegram's
 * size limits becomes a problem line the card prints: nothing is dropped
 * silently.
 */

import { open, readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, sep, win32 } from "node:path"

import { attachmentNameOf } from "@agentproto/reach"

/** Bot API limits for an upload: 10 MB as a photo, 50 MB as a document. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024
export const MAX_ATTACHMENTS = 10
const MAX_NAME_CHARS = 120
// Telegram scales a photo down to 1280 px on its long side, which makes a
// full-page capture unreadable: past these bounds an image goes as a document.
const MAX_PHOTO_SIDE = 2560
const MAX_PHOTO_RATIO = 3
const PHOTO_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"])

export interface AttachmentFile {
  /** The name as the preview gave it. */
  name: string
  /** Real absolute path, already checked to be inside the folder. */
  path: string
  size: number
  kind: "photo" | "document"
}

export interface AttachmentProblem {
  name: string
  reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
}

/** A name as the card prints it. */
export function shortName(value: string): string {
  return value.length > MAX_NAME_CHARS ? `${value.slice(0, MAX_NAME_CHARS)}...` : value
}

/**
 * The file names of `preview.attachments`. `claimed` is false when the preview
 * has no list of names there (absent, a list of objects with no name, or a
 * mail preview's `[{ fileName, sizeBytes }]`): the key is then left to the card's
 * ordinary rendering and nothing is sent.
 */
export function readAttachmentNames(preview: unknown): {
  claimed: boolean
  names: string[]
  problems: AttachmentProblem[]
} {
  const raw = isRecord(preview) ? preview.attachments : undefined
  // A mail preview's `[{ fileName, sizeBytes }]` is rendered by the card as is.
  const isMail = isRecord(preview) && preview.kind === "mail"
  if (isMail || !Array.isArray(raw) || !raw.some(item => attachmentNameOf(item) !== undefined)) {
    return { claimed: false, names: [], problems: [] }
  }
  const names: string[] = []
  const problems: AttachmentProblem[] = []
  let extra = 0
  for (const item of raw) {
    const name = attachmentNameOf(item)
    if (name === undefined || name.trim() === "") {
      problems.push({ name: "(entry)", reason: "not a file name" })
    } else if (names.includes(name)) {
      continue
    } else if (names.length >= MAX_ATTACHMENTS) {
      extra++
    } else {
      names.push(name)
    }
  }
  if (extra > 0) {
    problems.push({ name: `${extra} more`, reason: `over the limit of ${MAX_ATTACHMENTS} attachments per card` })
  }
  return { claimed: true, names, problems }
}

/** A plain relative path: not absolute (POSIX or Windows), no `..`, no NUL. */
function isSafeRelative(name: string): boolean {
  if (name.includes("\0") || isAbsolute(name) || win32.isAbsolute(name)) return false
  const segments = name.split(/[\\/]+/)
  return !segments.includes("..") && segments.some(s => s !== "" && s !== ".")
}

function isInside(realRoot: string, realTarget: string): boolean {
  return realTarget.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)
}

async function realDir(path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path)
    return (await stat(real)).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

/**
 * The folder an approval's attachments are relative to, inside the data root
 * of the app that opened it: `preview.attachmentsDir` when given, else
 * `preview.dossier`, else the data root itself. A `dossier` that is not a
 * direct child of the data root is looked up one level down (the job kit keeps
 * `<company>/<role>` under `kits/`), and only when exactly one folder matches.
 * Undefined when nothing matches or the folder would leave the data root.
 */
export async function approvalAttachmentDir(preview: unknown, dataRoot: string): Promise<string | undefined> {
  const root = await realDir(dataRoot)
  if (!root) return undefined
  const p = isRecord(preview) ? preview : {}
  const explicit = typeof p.attachmentsDir === "string" ? p.attachmentsDir : undefined
  const rel = explicit ?? (typeof p.dossier === "string" ? p.dossier : undefined)
  if (rel === undefined) return root
  if (!isSafeRelative(rel)) return undefined

  const direct = await realDir(join(root, rel))
  if (direct) return isInside(root, direct) ? direct : undefined
  if (explicit !== undefined) return undefined

  const matches: string[] = []
  let children: string[]
  try {
    children = await readdir(root)
  } catch {
    return undefined
  }
  for (const child of children) {
    if (child.startsWith(".")) continue
    const candidate = await realDir(join(root, child, rel))
    if (candidate && isInside(root, candidate)) matches.push(candidate)
  }
  return matches.length === 1 ? matches[0] : undefined
}

/** Width and height of a PNG, read from its IHDR chunk. */
async function pngSize(path: string): Promise<{ width: number; height: number } | undefined> {
  let handle
  try {
    handle = await open(path, "r")
    const head = Buffer.alloc(24)
    const { bytesRead } = await handle.read(head, 0, 24, 0)
    if (bytesRead < 24 || head.readUInt32BE(0) !== 0x89504e47 || head.toString("latin1", 12, 16) !== "IHDR") {
      return undefined
    }
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function attachmentKind(path: string, name: string, size: number): Promise<"photo" | "document"> {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
  if (!PHOTO_EXTENSIONS.has(ext) || size > MAX_PHOTO_BYTES) return "document"
  const dims = ext === "png" ? await pngSize(path) : undefined
  if (dims) {
    const long = Math.max(dims.width, dims.height)
    const short = Math.max(1, Math.min(dims.width, dims.height))
    if (long > MAX_PHOTO_SIDE || long / short > MAX_PHOTO_RATIO) return "document"
  }
  return "photo"
}

/** Check every name against `dir`. Each name ends up in exactly one list. */
export async function resolveAttachments(
  names: readonly string[],
  dir: string | undefined,
): Promise<{ files: AttachmentFile[]; problems: AttachmentProblem[] }> {
  const files: AttachmentFile[] = []
  const problems: AttachmentProblem[] = []
  const root = dir === undefined ? undefined : await realDir(dir)
  for (const raw of names) {
    const name = shortName(raw)
    if (!isSafeRelative(raw)) {
      problems.push({ name, reason: "refused, the path leaves the approval folder" })
      continue
    }
    if (!root) {
      problems.push({ name, reason: "no folder is known for this approval" })
      continue
    }
    let real: string
    try {
      real = await realpath(join(root, raw))
    } catch {
      problems.push({ name, reason: "file not found" })
      continue
    }
    if (!isInside(root, real)) {
      problems.push({ name, reason: "refused, the path leaves the approval folder" })
      continue
    }
    const info = await stat(real).catch(() => undefined)
    if (!info || !info.isFile()) {
      problems.push({ name, reason: info ? "not a file" : "file not found" })
      continue
    }
    if (info.size === 0) {
      problems.push({ name, reason: "empty file" })
      continue
    }
    if (info.size > MAX_DOCUMENT_BYTES) {
      problems.push({
        name,
        reason: `too large (${humanSize(info.size)}, Telegram limit ${humanSize(MAX_DOCUMENT_BYTES)})`,
      })
      continue
    }
    files.push({ name, path: real, size: info.size, kind: await attachmentKind(real, raw, info.size) })
  }
  return { files, problems }
}
