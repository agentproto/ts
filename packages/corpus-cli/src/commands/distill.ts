/**
 * `corpus distill [workspace]` — raw sources → refined AIP-10 entries.
 *
 *   corpus distill <ws> [--source <id>] [--max n] [--throttle ms] [--model m]
 *
 * Reads sources/**​/*.md, distills each via Claude into refined entries
 * (principle/pattern/critique/summary/example) written under entries/, each
 * carrying `sources: [<sourceId>]` (provenance) + inherited `access`.
 * Resumable: skips sources that already have entries derived from them.
 */

import { readFile, readdir } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

/** Lenient zod view of a source's frontmatter (each field degrades to undefined). */
const SOURCE_FRONTMATTER = z
  .object({
    id: z.string().optional().catch(undefined),
    title: z.string().optional().catch(undefined),
    tags: z.array(z.string()).optional().catch(undefined),
    language: z.string().optional().catch(undefined),
    metadata: z
      .object({
        corpus: z
          .object({
            access: z.string().optional().catch(undefined),
            domain: z.string().optional().catch(undefined),
          })
          .loose()
          .optional()
          .catch(undefined),
      })
      .loose()
      .optional()
      .catch(undefined),
  })
  .loose()

/** An entry's `sources:` provenance — used to mark a source already distilled. */
const ENTRY_SOURCES_FRONTMATTER = z
  .object({ sources: z.array(z.string()).optional().catch(undefined) })
  .loose()
import matter from "gray-matter"
import { DistillRunner, systemClock, type DistillSource } from "@agentproto/corpus"
import { AnthropicDistiller } from "../ports/anthropic-distiller.js"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"

interface ParsedArgs {
  workspace: string | undefined
  sourceId: string | undefined
  max: number | undefined
  throttleMs: number
  model: string | undefined
}

function parse(args: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    workspace: undefined,
    sourceId: undefined,
    max: undefined,
    throttleMs: 1000,
    model: undefined,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const next = () => args[++i]
    switch (a) {
      case "--source": out.sourceId = next(); break
      case "--max": { const v = next(); if (v) out.max = Number(v); break }
      case "--throttle": { const v = next(); if (v) out.throttleMs = Number(v); break }
      case "--model": out.model = next(); break
      default:
        if (!a.startsWith("-") && out.workspace === undefined) out.workspace = a
    }
  }
  return out
}

interface RawSource extends DistillSource {
  readonly path: string
}

/** Parse every sources/**​/*.md into a DistillSource. */
async function readSources(root: string): Promise<RawSource[]> {
  const dir = join(root, "sources")
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true })
  } catch {
    return []
  }
  const out: RawSource[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue
    const path = join(e.parentPath, e.name)
    try {
      const parsed = matter(await readFile(path, "utf-8"))
      const fm = SOURCE_FRONTMATTER.parse(parsed.data)
      if (!fm.id || !parsed.content.trim()) continue
      out.push({
        path,
        id: fm.id,
        title: fm.title ?? fm.id,
        body: parsed.content.trim(),
        ...(fm.tags ? { tags: fm.tags } : {}),
        ...(fm.metadata?.corpus?.access ? { access: fm.metadata.corpus.access } : {}),
        ...(fm.metadata?.corpus?.domain ? { domain: fm.metadata.corpus.domain } : {}),
      })
    } catch {
      // skip unreadable / non-frontmatter
    }
  }
  return out
}

/** Source ids that already have at least one entry derived from them. */
async function scanDistilledSourceIds(root: string): Promise<Set<string>> {
  const seen = new Set<string>()
  const dir = join(root, "entries")
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true })
  } catch {
    return seen
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue
    try {
      const fm = ENTRY_SOURCES_FRONTMATTER.parse(
        matter(await readFile(join(e.parentPath, e.name), "utf-8")).data
      )
      if (fm.sources) for (const s of fm.sources) seen.add(s)
    } catch {
      /* ignore */
    }
  }
  return seen
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function runDistill(args: readonly string[]): Promise<ExitCode> {
  const parsed = parse(args)
  const target = resolveWorkspacePath(parsed.workspace)
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fail("distill needs ANTHROPIC_API_KEY in the environment.", 2)

  const all = await readSources(target)
  if (all.length === 0) return fail("no sources found under sources/ — run import-web first.", 2)

  const done = await scanDistilledSourceIds(target)
  const pool = parsed.sourceId
    ? all.filter(s => s.id === parsed.sourceId)
    : all.filter(s => !done.has(s.id))
  const batch = parsed.max !== undefined ? pool.slice(0, parsed.max) : pool

  process.stdout.write(
    `distill → ${target}\n` +
      `  sources:  ${all.length} total · ${all.length - pool.length} already distilled · ${pool.length} to do\n` +
      `  this run: ${batch.length}${parsed.max !== undefined ? ` (--max ${parsed.max})` : ""}\n`
  )
  if (batch.length === 0) {
    process.stdout.write("  nothing to do.\n")
    return 0
  }

  const runner = new DistillRunner({
    fs: new NodeFsAdapter({ root: target }),
    clock: systemClock,
    distiller: new AnthropicDistiller({ apiKey, ...(parsed.model ? { model: parsed.model } : {}) }),
  })

  let totalEntries = 0
  for (let i = 0; i < batch.length; i++) {
    const src = batch[i]!
    if (i > 0 && parsed.throttleMs > 0) await sleep(parsed.throttleMs)
    try {
      const report = await runner.run(src)
      totalEntries += report.entryPaths.length
      process.stdout.write(`  ✓ ${src.id} → ${report.entryPaths.length} entries\n`)
    } catch (e) {
      process.stdout.write(`  ! ${src.id} — ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
  process.stdout.write(`\n${totalEntries} refined entries written (each with sources:[<id>] provenance).\n`)
  return 0
}
