/**
 * `corpus distill [workspace]` — raw sources → refined AIP-10 entries.
 *
 *   corpus distill <ws> [--engine id] [--source <id>] [--max n] [--throttle ms]
 *                       [--model m] [--lens <id> | --lens-file <path>]
 *
 * Reads sources/**​/*.md, distills each via the selected engine into refined
 * entries (principle/pattern/critique/summary/example) written under entries/,
 * each carrying `sources: [<sourceId>]` (provenance) + inherited `access`.
 * Resumable: skips sources that already have entries derived from them.
 *
 * LENSES (`--lens <id>` / `--lens-file <path>`):
 *   Read every source THROUGH one aspect. The lens's prompt becomes the
 *   extraction instruction, its kinds constrain the output, and each entry is
 *   stamped with the `aspect:<value>` facet tag. `--lens <id>` resolves a
 *   workspace-declared `lenses/<id>.md` (override) or a built-in (`craft`);
 *   `--lens-file <path>` points at an ad-hoc lens declaration. Under a lens the
 *   resume ledger is keyed by `(source, lens)` (the `_distill-index.yaml`
 *   sidecar), so two lenses over one source never short-circuit each other.
 *   Without a lens the behaviour is unchanged: the generic durable-insight pass,
 *   resumed by scanning existing entries.
 *
 * Engines (`--engine`, default `anthropic-api`):
 *   anthropic-api  metered Messages API (needs ANTHROPIC_API_KEY)
 *   claude-code    local `claude` CLI, billed against the logged-in subscription
 *                  (no API key) — cheaper for large batches, subject to rate caps
 *   gemini         local `gemini` CLI (Google login / GEMINI_API_KEY)
 *   codex          local `codex exec` (ChatGPT login / OPENAI_API_KEY)
 *   opencode       local `opencode run` (provider key: ANTHROPIC/OPENAI/OPENROUTER…)
 * The three CLI engines use each tool's first-party non-interactive print mode
 * (prompt on stdin → plain text out); confirm flags against `<cli> --help`.
 */

import { readFile, readdir } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { createHash } from "node:crypto"
import { basename, join } from "node:path"
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
import {
  DistillIndex,
  DistillRunner,
  lensAspect,
  systemClock,
  type DistillSource,
  type DistillPort,
  type EntryLayout,
  type Lens,
} from "@agentproto/corpus"
import { AnthropicDistiller } from "../ports/anthropic-distiller.js"
import { CliAgentDistiller } from "../ports/cli-agent-distiller.js"
import { CLI_ENGINES } from "../ports/cli-engines.js"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { createUsageSink, type DistillUsage } from "../ports/usage-telemetry.js"
import { LensError, resolveLens, resolveLensFile } from "../lenses/resolve.js"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"

const DEFAULT_ENGINE = "anthropic-api"

/**
 * Read the corpus's preferred entry layout from KNOWLEDGE.md
 * (`metadata.corpus.entryLayout: flat | dated`). Absent / unreadable → undefined
 * (the runner defaults to "dated"). Lives in freeform `metadata`, so no spec change.
 */
async function readEntryLayout(target: string): Promise<EntryLayout | undefined> {
  try {
    const raw = await readFile(join(target, "KNOWLEDGE.md"), "utf8")
    const layout = (matter(raw).data as Record<string, unknown>)?.metadata
    const corpus = (layout as Record<string, unknown> | undefined)?.["corpus"] as
      | Record<string, unknown>
      | undefined
    const v = corpus?.["entryLayout"]
    return v === "flat" || v === "dated" ? v : undefined
  } catch {
    return undefined
  }
}

/** A selectable distill engine: whether it needs an API key + how to build it. */
interface DistillerEngine {
  readonly id: string
  readonly needsApiKey: boolean
  create(opts: {
    apiKey?: string
    model?: string
    onUsage?: (usage: DistillUsage) => void
    lang?: string
  }): DistillPort
}

/**
 * Engine registry — the metered API plus every CLI engine, dispatched by id (no
 * `engine === "..."` branching at the call site). Add a CLI engine in
 * cli-engines.ts and it appears here automatically.
 */
const DISTILLER_ENGINES: Readonly<Record<string, DistillerEngine>> = {
  [DEFAULT_ENGINE]: {
    id: DEFAULT_ENGINE,
    needsApiKey: true,
    create: ({ apiKey, model, onUsage, lang }) =>
      new AnthropicDistiller({
        apiKey: apiKey!,
        ...(model ? { model } : {}),
        ...(onUsage ? { onUsage } : {}),
        ...(lang ? { lang } : {}),
      }),
  },
  ...Object.fromEntries(
    Object.values(CLI_ENGINES).map(engine => [
      engine.id,
      {
        id: engine.id,
        needsApiKey: false,
        create: ({ model, lang }) =>
          new CliAgentDistiller({
            engine,
            ...(model ? { model } : {}),
            ...(lang ? { lang } : {}),
          }),
      } satisfies DistillerEngine,
    ])
  ),
}

export interface ParsedArgs {
  workspace: string | undefined
  sourceId: string | undefined
  max: number | undefined
  throttleMs: number
  model: string | undefined
  engine: string
  lang: string | undefined
  /** `--lens <id>` — resolve a workspace-declared or built-in lens by id. */
  lens: string | undefined
  /** `--lens-file <path>` — an ad-hoc lens declaration, resolved by path. */
  lensFile: string | undefined
}

export function parse(args: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    workspace: undefined,
    sourceId: undefined,
    max: undefined,
    throttleMs: 1000,
    model: undefined,
    engine: DEFAULT_ENGINE,
    lang: undefined,
    lens: undefined,
    lensFile: undefined,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const next = () => args[++i]
    switch (a) {
      case "--source": out.sourceId = next(); break
      case "--max": { const v = next(); if (v) out.max = Number(v); break }
      case "--throttle": { const v = next(); if (v) out.throttleMs = Number(v); break }
      case "--model": out.model = next(); break
      case "--engine": { const v = next(); if (v) out.engine = v; break }
      case "--lang": out.lang = next(); break
      case "--lens": out.lens = next(); break
      case "--lens-file": out.lensFile = next(); break
      default:
        if (!a.startsWith("-") && out.workspace === undefined) out.workspace = a
    }
  }
  return out
}

interface RawSource extends DistillSource {
  readonly path: string
  /** sha256 of the source body — the `(source, lens)` ledger's change key. */
  readonly contentHash: string
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
      const body = parsed.content.trim()
      out.push({
        path,
        id: fm.id,
        title: fm.title ?? fm.id,
        body,
        contentHash: "sha256:" + createHash("sha256").update(body).digest("hex"),
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

/** Overlay a lens's extraction instruction / kinds / aspect onto a raw source. */
function applyLens(src: RawSource, lens: Lens): DistillSource {
  return {
    ...src,
    instruction: lens.prompt,
    ...(lens.kinds ? { kinds: lens.kinds } : {}),
    aspect: lensAspect(lens),
  }
}

/** Injectable deps — the distiller is a test seam (bypasses the engine registry). */
export interface RunDistillDeps {
  /** Replace the engine-built DistillPort (tests inject a fake; no API key needed). */
  readonly distiller?: DistillPort
}

export async function runDistill(
  args: readonly string[],
  deps: RunDistillDeps = {}
): Promise<ExitCode> {
  const parsed = parse(args)
  const target = resolveWorkspacePath(parsed.workspace)

  if (parsed.lens && parsed.lensFile) {
    return fail("--lens and --lens-file are mutually exclusive.", 2)
  }

  // Resolve the lens (if any) up front — a bad lens id fails before any LLM call.
  let lens: Lens | undefined
  if (parsed.lens || parsed.lensFile) {
    try {
      lens = parsed.lensFile
        ? await resolveLensFile(parsed.lensFile)
        : await resolveLens(parsed.lens!, target)
    } catch (e) {
      if (e instanceof LensError) return fail(e.message, 2)
      throw e
    }
  }

  // The distiller: an injected one (tests) or one built from the engine registry.
  const usage = createUsageSink({ runName: basename(target) })
  let distiller: DistillPort
  let engineLabel: string
  if (deps.distiller) {
    distiller = deps.distiller
    engineLabel = parsed.engine
  } else {
    const engine = DISTILLER_ENGINES[parsed.engine]
    if (!engine) {
      return fail(
        `unknown --engine "${parsed.engine}". Valid: ${Object.keys(DISTILLER_ENGINES).join(", ")}.`,
        2
      )
    }
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (engine.needsApiKey && !apiKey) {
      return fail(`distill engine "${engine.id}" needs ANTHROPIC_API_KEY in the environment.`, 2)
    }
    distiller = engine.create({
      ...(apiKey ? { apiKey } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      onUsage: usage.record,
      ...(parsed.lang ? { lang: parsed.lang } : {}),
    })
    engineLabel = engine.id
  }

  const fs = new NodeFsAdapter({ root: target })
  const all = await readSources(target)
  if (all.length === 0) return fail("no sources found under sources/ — run import-web first.", 2)

  // Resume set. Under a lens: the `(source, lens)` ledger (independent cadence
  // per lens). Without a lens: the legacy entry-scan (unchanged back-compat).
  const index = new DistillIndex({ fs })
  let pool: RawSource[]
  if (parsed.sourceId) {
    pool = all.filter(s => s.id === parsed.sourceId)
  } else if (lens) {
    pool = []
    for (const s of all) {
      if (!(await index.isDistilled(s.id, s.contentHash, lens.id))) pool.push(s)
    }
  } else {
    const done = await scanDistilledSourceIds(target)
    pool = all.filter(s => !done.has(s.id))
  }
  const batch = parsed.max !== undefined ? pool.slice(0, parsed.max) : pool

  process.stdout.write(
    `distill → ${target}\n` +
      `  engine:   ${engineLabel}\n` +
      (lens ? `  lens:     ${lens.id} (aspect:${lensAspect(lens)})\n` : "") +
      `  sources:  ${all.length} total · ${all.length - pool.length} already distilled · ${pool.length} to do\n` +
      `  this run: ${batch.length}${parsed.max !== undefined ? ` (--max ${parsed.max})` : ""}\n`
  )
  if (batch.length === 0) {
    process.stdout.write("  nothing to do.\n")
    return 0
  }

  const layout = await readEntryLayout(target)
  const runner = new DistillRunner({
    fs,
    clock: systemClock,
    ...(layout ? { layout } : {}),
    distiller,
  })

  let totalEntries = 0
  for (let i = 0; i < batch.length; i++) {
    const raw = batch[i]!
    const src = lens ? applyLens(raw, lens) : raw
    if (i > 0 && parsed.throttleMs > 0) await sleep(parsed.throttleMs)
    try {
      const report = await runner.run(src)
      totalEntries += report.entryPaths.length
      // Under a lens, record the run in the `(source, lens)` ledger so a re-run
      // of THIS lens skips the unchanged source without touching other lenses.
      if (lens) {
        await index.record({
          sourceId: raw.id,
          lensId: lens.id,
          title: raw.title,
          distilledAt: systemClock.now().toISOString(),
          engine: engineLabel,
          contentHash: raw.contentHash,
          entryCount: report.entryPaths.length,
          ...(report.entryPaths.length ? { entryPaths: report.entryPaths } : {}),
        })
      }
      process.stdout.write(`  ✓ ${raw.id} → ${report.entryPaths.length} entries\n`)
    } catch (e) {
      process.stdout.write(`  ! ${raw.id} — ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
  process.stdout.write(`\n${totalEntries} refined entries written (each with sources:[<id>] provenance).\n`)
  await usage.flush()
  return 0
}
