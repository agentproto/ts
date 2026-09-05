/**
 * defineAppConfig — the layered YAML config kit for agentproto apps,
 * generalized from @agstudio/book-config (collection.yaml → order entry →
 * book.yaml) to any app's `{itemsKey}` / `{defaultsKey}` vocabulary.
 *
 * Precedence (lowest → highest, the same chain book-config resolves):
 *
 *   1. app-level defaults — `app.yaml` under `defaultsKey` (e.g. `defaults:`)
 *   2. the app `items[]` entry whose `id` matches the item — supplies the
 *      item's position in the run order plus per-item overrides
 *   3. the item file itself — `config/items/<id>.yaml`, which wins on
 *      conflict (a file that narrows its slice must not inherit the
 *      app-wide default, same as book.yaml over collection.order[n])
 *
 * Merge semantics are deterministic and documented on `mergeValues`:
 * objects deep-merge key-by-key, arrays REPLACE (order is meaningful
 * configuration, not something to interleave), `undefined` overlays are
 * skipped. `precedence` may permute the three layers if an app wants the
 * opposite conflict resolution.
 *
 * No `any`, no `as` casts: generic values cross `pick` (an Object.entries
 * walk) and runtime type guards.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { parse } from "yaml"
import { z } from "zod"
import {
  AppConfigError,
  canonicalJson,
  isPlainObject,
  mergeLayers,
  normalizePrecedence,
  pick,
  sha256Hex,
  sortedCopy,
  type Layer,
} from "./merge.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppKitDefinition<
  A extends z.ZodObject<z.ZodRawShape>,
  I extends z.ZodObject<z.ZodRawShape & { id: z.ZodString }>,
> {
  /** Schema for the whole app file (app.yaml). */
  app: A
  /** Schema for one item — MUST carry `id: z.string()`. */
  item: I
  /** Key on the app value holding the ordered item entries (e.g. `items`). */
  itemsKey: string
  /** Key on the app value holding app-level defaults (e.g. `defaults`). */
  defaultsKey?: string
  /** Layer order, lowest → highest. Default: defaults → entry → item. */
  precedence?: readonly Layer[]
}

export interface LoadOptions {
  /** App file, relative to rootDir. Default `config/app.yaml`. */
  appFile?: string
  /** Item file glob, relative to rootDir. Default `config/items/*.yaml`. */
  itemsGlob?: string
}

export interface ResolvedItem<I = Record<string, unknown>> {
  id: string
  /** The merged, schema-validated value (item schema output). */
  value: I
  /** Item file path, absolute. */
  itemPath: string
  /** Position in the app's items[] entry list, or null when file-only. */
  entryIndex: number | null
}

/** The resolved app. Defaults erase values to `Record<string, unknown>` so gate/template authors get a loose, cast-free surface. */
export interface Resolved<A = Record<string, unknown>, I = Record<string, unknown>> {
  rootDir: string
  appFile: string
  /** The app file, schema-validated (zod output of `app`). */
  app: A
  items: Map<string, ResolvedItem<I>>
  /** Item ids in run order: entry-listed items first (entry order), then file-only items by filename. */
  order: string[]
}

export interface JsonSchemaPair {
  app: z.core.JSONSchema.BaseSchema
  item: z.core.JSONSchema.BaseSchema
}

export interface GateFinding {
  message: string
  item?: string
}

export interface GateRule {
  id: string
  level: "error" | "warn"
  test: (resolved: Resolved) => GateFinding[]
}

export interface GateResultFinding extends GateFinding {
  rule: string
  level: "error" | "warn"
}

export interface GateResult {
  ok: boolean
  findings: GateResultFinding[]
}

export interface ContractDrift {
  id: string
  file: string
  reason: "missing" | "drifted"
}

export type VerifyLevel = "error" | "warn" | "skipped"

export interface VerifyFinding {
  scope: string
  level: VerifyLevel
  message: string
  item?: string
}

export interface VerifyReport {
  ok: boolean
  findings: VerifyFinding[]
  summary: { errors: number; warnings: number; skipped: number }
}

/** A caller scope function: its key in `scopes` is the scope it reports under. */
export type ScopeFn = (resolved: Resolved) => VerifyFinding[]

export interface VerifyInput {
  rules?: readonly GateRule[]
  template?: (item: ResolvedItem) => object
  contractsDir?: string
  scopes?: Record<string, ScopeFn>
}

export const DEFAULT_APP_FILE = "config/app.yaml"
export const DEFAULT_ITEMS_GLOB = "config/items/*.yaml"
export const DEFAULT_CONTRACTS_DIR = "contracts"

// ---------------------------------------------------------------------------
// Kit
// ---------------------------------------------------------------------------

export type AppKit<
  A extends z.ZodObject<z.ZodRawShape>,
  I extends z.ZodObject<z.ZodRawShape & { id: z.ZodString }>,
> = {
  readonly def: AppKitDefinition<A, I>
  load(rootDir: string, opts?: LoadOptions): Resolved<z.output<A>, z.output<I>>
  jsonSchemas(): JsonSchemaPair
  writeSchemas(dir: string): void
  contracts(input: {
    resolved: Resolved<z.output<A>, z.output<I>>
    template: (item: ResolvedItem<z.output<I>>) => object
    dir: string
  }): { write(): void; check(): ContractDrift[] }
  gates(resolved: Resolved<z.output<A>, z.output<I>>, rules: readonly GateRule[]): GateResult
  verify(resolved: Resolved<z.output<A>, z.output<I>>, input?: VerifyInput): VerifyReport
}

/**
 * The loose kit surface the CLI programs against — same methods, values
 * erased to `Record<string, unknown>`. A concrete kit is assignable to it
 * (method params compare bivariantly).
 */
export type AnyKit = {
  load(rootDir: string, opts?: LoadOptions): Resolved
  jsonSchemas(): JsonSchemaPair
  writeSchemas(dir: string): void
  contracts(input: {
    resolved: Resolved
    template: (item: ResolvedItem) => object
    dir: string
  }): { write(): void; check(): ContractDrift[] }
  gates(resolved: Resolved, rules: readonly GateRule[]): GateResult
  verify(resolved: Resolved, input?: VerifyInput): VerifyReport
}

export function defineAppConfig<
  A extends z.ZodObject<z.ZodRawShape>,
  I extends z.ZodObject<z.ZodRawShape & { id: z.ZodString }>,
>(def: AppKitDefinition<A, I>): AppKit<A, I> {
  const precedence = normalizePrecedence(def.precedence)

  function load(rootDir: string, opts: LoadOptions = {}): Resolved<z.output<A>, z.output<I>> {
    const appFile = join(rootDir, opts.appFile ?? DEFAULT_APP_FILE)
    const rawApp: unknown = parseYamlFile(appFile)
    const app = def.app.parse(rawApp)
    // Merge layers read from the RAW yaml: the app schema may strip keys it
    // doesn't declare (e.g. arbitrary per-entry overrides), and stripping
    // would silently drop them from the merge. Validation still ran above.
    if (!isPlainObject(rawApp)) {
      throw new AppConfigError(`${relative(rootDir, appFile)}: app file must be an object`)
    }

    let defaults: Record<string, unknown> = {}
    if (def.defaultsKey !== undefined) {
      const picked = pick(rawApp, def.defaultsKey)
      if (picked.found && picked.value !== undefined) {
        if (!isPlainObject(picked.value)) {
          throw new AppConfigError(
            `${relative(rootDir, appFile)}: "${def.defaultsKey}" must be an object, got ${typeof picked.value}`,
          )
        }
        defaults = picked.value
      }
    }

    let entries: readonly object[] = []
    const pickedEntries = pick(rawApp, def.itemsKey)
    if (pickedEntries.found && pickedEntries.value !== undefined) {
      if (!Array.isArray(pickedEntries.value)) {
        throw new AppConfigError(
          `${relative(rootDir, appFile)}: "${def.itemsKey}" must be an array, got ${typeof pickedEntries.value}`,
        )
      }
      for (const e of pickedEntries.value) {
        if (!isPlainObject(e)) {
          throw new AppConfigError(
            `${relative(rootDir, appFile)}: every "${def.itemsKey}" entry must be an object`,
          )
        }
      }
      entries = pickedEntries.value
    }

    const files = resolveItemFiles(rootDir, opts.itemsGlob ?? DEFAULT_ITEMS_GLOB)
    const items = new Map<string, ResolvedItem<z.output<I>>>()
    for (const itemPath of files) {
      const raw: unknown = parseYamlFile(itemPath)
      if (!isPlainObject(raw)) {
        throw new AppConfigError(
          `${relative(rootDir, itemPath)}: item file must be an object`,
        )
      }
      const idPick = pick(raw, "id")
      if (!idPick.found || typeof idPick.value !== "string" || idPick.value === "") {
        throw new AppConfigError(
          `${relative(rootDir, itemPath)}: item file must carry a non-empty string "id"`,
        )
      }
      const id = idPick.value
      const entryIndex = entries.findIndex((e) => {
        const eid = pick(e, "id")
        return eid.found && eid.value === id
      })
      const entry = entryIndex >= 0 ? entries[entryIndex] : {}
      const byLayer: Record<Layer, unknown> = { defaults, entry, item: raw }
      const merged = mergeLayers(precedence.map((layer) => byLayer[layer]))
      const value = def.item.parse(merged)
      items.set(id, { id, value, itemPath, entryIndex: entryIndex >= 0 ? entryIndex : null })
    }

    if (items.size !== files.length) {
      throw new AppConfigError(`duplicate item ids across ${files.length} item files`)
    }

    const all = [...items.values()]
    const withEntries = all
      .filter((it) => it.entryIndex !== null)
      .sort((a, b) => (a.entryIndex ?? 0) - (b.entryIndex ?? 0))
      .map((it) => it.id)
    const fileOnly = all
      .filter((it) => it.entryIndex === null)
      .sort((a, b) => basename(a.itemPath).localeCompare(basename(b.itemPath)))
      .map((it) => it.id)

    return {
      rootDir,
      appFile,
      app,
      items,
      order: [...withEntries, ...fileOnly],
    }
  }

  function jsonSchemas(): JsonSchemaPair {
    return {
      app: z.toJSONSchema(def.app, { io: "input" }),
      item: z.toJSONSchema(def.item, { io: "input" }),
    }
  }

  function writeSchemas(dir: string): void {
    mkdirSync(dir, { recursive: true })
    const { app, item } = jsonSchemas()
    writeFileSync(join(dir, "app.schema.json"), JSON.stringify(app, null, 2) + "\n")
    writeFileSync(join(dir, "item.schema.json"), JSON.stringify(item, null, 2) + "\n")
  }

  function contracts(input: {
    resolved: Resolved<z.output<A>, z.output<I>>
    template: (item: ResolvedItem<z.output<I>>) => object
    dir: string
  }): { write(): void; check(): ContractDrift[] } {
    const { resolved, template, dir } = input

    function build(): { id: string; file: string; text: string; sha: string }[] {
      return resolved.order.map((id) => {
        const item = resolved.items.get(id)
        if (item === undefined) throw new AppConfigError(`resolved item "${id}" disappeared`)
        const obj = template(item)
        const text = JSON.stringify(sortedCopy(obj), null, 2) + "\n"
        const sha = sha256Hex(canonicalJson(obj))
        return { id, file: join(dir, `${id}.contract.json`), text, sha }
      })
    }

    return {
      write(): void {
        mkdirSync(dir, { recursive: true })
        for (const c of build()) writeFileSync(c.file, c.text)
      },
      check(): ContractDrift[] {
        const drift: ContractDrift[] = []
        for (const c of build()) {
          if (!existsSync(c.file)) {
            drift.push({ id: c.id, file: c.file, reason: "missing" })
            continue
          }
          const onDisk: unknown = JSON.parse(readFileSync(c.file, "utf8"))
          if (sha256Hex(canonicalJson(onDisk)) !== c.sha) {
            drift.push({ id: c.id, file: c.file, reason: "drifted" })
          }
        }
        return drift
      },
    }
  }

  function gates(resolved: Resolved<z.output<A>, z.output<I>>, rules: readonly GateRule[]): GateResult {
    const findings: GateResultFinding[] = []
    for (const rule of rules) {
      for (const f of rule.test(resolved)) {
        findings.push({
          rule: rule.id,
          level: rule.level,
          message: f.message,
          ...(f.item !== undefined ? { item: f.item } : {}),
        })
      }
    }
    return { ok: !findings.some((f) => f.level === "error"), findings }
  }

  function verify(resolved: Resolved<z.output<A>, z.output<I>>, input: VerifyInput = {}): VerifyReport {
    const findings: VerifyFinding[] = []

    if (input.rules !== undefined) {
      const result = gates(resolved, input.rules)
      for (const f of result.findings) {
        findings.push({
          scope: "gates",
          level: f.level,
          message: `${f.rule}: ${f.message}`,
          ...(f.item !== undefined ? { item: f.item } : {}),
        })
      }
    }

    if (input.template !== undefined) {
      const dir = input.contractsDir ?? join(resolved.rootDir, DEFAULT_CONTRACTS_DIR)
      const drift = contracts({ resolved, template: input.template, dir }).check()
      for (const d of drift) {
        findings.push({
          scope: "contracts",
          level: "error",
          message: `${relative(resolved.rootDir, d.file)}: ${d.reason === "missing" ? "missing on disk" : "drifted from the regenerated contract"}`,
          item: d.id,
        })
      }
    }

    for (const [scope, fn] of Object.entries(input.scopes ?? {})) {
      for (const f of fn(resolved)) {
        findings.push({
          scope,
          level: f.level,
          message: f.message,
          ...(f.item !== undefined ? { item: f.item } : {}),
        })
      }
    }

    const summary = {
      errors: findings.filter((f) => f.level === "error").length,
      warnings: findings.filter((f) => f.level === "warn").length,
      skipped: findings.filter((f) => f.level === "skipped").length,
    }
    return { ok: summary.errors === 0, findings, summary }
  }

  return { def, load, jsonSchemas, writeSchemas, contracts, gates, verify }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function parseYamlFile(path: string): unknown {
  if (!existsSync(path)) {
    throw new AppConfigError(`config file not found: ${path}`)
  }
  try {
    return parse(readFileSync(path, "utf8"))
  } catch (err) {
    throw new AppConfigError(`${path} could not be parsed as YAML: ${String(err)}`)
  }
}

/**
 * Resolve an items glob. Supports a single-directory pattern like
 * `config/items/*.yaml` and a recursive doublestar pattern (a leading
 * doublestar directory segment). Output is sorted for determinism.
 */
export function resolveItemFiles(root: string, glob: string): string[] {
  const recursive = glob.startsWith("**/")
  const lastSlash = glob.lastIndexOf("/")
  const pattern = lastSlash >= 0 ? glob.slice(lastSlash + 1) : glob
  const dirPart = lastSlash >= 0 ? glob.slice(0, lastSlash) : ""
  const base = dirPart === "" ? root : join(root, dirPart.replace(/^\*\*\//, ""))
  if (!existsSync(base)) {
    throw new AppConfigError(`items directory not found: ${base} (glob "${glob}")`)
  }
  const ext = pattern.startsWith("*.") ? pattern.slice(1) : null
  if (ext === null) {
    throw new AppConfigError(`unsupported items glob "${glob}" (expected *.yaml / *.yml)`)
  }
  const files = recursive ? walkYaml(base, ext) : listYaml(base, ext)
  return files.sort()
}

function listYaml(dir: string, ext: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(ext))
    .map((name) => join(dir, name))
    .filter((p) => statSync(p).isFile())
}

function walkYaml(dir: string, ext: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walkYaml(p, ext))
    else if (name.endsWith(ext)) out.push(p)
  }
  return out
}
