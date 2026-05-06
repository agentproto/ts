/**
 * Append-only conversation persistence as plain markdown.
 *
 * Each conversation is a file at `<workspace>/conversations/<id>.md`
 * with a frontmatter header (`schema: conversation/v1`, `id`, `agent`,
 * `started`, `status`) and a body composed of `## <role> — <iso>`
 * blocks. Append-only: turns are concatenated to the body, never
 * rewritten in place. Readers tolerant to clock skew use the timestamp
 * in each block, not file mtime.
 *
 * The format is intentionally trivial — git-diffable, human-editable,
 * survives `cat`. Designed to converge with the AIP runtime/v1 spec
 * (TBD) once it lands.
 */

import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/

export type ConvRole = "user" | "assistant" | "system"

export interface ConversationMeta {
  id: string
  agent: string
  started: string
  status: "open" | "closed"
}

export interface ConversationTurn {
  role: ConvRole
  at: string
  /** Optional sub-attribution after the role (e.g. agent id). */
  attribution?: string
  content: string
}

export interface ConversationStore {
  /**
   * Open a conversation. If the file doesn't exist, it's created with
   * a frontmatter header. If it exists, no-op (idempotent).
   */
  open(id: string, meta: { agent: string }): Promise<void>
  appendTurn(
    id: string,
    role: ConvRole,
    content: string,
    opts?: { attribution?: string; at?: string },
  ): Promise<void>
  read(
    id: string,
  ): Promise<{ meta: ConversationMeta; turns: ConversationTurn[] }>
  list(): Promise<Array<{ id: string; meta: ConversationMeta }>>
  /** Workspace-relative path to the conv file, for tooling. */
  pathFor(id: string): string
}

export interface FileConversationStoreOptions {
  /** Absolute workspace root. */
  workspace: string
  /** Override `<workspace>/conversations`. */
  dir?: string
}

export function fileConversationStore(
  opts: FileConversationStoreOptions,
): ConversationStore {
  const dir = opts.dir ?? join(opts.workspace, "conversations")

  const filePath = (id: string) => join(dir, `${id}.md`)

  return {
    pathFor: filePath,

    async open(id, meta) {
      await mkdir(dir, { recursive: true })
      const path = filePath(id)
      if (existsSync(path)) return
      const header = renderHeader({
        id,
        agent: meta.agent,
        started: new Date().toISOString(),
        status: "open",
      })
      await writeFile(path, header, "utf8")
    },

    async appendTurn(id, role, content, options) {
      const path = filePath(id)
      // Lazy-open: if a caller appends without opening, create the
      // file so the operation never silently drops a turn.
      if (!existsSync(path)) {
        await this.open(id, { agent: options?.attribution ?? "unknown" })
      }
      const block = renderTurn({
        role,
        at: options?.at ?? new Date().toISOString(),
        attribution: options?.attribution,
        content,
      })
      // Append a leading blank line so the new block is always
      // separated from whatever's above (header or prev turn).
      await writeFile(path, block, { encoding: "utf8", flag: "a" })
    },

    async read(id) {
      const path = filePath(id)
      const source = await readFile(path, "utf8")
      return parseConversation(source, id)
    },

    async list() {
      if (!existsSync(dir)) return []
      const entries = await readdir(dir, { withFileTypes: true })
      const out: Array<{ id: string; meta: ConversationMeta }> = []
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue
        const id = entry.name.slice(0, -3)
        try {
          const source = await readFile(join(dir, entry.name), "utf8")
          const { meta } = parseConversation(source, id)
          out.push({ id, meta })
        } catch {
          // Skip malformed conv files rather than crash list().
        }
      }
      return out
    },
  }
}

// ── render ───────────────────────────────────────────────────────────

function renderHeader(meta: ConversationMeta): string {
  return [
    "---",
    `schema: conversation/v1`,
    `id: ${meta.id}`,
    `agent: ${meta.agent}`,
    `started: ${meta.started}`,
    `status: ${meta.status}`,
    "---",
    "",
    "",
  ].join("\n")
}

function renderTurn(turn: ConversationTurn): string {
  const heading = turn.attribution
    ? `## ${turn.role} — ${turn.at} (${turn.attribution})`
    : `## ${turn.role} — ${turn.at}`
  return `${heading}\n\n${turn.content.trimEnd()}\n\n`
}

// ── parse ────────────────────────────────────────────────────────────

interface ParsedConversation {
  meta: ConversationMeta
  turns: ConversationTurn[]
}

function parseConversation(source: string, fallbackId: string): ParsedConversation {
  const match = source.match(FRONTMATTER_RE)
  let meta: ConversationMeta = {
    id: fallbackId,
    agent: "unknown",
    started: "",
    status: "open",
  }
  let body = source
  if (match) {
    meta = parseFrontmatter(match[1] ?? "", fallbackId)
    body = source.slice(match[0].length)
  }

  const turns: ConversationTurn[] = []
  // Split on `## <role> — <iso>` headings. Conservative — anything
  // that doesn't match is treated as continuation of the prior turn.
  const lines = body.split("\n")
  let current: ConversationTurn | null = null
  let buffer: string[] = []

  const flush = () => {
    if (!current) return
    current.content = buffer.join("\n").trim()
    turns.push(current)
    current = null
    buffer = []
  }

  const headingRe =
    /^##\s+(user|assistant|system)\s+—\s+(\S+)(?:\s+\(([^)]+)\))?\s*$/

  for (const line of lines) {
    const m = line.match(headingRe)
    if (m) {
      flush()
      current = {
        role: m[1] as ConvRole,
        at: m[2] ?? "",
        attribution: m[3],
        content: "",
      }
      continue
    }
    if (current) buffer.push(line)
  }
  flush()

  return { meta, turns }
}

function parseFrontmatter(
  raw: string,
  fallbackId: string,
): ConversationMeta {
  const out: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const colon = line.indexOf(":")
    if (colon < 1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    out[key] = value
  }
  return {
    id: out.id ?? fallbackId,
    agent: out.agent ?? "unknown",
    started: out.started ?? "",
    status: (out.status === "closed" ? "closed" : "open"),
  }
}
