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
 *   anthropic-api    metered Messages API (needs ANTHROPIC_API_KEY)
 *   anthropic-batch  Anthropic Message Batches — 50% token price, async
 *                    submit/poll/collect (needs ANTHROPIC_API_KEY)
 *   openrouter-batch OpenRouter Batch API — 50% token price, `--model` is an
 *                    OpenRouter slug, default anthropic/claude-sonnet-5
 *                    (needs OPENROUTER_API_KEY)
 *   claude-code    local `claude` CLI, billed against the logged-in subscription
 *                  (no API key) — cheaper for large batches, subject to rate caps
 *   gemini         local `gemini` CLI (Google login / GEMINI_API_KEY)
 *   codex          local `codex exec` (ChatGPT login / OPENAI_API_KEY)
 *   opencode       local `opencode run` (provider key: ANTHROPIC/OPENAI/OPENROUTER…)
 * The three CLI engines use each tool's first-party non-interactive print mode
 * (prompt on stdin → plain text out); confirm flags against `<cli> --help`.
 *
 * BATCH ENGINES (`anthropic-batch` / `openrouter-batch`):
 *   All pending sources for this run are submitted as ONE provider batch
 *   (not one call per source), then polled to completion — `--throttle` is
 *   ignored (there's no per-call pacing to throttle). The batch id prints
 *   right after submit; if the run is interrupted, re-attach with
 *   `--batch-id <id>` to skip straight to poll/collect/write instead of
 *   resubmitting. Sources that come back `expired` or `errored` are left
 *   undistilled — the existing resume logic (ledger under a lens, entry-scan
 *   without one) picks them up on the next run.
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
  hasDistillMany,
  lensAspect,
  systemClock,
  type DistillInput,
  type DistillSource,
  type DistillPort,
  type EntryLayout,
  type Lens,
} from "@agentproto/corpus"
import { BatchStore, anthropicBatchDriver, openrouterBatchDriver, type BatchDriver } from "@agentproto/batch"
import { AnthropicDistiller } from "../ports/anthropic-distiller.js"
import { BatchDistiller } from "../ports/batch-distiller.js"
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

/** A selectable distill engine: what env var it needs (if any) + how to build it. */
interface DistillerEngine {
  readonly id: string
  /** Env var this engine's API key comes from. Absent → no key needed (CLI engines). */
  readonly envKey?: "ANTHROPIC_API_KEY" | "OPENROUTER_API_KEY"
  create(opts: {
    apiKey?: string
    model?: string
    onUsage?: (usage: DistillUsage) => void
    lang?: string
    /** Every engine gets one — only the batch engines use it. */
    store: BatchStore
    /** Test seam: force a specific driver instead of building the real one. */
    driver?: BatchDriver
    batchId?: string
    pollIntervalMs?: number
  }): DistillPort
}

const ANTHROPIC_BATCH_ENGINE = "anthropic-batch"
const OPENROUTER_BATCH_ENGINE = "openrouter-batch"
const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-sonnet-5"

/**
 * Engine registry — the metered API, the two batch engines, plus every CLI
 * engine, dispatched by id (no `engine === "..."` branching at the call
 * site). Add a CLI engine in cli-engines.ts and it appears here automatically.
 */
const DISTILLER_ENGINES: Readonly<Record<string, DistillerEngine>> = {
  [DEFAULT_ENGINE]: {
    id: DEFAULT_ENGINE,
    envKey: "ANTHROPIC_API_KEY",
    create: ({ apiKey, model, onUsage, lang }) =>
      new AnthropicDistiller({
        apiKey: apiKey!,
        ...(model ? { model } : {}),
        ...(onUsage ? { onUsage } : {}),
        ...(lang ? { lang } : {}),
      }),
  },
  [ANTHROPIC_BATCH_ENGINE]: {
    id: ANTHROPIC_BATCH_ENGINE,
    envKey: "ANTHROPIC_API_KEY",
    create: ({ apiKey, model, onUsage, lang, store, driver, batchId, pollIntervalMs }) =>
      new BatchDistiller({
        driver: driver ?? anthropicBatchDriver({ apiKey: apiKey! }),
        store,
        ...(model ? { model } : {}),
        ...(onUsage ? { onUsage } : {}),
        ...(lang ? { lang } : {}),
        ...(batchId ? { batchId } : {}),
        ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
      }),
  },
  [OPENROUTER_BATCH_ENGINE]: {
    id: OPENROUTER_BATCH_ENGINE,
    envKey: "OPENROUTER_API_KEY",
    create: ({ apiKey, model, onUsage, lang, store, driver, batchId, pollIntervalMs }) =>
      new BatchDistiller({
        driver: driver ?? openrouterBatchDriver({ apiKey: apiKey! }),
        store,
        model: model ?? OPENROUTER_DEFAULT_MODEL,
        ...(onUsage ? { onUsage } : {}),
        ...(lang ? { lang } : {}),
        ...(batchId ? { batchId } : {}),
        ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
      }),
  },
  ...Object.fromEntries(
    Object.values(CLI_ENGINES).map(engine => [
      engine.id,
      {
        id: engine.id,
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
  /** `--batch-id <id>` — re-attach to a batch already submitted in a prior,
   *  interrupted run instead of submitting a new one. */
  batchId: string | undefined
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
    batchId: undefined,
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
      case "--batch-id": out.batchId = next(); break
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

/** Overlay a lens's extraction instruction / kinds / aspect onto a raw source,
 *  then flatten to the plain DistillInput shape a DistillPort/DistillBatchPort
 *  consumes — the same mapping DistillRunner.run() does internally. */
function toDistillInput(source: DistillSource): DistillInput {
  return {
    title: source.title,
    body: source.body,
    ...(source.tags ? { tags: source.tags } : {}),
    ...(source.kinds ? { kinds: source.kinds } : {}),
    ...(source.instruction ? { instruction: source.instruction } : {}),
  }
}

/** Injectable deps — the distiller is a test seam (bypasses the engine registry). */
export interface RunDistillDeps {
  /** Replace the engine-built DistillPort (tests inject a fake; no API key needed). */
  readonly distiller?: DistillPort
  /** Force a specific BatchDriver instead of the real one an engine would
   *  build — tests exercise `--engine anthropic-batch`/`openrouter-batch`
   *  through a fake in-memory driver, no API key or network needed. */
  readonly driver?: BatchDriver
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
  const store = new BatchStore({ stateDir: join(target, ".distill") })
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
    const apiKey = engine.envKey ? process.env[engine.envKey] : undefined
    if (engine.envKey && !apiKey && !deps.driver) {
      return fail(`distill engine "${engine.id}" needs ${engine.envKey} in the environment.`, 2)
    }
    distiller = engine.create({
      ...(apiKey ? { apiKey } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      onUsage: usage.record,
      ...(parsed.lang ? { lang: parsed.lang } : {}),
      store,
      ...(deps.driver ? { driver: deps.driver } : {}),
      ...(parsed.batchId ? { batchId: parsed.batchId } : {}),
    })
    engineLabel = engine.id
  }
  // Narrow once, into a variable (not a boolean) — narrowing a `DistillPort`
  // through a type-predicate call doesn't survive being captured as a plain
  // boolean and re-checked later.
  const batchDistiller = hasDistillMany(distiller) ? distiller : undefined

  const fs = new NodeFsAdapter({ root: target })
  const all = await readSources(target)
  if (all.length === 0) return fail("no sources found under sources/ — run import-web first.", 2)

  // Resume set. Under a lens: the `(source, lens)` ledger (independent cadence
  // per lens). Without a lens: the legacy entry-scan (unchanged back-compat).
  const index = new DistillIndex({ fs })
  let batch: RawSource[]
  let poolLength: number
  if (parsed.batchId) {
    // Re-attach: the exact set of sources originally submitted, recovered
    // from the store's own record of what it sent — not a fresh resume scan.
    const record = await store.load(parsed.batchId)
    if (!record) {
      return fail(`--batch-id ${parsed.batchId}: no batch found under ${target}/.distill`, 2)
    }
    const byId = new Map(all.map(s => [s.id, s]))
    batch = []
    for (const req of record.requests) {
      const src = byId.get(req.customId)
      if (src) batch.push(src)
      else process.stdout.write(`  ! ${req.customId} — source no longer found on disk, skipping\n`)
    }
    poolLength = batch.length
  } else {
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
    poolLength = pool.length
    batch = parsed.max !== undefined ? pool.slice(0, parsed.max) : pool
  }

  process.stdout.write(
    `distill → ${target}\n` +
      `  engine:   ${engineLabel}\n` +
      (lens ? `  lens:     ${lens.id} (aspect:${lensAspect(lens)})\n` : "") +
      (parsed.batchId
        ? `  batch-id: ${parsed.batchId} — re-attaching, skipping submit\n`
        : `  sources:  ${all.length} total · ${all.length - poolLength} already distilled · ${poolLength} to do\n` +
          `  this run: ${batch.length}${parsed.max !== undefined ? ` (--max ${parsed.max})` : ""}\n`) +
      (batchDistiller ? "  note:     --throttle is ignored for batch engines\n" : "")
  )
  if (batch.length === 0) {
    process.stdout.write("  nothing to do.\n")
    return 0
  }

  const layout = await readEntryLayout(target)
  let totalEntries = 0

  if (batchDistiller) {
    const inputs = batch.map(raw => ({
      key: raw.id,
      input: toDistillInput(lens ? applyLens(raw, lens) : raw),
    }))
    const resultsByKey = await batchDistiller.distillMany(inputs)
    for (const raw of batch) {
      const src = lens ? applyLens(raw, lens) : raw
      const items = resultsByKey.get(raw.id)
      if (items === undefined) {
        process.stdout.write(`  ! ${raw.id} — not distilled this run (errored or expired in the batch)\n`)
        continue
      }
      const oneShotRunner = new DistillRunner({
        fs,
        clock: systemClock,
        ...(layout ? { layout } : {}),
        distiller: { distill: async () => items },
      })
      try {
        const report = await oneShotRunner.run(src)
        totalEntries += report.entryPaths.length
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
  } else {
    const runner = new DistillRunner({
      fs,
      clock: systemClock,
      ...(layout ? { layout } : {}),
      distiller,
    })
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
  }
  process.stdout.write(`\n${totalEntries} refined entries written (each with sources:[<id>] provenance).\n`)
  await usage.flush()
  return 0
}
