/**
 * Claude-native conversation import helpers.
 *
 * Scans the Claude project transcript tree under `~/.claude/projects/` and
 * derives the launch cwd directly
 * from the payload lines. This is intentionally separate from
 * conversation-store.ts's cwd-scoped reader: the importer needs the global
 * catalog, and the cwd on each file is the ground truth.
 */

import { promises as fs, type Dirent } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

const CONTENT_LINE_TYPES = new Set(["user", "assistant", "attachment", "system"])

interface ClaudeJsonlLine {
  type?: string
  timestamp?: string
  cwd?: unknown
  message?: {
    role?: string
    content?: unknown
  }
}

export interface ClaudeConversationImportCandidate {
  conversationId: string
  filePath: string
  cwd?: string
  firstContentAt?: string
  preview?: string
  contentLineCount: number
  cwdVariantCount: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function extractFirstText(content: unknown): string | undefined {
  if (typeof content === "string") {
    const text = content.trim()
    return text || undefined
  }
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (
      isObject(block) &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim()
    ) {
      return block.text.trim()
    }
  }
  return undefined
}

function chooseDerivedCwd(
  firstCwd: string | undefined,
  counts: Map<string, number>,
): string | undefined {
  if (firstCwd) return firstCwd
  if (counts.size === 0) return undefined
  let winner: string | undefined
  let winnerCount = 0
  let tied = false
  for (const [cwd, count] of counts) {
    if (count > winnerCount) {
      winner = cwd
      winnerCount = count
      tied = false
    } else if (count === winnerCount) {
      tied = true
    }
  }
  return tied ? undefined : winner
}

async function scanClaudeJsonl(filePath: string): Promise<ClaudeConversationImportCandidate | undefined> {
  const handle = await fs.open(filePath, "r")
  try {
    const stream = handle.createReadStream({ encoding: "utf8" })
    const reader = stream[Symbol.asyncIterator]()

    let buffer = ""
    let firstContentAt: string | undefined
    let firstCwd: string | undefined
    let preview: string | undefined
    let contentLineCount = 0
    const cwdCounts = new Map<string, number>()

    const consumeLine = (rawLine: string): void => {
      const line = rawLine.trim()
      if (!line) return
      let entry: ClaudeJsonlLine
      try {
        entry = JSON.parse(line) as ClaudeJsonlLine
      } catch {
        return
      }
      if (!entry.type || !CONTENT_LINE_TYPES.has(entry.type)) return

      contentLineCount += 1

      if (!firstContentAt && typeof entry.timestamp === "string") {
        firstContentAt = entry.timestamp
      }

      if (typeof entry.cwd === "string" && entry.cwd.length > 0) {
        cwdCounts.set(entry.cwd, (cwdCounts.get(entry.cwd) ?? 0) + 1)
        if (!firstCwd) firstCwd = entry.cwd
      }

      if (!preview && entry.type === "user") {
        const text = extractFirstText(entry.message?.content)
        if (text) preview = text.length > 120 ? `${text.slice(0, 117)}…` : text
      }
    }

    while (true) {
      const next = await reader.next()
      if (next.done) break
      buffer += next.value
      let nl = buffer.indexOf("\n")
      while (nl !== -1) {
        consumeLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf("\n")
      }
    }
    if (buffer) consumeLine(buffer)

    const cwd = chooseDerivedCwd(firstCwd, cwdCounts)
    return {
      conversationId: basename(filePath, ".jsonl"),
      filePath: resolve(filePath),
      ...(cwd ? { cwd } : {}),
      ...(firstContentAt ? { firstContentAt } : {}),
      ...(preview ? { preview } : {}),
      contentLineCount,
      cwdVariantCount: cwdCounts.size,
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

async function walkJsonlFiles(rootDir: string): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(full)
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full)
      }
    }
  }
  await visit(rootDir)
  return out
}

/**
 * List every Claude conversation jsonl in ~/.claude/projects, deriving the
 * launch cwd from the payload itself.
 */
export async function listClaudeConversationCandidates(
  rootDir = join(homedir(), ".claude", "projects"),
): Promise<ClaudeConversationImportCandidate[]> {
  const files = await walkJsonlFiles(rootDir)
  const candidates: ClaudeConversationImportCandidate[] = []
  for (const filePath of files) {
    const candidate = await scanClaudeJsonl(filePath)
    if (candidate) candidates.push(candidate)
  }
  return candidates.sort((a, b) => {
    const at = a.firstContentAt ? Date.parse(a.firstContentAt) : NaN
    const bt = b.firstContentAt ? Date.parse(b.firstContentAt) : NaN
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at
    if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(bt) ? 1 : -1
    return a.conversationId.localeCompare(b.conversationId)
  })
}
