/**
 * Catalog served by the MCP Skills extension (`io.modelcontextprotocol/skills`, beta).
 *
 * v1 source of truth: the imported-skills registry (`skill-imports.ts`) ONLY.
 * Application skills (AIP-53) and "installed packs" are not served. The URI of
 * a skill is built on its frontmatter `name` (the registry `id`), never on the
 * display `alias`.
 *
 * Files are read from the durable copy under the registry root, not from the
 * original source folder, so a file edited outside the registry does not change
 * a served digest until `skill_resync` re-copies it.
 *
 * Confinement: every candidate path is normalized, matched against the
 * manifest, then its real path is checked to stay inside the skill folder
 * BEFORE any byte is read. A symlink leaving the folder is neither listed nor
 * readable.
 *
 * Digests are `sha256:<hex>` over the RAW bytes. They are not a trust anchor
 * (unsigned, same server): they let a client detect drift.
 */

import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { extname, join, relative, sep } from "node:path"
import matter from "gray-matter"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  registerSkillsMethods,
  type SkillFileContent,
  type SkillsMethodsHandlers,
} from "@agentproto/mcp-server"
import {
  IMPORTED_SKILLS_PATH,
  IMPORTED_SKILLS_ROOT,
  SKILL_FILE,
  loadImportedSkills,
  skillImportDir,
  type ImportedSkillEntry,
} from "../skill-imports.js"

/** Per-skill ceilings. Above them the skill is not served and the error says so. */
export const SKILLS_MAX_FILES = 512
export const SKILLS_MAX_BYTES = 16 * 1024 * 1024
export const SKILLS_DEFAULT_PAGE_SIZE = 50

export interface SkillResource {
  uri: string
  digest: string
  size: number
}

export interface ServedSkillView {
  uri: string
  frontmatter: { name: string; description: string; [key: string]: unknown }
  resources: SkillResource[]
}

export interface SkillsCatalogOptions {
  /** Registry file (default `~/.agentproto/imported-skills.json`). */
  registryPath?: string
  /** Root of the copied trees (default `~/.agentproto/skills`). */
  root?: string
  pageSize?: number
  maxFiles?: number
  maxBytes?: number
}

interface FileRecord {
  rel: string
  abs: string
  size: number
  mtimeMs: number
  digest: string
}

type Resolved =
  | { ok: true; id: string; dir: string; realDir: string; view: ServedSkillView; files: Map<string, FileRecord>; fingerprint: string }
  | { ok: false; id: string; reason: string }

const invalidParams = (message: string): McpError => new McpError(ErrorCode.InvalidParams, message)

const skillUri = (name: string, rel: string): string =>
  `skill://${name}/${rel.split("/").map(encodeURIComponent).join("/")}`

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel))
}

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
}

function mimeFor(rel: string, isText: boolean): string {
  return MIME[extname(rel).toLowerCase()] ?? (isText ? "text/plain" : "application/octet-stream")
}

const sha256 = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

function decodeUtf8(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** Split `skill://<name>/<path>` by hand (no URL normalization) into a skill name and decoded path segments. */
function parseSkillUri(raw: string): { name: string; segments: string[] } {
  const match = /^skill:\/\/([^/?#]+)\/([^?#]+)$/.exec(raw)
  if (!match) throw invalidParams(`not a served skill URI: ${raw}`)
  const segments: string[] = []
  for (const part of match[2]!.split("/")) {
    let decoded: string
    try {
      decoded = decodeURIComponent(part)
    } catch {
      throw invalidParams("malformed percent-encoding in skill URI")
    }
    if (decoded === "" || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
      throw invalidParams("skill URI path is not allowed")
    }
    segments.push(decoded)
  }
  return { name: match[1]!, segments }
}

export interface SkillsCatalog extends SkillsMethodsHandlers {
  /** The skills that cannot be served, and why (not listed; `skills/get` reports the reason). */
  unservable(): Promise<Array<{ id: string; reason: string }>>
}

export function createSkillsCatalog(options: SkillsCatalogOptions = {}): SkillsCatalog {
  const registryPath = options.registryPath ?? IMPORTED_SKILLS_PATH()
  const root = options.root ?? IMPORTED_SKILLS_ROOT()
  const pageSize = options.pageSize ?? SKILLS_DEFAULT_PAGE_SIZE
  const maxFiles = options.maxFiles ?? SKILLS_MAX_FILES
  const maxBytes = options.maxBytes ?? SKILLS_MAX_BYTES
  /** id -> last resolved skill; reused while the registry sha and every (path, size, mtime) are unchanged. */
  const cache = new Map<string, Extract<Resolved, { ok: true }>>()

  async function walk(realDir: string): Promise<{ files: Array<{ rel: string; abs: string; size: number; mtimeMs: number }> } | { tooLarge: string }> {
    const files: Array<{ rel: string; abs: string; size: number; mtimeMs: number }> = []
    const visited = new Set<string>()
    let total = 0
    const visit = async (abs: string): Promise<string | undefined> => {
      const real = await fs.realpath(abs)
      if (visited.has(real)) return undefined
      visited.add(real)
      const entries = await fs.readdir(abs, { withFileTypes: true })
      for (const entry of entries) {
        const child = join(abs, entry.name)
        let real2: string
        try {
          real2 = await fs.realpath(child)
        } catch {
          continue
        }
        if (!contains(realDir, real2)) continue // a link leaving the folder: neither listed nor readable
        const info = await fs.stat(real2)
        if (info.isDirectory()) {
          const failure = await visit(child)
          if (failure) return failure
        } else if (info.isFile()) {
          files.push({ rel: relative(realDir, child).split(sep).join("/"), abs: child, size: info.size, mtimeMs: info.mtimeMs })
          total += info.size
          if (files.length > maxFiles) return `more than ${maxFiles} files`
          if (total > maxBytes) return `more than ${maxBytes} bytes`
        }
      }
      return undefined
    }
    const failure = await visit(realDir)
    return failure ? { tooLarge: failure } : { files }
  }

  async function resolveEntry(entry: ImportedSkillEntry): Promise<Resolved> {
    const dir = skillImportDir(entry.id, root)
    let realDir: string
    try {
      realDir = await fs.realpath(dir)
    } catch {
      return { ok: false, id: entry.id, reason: "skill folder is missing" }
    }
    const listing = await walk(realDir)
    if ("tooLarge" in listing) {
      return { ok: false, id: entry.id, reason: `skill is not served: ${listing.tooLarge} (limits: ${maxFiles} files, ${maxBytes} bytes)` }
    }
    const files = [...listing.files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    const fingerprint = `${entry.sha}|${files.map(f => `${f.rel}:${f.size}:${f.mtimeMs}`).join("|")}`
    const cached = cache.get(entry.id)
    if (cached && cached.fingerprint === fingerprint) return cached

    if (!files.some(f => f.rel === SKILL_FILE)) return { ok: false, id: entry.id, reason: `${SKILL_FILE} is missing` }
    const records = new Map<string, FileRecord>()
    let skillText = ""
    for (const f of files) {
      const bytes = await fs.readFile(f.abs)
      if (f.rel === SKILL_FILE) skillText = bytes.toString("utf8")
      records.set(f.rel, { ...f, size: bytes.length, digest: sha256(bytes) })
    }
    let data: Record<string, unknown>
    try {
      // matter() caches by content; a copy keeps the cached object untouched.
      data = JSON.parse(JSON.stringify(matter(skillText).data)) as Record<string, unknown>
    } catch {
      return { ok: false, id: entry.id, reason: `${SKILL_FILE} frontmatter is not valid YAML` }
    }
    if (data.name !== entry.id || typeof data.description !== "string" || data.description === "") {
      return { ok: false, id: entry.id, reason: `${SKILL_FILE} frontmatter name/description do not match the registry entry` }
    }
    const view: ServedSkillView = {
      uri: skillUri(entry.id, SKILL_FILE),
      frontmatter: data as ServedSkillView["frontmatter"],
      resources: [...records.values()].map(r => ({ uri: skillUri(entry.id, r.rel), digest: r.digest, size: r.size })),
    }
    const resolved: Resolved = { ok: true, id: entry.id, dir, realDir, view, files: records, fingerprint }
    cache.set(entry.id, resolved)
    return resolved
  }

  /** Every registry entry, resolved. A repeated id (hand-edited registry) is served once: the first wins. */
  async function resolveAll(): Promise<Resolved[]> {
    const config = await loadImportedSkills(registryPath)
    const seen = new Set<string>()
    const out: Resolved[] = []
    for (const entry of config.imports) {
      if (seen.has(entry.id)) {
        out.push({ ok: false, id: entry.id, reason: "duplicate skill name: the first entry with this name is served" })
        continue
      }
      seen.add(entry.id)
      out.push(await resolveEntry(entry))
    }
    return out
  }

  async function resolveByName(name: string): Promise<Extract<Resolved, { ok: true }>> {
    const config = await loadImportedSkills(registryPath)
    const entry = config.imports.find(e => e.id === name)
    if (!entry) throw invalidParams(`unknown skill: ${name}`)
    const resolved = await resolveEntry(entry)
    if (!resolved.ok) throw invalidParams(`skill ${name} is not served: ${resolved.reason}`)
    return resolved
  }

  async function readFile(skill: Extract<Resolved, { ok: true }>, rel: string): Promise<FileRecord & { bytes: Buffer }> {
    const record = skill.files.get(rel)
    if (!record) throw invalidParams("file is not listed in the skill manifest")
    // Real-path check BEFORE reading.
    let real: string
    try {
      real = await fs.realpath(record.abs)
    } catch {
      throw invalidParams("file is not available")
    }
    if (!contains(skill.realDir, real)) throw invalidParams("file is outside the skill folder")
    const bytes = await fs.readFile(real)
    return { ...record, bytes }
  }

  return {
    async list(params) {
      const cursor = params.cursor
      let offset = 0
      if (cursor !== undefined) {
        if (typeof cursor !== "string") throw invalidParams("cursor must be a string")
        try {
          const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }
          if (typeof decoded.o !== "number" || !Number.isInteger(decoded.o) || decoded.o < 0) throw new Error("bad")
          offset = decoded.o
        } catch {
          throw invalidParams("invalid cursor")
        }
      }
      const served = (await resolveAll()).filter((r): r is Extract<Resolved, { ok: true }> => r.ok)
      const page = served.slice(offset, offset + pageSize)
      const next = offset + pageSize
      return {
        skills: page.map(s => s.view),
        ...(next < served.length ? { nextCursor: Buffer.from(JSON.stringify({ o: next })).toString("base64url") } : {}),
      }
    },

    async get(params) {
      if (typeof params.uri !== "string") throw invalidParams("uri is required")
      const { name, segments } = parseSkillUri(params.uri)
      if (segments.length !== 1 || segments[0] !== SKILL_FILE) throw invalidParams(`skills/get takes skill://<name>/${SKILL_FILE}`)
      const skill = await resolveByName(name)
      return { skill: skill.view }
    },

    async read(uri: URL): Promise<SkillFileContent> {
      const { name, segments } = parseSkillUri(uri.href)
      const skill = await resolveByName(name)
      const rel = segments.join("/")
      let file = await readFile(skill, rel)
      if (sha256(file.bytes) !== file.digest) {
        // Changed on disk since the manifest was built: rebuild once, then serve what the new manifest says.
        cache.delete(name)
        const fresh = await resolveByName(name)
        file = await readFile(fresh, rel)
        if (sha256(file.bytes) !== file.digest) throw new McpError(ErrorCode.InternalError, "file changed while being read")
      }
      const text = decodeUtf8(file.bytes)
      const outUri = skillUri(name, rel)
      return text !== undefined
        ? { uri: outUri, mimeType: mimeFor(rel, true), text }
        : { uri: outUri, mimeType: mimeFor(rel, false), blob: file.bytes.toString("base64") }
    },

    async unservable() {
      return (await resolveAll()).filter((r): r is Extract<Resolved, { ok: false }> => !r.ok).map(r => ({ id: r.id, reason: r.reason }))
    },
  }
}

/** Mount the extension on one per-request server. */
export function registerServedSkills(server: McpServer, options: SkillsCatalogOptions = {}): SkillsCatalog {
  const catalog = createSkillsCatalog(options)
  registerSkillsMethods(server, catalog)
  return catalog
}
