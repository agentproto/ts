/**
 * CodeImporter — reads a source tree from a configured FsPort and yields
 * one ImportedSource per code unit (a file, or a module/directory) as a
 * plain-markdown *note* describing that unit.
 *
 * ── THE code-brain SEAM (non-negotiable) ────────────────────────────
 * This importer produces **corpus notes ONLY**. It performs ZERO code
 * indexing and builds NO symbol / caller / callee graph. The note it emits
 * is a human-readable scaffold — path, language, a shallow surface-scan of
 * exported symbol *names*, and the source text — authored for the distill
 * pipeline (`knowledge.source` → `knowledge.entry`), NOT a parsed graph.
 * Symbol/caller/callee graph construction is entirely the future code-brain
 * subsystem's job. The two "code" paths never touch here: notes flow into
 * the corpus wiki; the symbol graph flows into the code-brain indexer
 * elsewhere. This keeps the corpus contract free of any code-index coupling
 * and lets the code importer ship BEFORE the code-brain subsystem exists.
 * (PH3-BUILD-SPEC §2b, Jeremy decision #2: AIP-27 code↔knowledge ref edges
 * are DEFERRED — no ref edges are emitted here.)
 *
 * Config (target.config):
 *   - rootPath: string             — workspace-relative path to scan (required)
 *   - include?: string[]           — glob patterns; defaults to ["**​/*.ts"]
 *   - granularity?: "file"|"module" — one note per file, or per directory
 *                                     (default "file")
 *   - maxFiles?: number            — cap on code units yielded (default 1000)
 *   - tags?: string[]              — applied to every imported source
 *   - language?: string            — BCP-47 human language of the notes
 *
 * Pure kit code — consumes FsPort, no node:fs / no network.
 *
 * Content hash: sha256 of the underlying file bytes (per unit), so re-runs
 * only re-import a unit when its actual source changes — the runner's
 * content_hash dedup gate does the rest.
 */

import { createHash } from "node:crypto"
import { z } from "zod"
import { slugify, uniqueSlug } from "../util/slug.js"
import type { FsPort } from "../ports/fs.port.js"
import type {
  CorpusImporter,
  ImportedSource,
  ImporterTarget,
} from "./types.js"

export interface CodeImporterOptions {
  readonly fs: FsPort
}

const configSchema = z.object({
  rootPath: z.string().min(1),
  include: z.array(z.string()).optional(),
  granularity: z.enum(["file", "module"]).optional(),
  maxFiles: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional(),
  language: z.string().optional(),
})

type CodeConfig = z.infer<typeof configSchema>

/** One resolved file: its root-relative path + the path to read it by. */
interface CodeFile {
  readonly rel: string
  readonly readPath: string
}

export class CodeImporter implements CorpusImporter {
  readonly id = "code"
  readonly label = "Code"

  constructor(private readonly opts: CodeImporterOptions) {}

  async *enumerate(target: ImporterTarget): AsyncIterable<ImportedSource> {
    const config = parseConfig(target.config)
    const include = config.include ?? ["**/*.ts"]
    const granularity = config.granularity ?? "file"
    const maxFiles = config.maxFiles ?? 1000
    const matchers = include.map(globToRegExp)

    // Walk once, keep only paths matching an include glob, sort for
    // deterministic output + stable module grouping across adapters.
    const walked = await this.opts.fs.walk(config.rootPath)
    const files: CodeFile[] = []
    for (const p of walked) {
      const rel = relFromRoot(p, config.rootPath)
      if (!matchers.some((m) => m.test(rel))) continue
      files.push({ rel, readPath: joinRoot(config.rootPath, rel) })
    }
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

    const seenSlugs = new Set<string>()
    if (granularity === "module") {
      yield* this.enumerateModules(files, config, seenSlugs, maxFiles)
    } else {
      yield* this.enumerateFiles(files, config, seenSlugs, maxFiles)
    }
  }

  private async *enumerateFiles(
    files: readonly CodeFile[],
    config: CodeConfig,
    seenSlugs: Set<string>,
    maxFiles: number
  ): AsyncIterable<ImportedSource> {
    let yielded = 0
    for (const file of files) {
      if (yielded >= maxFiles) break
      const body = await this.opts.fs.readFile(file.readPath)
      const lang = detectLang(file.rel)
      const exports = extractExportedSymbols(body)
      const slug = uniqueSlug(
        slugify(file.rel, { fallback: "code-unit" }),
        seenSlugs
      )
      yield {
        slug,
        title: file.rel,
        contentHash: sha256(body),
        body: buildFileNote(file.rel, body, lang, exports),
        authority: "secondary",
        ...(config.language ? { language: config.language } : {}),
        ...(config.tags && config.tags.length > 0 ? { tags: config.tags } : {}),
        corpusMetadata: {
          provenanceKind: "imported-from-code",
          importerRoot: config.rootPath,
          importerSourcePath: file.rel,
          granularity: "file",
          lang,
          ...(exports.length > 0 ? { exportedSymbols: exports } : {}),
        },
      }
      yielded++
    }
  }

  private async *enumerateModules(
    files: readonly CodeFile[],
    config: CodeConfig,
    seenSlugs: Set<string>,
    maxFiles: number
  ): AsyncIterable<ImportedSource> {
    // Group files by their immediate parent directory (root-relative).
    const byModule = new Map<string, CodeFile[]>()
    for (const file of files) {
      const dir = dirOf(file.rel)
      const bucket = byModule.get(dir)
      if (bucket) bucket.push(file)
      else byModule.set(dir, [file])
    }

    let yielded = 0
    for (const [dir, members] of [...byModule.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    )) {
      if (yielded >= maxFiles) break
      const read = await Promise.all(
        members.map(async (m) => ({
          rel: m.rel,
          body: await this.opts.fs.readFile(m.readPath),
        }))
      )
      // Module hash = hash of each member's (path + bytes), in sorted order —
      // still just file bytes, no graph.
      const hasher = createHash("sha256")
      for (const r of read) hasher.update(r.rel).update("\0").update(r.body).update("\0")
      const contentHash = "sha256:" + hasher.digest("hex")
      const title = dir === "" ? "(root)" : dir
      const slug = uniqueSlug(
        slugify(dir || "root", { fallback: "module" }),
        seenSlugs
      )
      yield {
        slug,
        title,
        contentHash,
        body: buildModuleNote(dir, read),
        authority: "secondary",
        ...(config.language ? { language: config.language } : {}),
        ...(config.tags && config.tags.length > 0 ? { tags: config.tags } : {}),
        corpusMetadata: {
          provenanceKind: "imported-from-code",
          importerRoot: config.rootPath,
          importerSourcePath: dir === "" ? "." : dir,
          granularity: "module",
          fileCount: read.length,
        },
      }
      yielded++
    }
  }
}

// ── Config ──────────────────────────────────────────────────────────

function parseConfig(raw: Readonly<Record<string, unknown>>): CodeConfig {
  const result = configSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue?.path.join(".") || "config"
    throw new Error(
      `CodeImporter: invalid config.${where} — ${issue?.message ?? "parse error"}`
    )
  }
  return result.data
}

// ── Path helpers (adapter-agnostic) ─────────────────────────────────
//
// FsPort.walk returns workspace-relative paths in the memory adapter but
// rootPath-relative paths in the node adapter. Normalise both to a
// root-relative `rel`, then rebuild a `readPath` the adapter's readFile
// accepts — join(rootPath, rel) is correct for both.

function relFromRoot(p: string, rootPath: string): string {
  if (!rootPath) return p
  const pref = rootPath.endsWith("/") ? rootPath : rootPath + "/"
  return p.startsWith(pref) ? p.slice(pref.length) : p
}

function joinRoot(rootPath: string, rel: string): string {
  if (!rootPath) return rel
  return rootPath.endsWith("/") ? rootPath + rel : rootPath + "/" + rel
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/")
  return i < 0 ? "" : rel.slice(0, i)
}

// ── Glob matching ───────────────────────────────────────────────────
//
// Minimal, self-contained glob → RegExp (no dependency): `**` crosses
// directory boundaries, `*` matches within a segment, `?` a single
// non-slash char. Enough for include patterns like `**​/*.ts`.

function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?" // "**/" — zero or more leading directories
          i += 2
        } else {
          re += ".*" // "**" — cross any boundary
          i += 1
        }
      } else {
        re += "[^/]*" // "*" — within a single segment
      }
    } else if (c === "?") {
      re += "[^/]"
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c
    } else {
      re += c
    }
  }
  return new RegExp("^" + re + "$")
}

// ── Note authoring (surface-level only, NOT a symbol graph) ──────────

const LANG_BY_EXT: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  sh: "shell",
  sql: "sql",
  md: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
}

function detectLang(path: string): string {
  const i = path.lastIndexOf(".")
  const ext = i >= 0 ? path.slice(i + 1).toLowerCase() : ""
  return LANG_BY_EXT[ext] ?? (ext || "text")
}

/**
 * Shallow surface-scan for exported symbol *names* — for the human-readable
 * note only. Deliberately NOT a symbol graph: no positions, no signatures,
 * no callers/callees, no cross-file edges. Distillation (or, later,
 * code-brain) does the real analysis.
 */
function extractExportedSymbols(body: string): readonly string[] {
  const names = new Set<string>()
  const declRe =
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g
  for (const m of body.matchAll(declRe)) if (m[1]) names.add(m[1])
  const groupRe = /\bexport\s*\{([^}]*)\}/g
  for (const m of body.matchAll(groupRe)) {
    for (const part of m[1]!.split(",")) {
      const seg = part.trim()
      if (!seg) continue
      const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)/)
      const name = asMatch ? asMatch[1]! : seg.split(/\s+/)[0]!
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  return [...names]
}

const SEAM_NOTE =
  "> Note scaffold from the `code` corpus importer — a plain-text description\n" +
  "> of this code unit for the distill pipeline. This is NOT a symbol / caller /\n" +
  "> callee graph; that is the code-brain subsystem's job."

/** A code fence guaranteed longer than any backtick run inside `body`. */
function safeFence(body: string): string {
  let max = 2
  for (const m of body.matchAll(/`+/g)) max = Math.max(max, m[0].length)
  return "`".repeat(max + 1)
}

function buildFileNote(
  rel: string,
  body: string,
  lang: string,
  exports: readonly string[]
): string {
  const symbolLine =
    exports.length > 0
      ? exports.map((s) => "`" + s + "`").join(", ")
      : "_none detected_"
  const fence = safeFence(body)
  return [
    `# ${rel}`,
    "",
    `- **Path:** \`${rel}\``,
    `- **Language:** ${lang}`,
    `- **Exported symbols:** ${symbolLine}`,
    "",
    SEAM_NOTE,
    "",
    "## Source",
    "",
    fence + lang,
    body.replace(/\n+$/, ""),
    fence,
    "",
  ].join("\n")
}

function buildModuleNote(
  dir: string,
  members: readonly { readonly rel: string; readonly body: string }[]
): string {
  const heading = dir === "" ? "(root)" : dir
  const lines: string[] = [
    `# ${heading}`,
    "",
    `- **Module:** \`${dir === "" ? "." : dir}\``,
    `- **Files:** ${members.length}`,
    "",
    SEAM_NOTE,
    "",
    "## Files",
    "",
  ]
  for (const m of members) lines.push(`- \`${m.rel}\``)
  for (const m of members) {
    const lang = detectLang(m.rel)
    const fence = safeFence(m.body)
    lines.push(
      "",
      `## ${m.rel}`,
      "",
      fence + lang,
      m.body.replace(/\n+$/, ""),
      fence
    )
  }
  lines.push("")
  return lines.join("\n")
}

function sha256(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex")
}
