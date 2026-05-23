/**
 * LocalFilesImporter — reads .md files from a configured FsPort path
 * and yields them as ImportedSource. Reference implementation that
 * proves the importer surface end-to-end without external SDKs.
 *
 * Config (target.config):
 *   - rootPath: string             — workspace-relative path to scan
 *   - extensions?: string[]        — defaults to [".md"]
 *   - maxFiles?: number            — defaults to 1000
 *   - tags?: string[]              — applied to every imported source
 *   - language?: string            — applied to every source (BCP-47)
 *
 * Pure kit code — consumes FsPort, no node:fs / no network.
 *
 * Slug derivation: filename without extension, lowercased + slug-safed.
 * Content hash: sha256 of UTF-8 body bytes.
 */

import { createHash } from "node:crypto"
import type { FsPort } from "../ports/fs.port.js"
import type {
  CorpusImporter,
  ImportedSource,
  ImporterTarget,
} from "./types.js"

export interface LocalFilesImporterOptions {
  readonly fs: FsPort
}

interface LocalFilesConfig {
  readonly rootPath: string
  readonly extensions?: readonly string[]
  readonly maxFiles?: number
  readonly tags?: readonly string[]
  readonly language?: string
}

export class LocalFilesImporter implements CorpusImporter {
  readonly id = "local-files"
  readonly label = "Local Files"

  constructor(private readonly opts: LocalFilesImporterOptions) {}

  async *enumerate(target: ImporterTarget): AsyncIterable<ImportedSource> {
    const config = parseConfig(target.config)
    const exts = new Set(config.extensions ?? [".md"])
    const maxFiles = config.maxFiles ?? 1000
    const paths = await this.opts.fs.walk(config.rootPath)
    let yielded = 0
    for (const p of paths) {
      if (yielded >= maxFiles) break
      const ext = pickExt(p)
      if (!exts.has(ext)) continue
      const body = await this.opts.fs.readFile(p)
      const slug = makeSlug(p, config.rootPath)
      const contentHash = sha256(body)
      const title = readTitleFromBody(body, slug)
      yield {
        slug,
        title,
        contentHash,
        body,
        authority: "secondary",
        ...(config.language ? { language: config.language } : {}),
        ...(config.tags && config.tags.length > 0 ? { tags: config.tags } : {}),
        corpusMetadata: {
          importerSourcePath: p,
          importerRoot: config.rootPath,
        },
      }
      yielded++
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseConfig(raw: Readonly<Record<string, unknown>>): LocalFilesConfig {
  if (typeof raw.rootPath !== "string") {
    throw new Error(
      `LocalFilesImporter: config.rootPath is required (string)`
    )
  }
  const cfg: LocalFilesConfig = {
    rootPath: raw.rootPath,
    extensions: Array.isArray(raw.extensions)
      ? (raw.extensions as unknown[]).filter(
          (x): x is string => typeof x === "string"
        )
      : undefined,
    maxFiles: typeof raw.maxFiles === "number" ? raw.maxFiles : undefined,
    tags: Array.isArray(raw.tags)
      ? (raw.tags as unknown[]).filter(
          (x): x is string => typeof x === "string"
        )
      : undefined,
    language: typeof raw.language === "string" ? raw.language : undefined,
  }
  return cfg
}

function pickExt(path: string): string {
  const i = path.lastIndexOf(".")
  if (i < 0) return ""
  return path.slice(i).toLowerCase()
}

function makeSlug(path: string, rootPath: string): string {
  // Take the relative path from root, strip extension, replace
  // separators with dashes. Apply AIP-10 slug pattern.
  const rel = path.startsWith(rootPath) ? path.slice(rootPath.length) : path
  const stripped = rel.replace(/^\/+/, "").replace(/\.[^.]+$/, "")
  const slugified = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 96)
  return slugified || "source"
}

function readTitleFromBody(body: string, fallback: string): string {
  // First markdown H1 line, or the filename slug.
  const m = body.match(/^\s*#\s+(.+)$/m)
  if (m && m[1]) return m[1].trim().slice(0, 200)
  return fallback
}

function sha256(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex")
}
