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
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
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
  type MergeOptions,
} from "./merge.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The kit-owned minimal schema surface the public generics constrain on.
 *
 * A consumer passes ANY parser satisfying this shape — a zod schema from
 * whichever zod copy/version it pins, or a hand-rolled `{ parse }`. The
 * public surface deliberately mentions NO zod types: zod's internals
 * (`$ZodType`, `exactPartial`, …) shift between minors, so a constraint
 * like `A extends z.ZodObject<z.ZodRawShape>` would reject every consumer
 * whose zod build differs from the kit's own tree (TS2741 at the call
 * site). zod remains a peerDependency; only the *structural* contract is
 * public.
 */
export interface SchemaLike<Out> {
  parse(value: unknown): Out
}

/**
 * How an `items[]` entry matches an item file. Either a field pair —
 * `{ entry: "n", item: "n" }` compares `entry[entryField]` with
 * `item[itemField]` — or a predicate over the raw entry and item objects.
 * Default: the entry's `id` equals the item's `id`.
 */
export type MatchKey =
  | { entry: string; item: string }
  | ((entry: Record<string, unknown>, item: Record<string, unknown>) => boolean)

/**
 * The kit definition. `AOut` / `IOut` are the OUTPUT types the app and item
 * schemas parse into — inferred from the `parse` return of whatever
 * `SchemaLike` you pass (a zod schema's zod output type, or anything else),
 * never from zod's own types, so any zod minor works.
 */
export interface AppKitDefinition<
  AOut extends Record<string, unknown>,
  IOut extends Record<string, unknown>,
> {
  /** Schema for the whole app file (app.yaml). */
  app: SchemaLike<AOut>
  /**
   * Schema for one item. An item file without a non-empty string `id` is
   * keyed by its per-item directory name (`manuscripts/<dir>/book.yaml` → the
   * directory basename) or, for a flat glob, its file basename.
   */
  item: SchemaLike<IOut>
  /** Key on the app value holding the ordered item entries (e.g. `items`). */
  itemsKey: string
  /**
   * Key on the app value holding app-level defaults — may be a nested dot
   * path (`"defaults"` or `"presets.default"`).
   */
  defaultsKey?: string
  /** Entry ↔ item matching (see `MatchKey`). Default: `entry.id === item.id`. */
  matchKey?: MatchKey
  /**
   * Keyed-array merge: `mergeArraysBy.knowledge = "workspace"` makes the
   * `knowledge` array merge by its entries' `workspace` field — an overlay
   * entry with the same key REPLACES the base entry, others append — instead
   * of the default replace-wholesale.
   */
  mergeArraysBy?: Record<string, string>
  /**
   * Per-field projection over the merged raw value, before the item schema
   * parses it (e.g. `accent: book.cover?.accent ?? collection.cover.accents[book.vertical]`).
   * Return the object `item.parse` should validate. The projected object is
   * exposed verbatim on `ResolvedItem.projected` — the item schema's output
   * strips keys it does not declare, so derived fields survive there.
   */
  project?: (
    merged: Record<string, unknown>,
    ctx: ProjectContext<AOut>,
  ) => Record<string, unknown>
  /** Layer order, lowest → highest. Default: defaults → entry → item. */
  precedence?: readonly Layer[]
}

/** Context handed to a `project` hook for one item. */
export interface ProjectContext<A = Record<string, unknown>> {
  /** The item's resolved key (see `AppKitDefinition.item`). */
  id: string
  /** Item file path, absolute. */
  itemPath: string
  /** Directory containing the item file, absolute. */
  dir: string
  /** The app file, schema-validated (zod output of `app`). */
  app: A
  /** The matched raw `items[]` entry, or null when the item is file-only. */
  entry: Record<string, unknown> | null
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
  /**
   * When the kit definition has a `project` hook: the projected object
   * BEFORE the item schema parsed it. The item schema's output (`value`)
   * strips keys it does not declare — derived fields projected by `project`
   * survive verbatim here instead. Absent when there is no `project` hook.
   */
  projected?: Record<string, unknown>
  /** Item file path, absolute. */
  itemPath: string
  /** Directory containing the item file, absolute. */
  dir: string
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

/**
 * Consumer-owned JSON-Schema conversion for `jsonSchemas(opts)`.
 *
 * By default the kit converts with ITS OWN zod copy (`z.toJSONSchema`), whose
 * output shifts between zod minors (e.g. a nullable field emits
 * `type: ["string","null"]` on one minor, `anyOf` on another). A consumer that
 * commits its generated schemas to git cannot delegate the emit — every
 * regeneration would diff against its pinned zod. Supplying `toJSONSchema`
 * hands the conversion to the consumer, so the emitted JSON Schema is exactly
 * what the consumer's own zod produces. Same principle as the kit-owned
 * `SchemaLike` type: the kit must not own what the consumer pins.
 */
export interface JsonSchemasOptions {
  /**
   * Convert one schema to JSON Schema. Called once for `"app"` and once for
   * `"item"`, with the exact `SchemaLike` the kit definition carries.
   * When supplied, it replaces the kit's own conversion entirely (including
   * for non-zod schemas, which otherwise throw a clear `AppConfigError`).
   */
  toJSONSchema?(schema: SchemaLike<unknown>, label: "app" | "item"): JsonSchemaPair["app"]
}

export interface GateFinding {
  message: string
  item?: string
  /** Free-form attributes an app attaches to a finding (e.g. `book`, `chapter`). */
  attrs?: Record<string, string>
  /**
   * Per-finding level override. Default: the rule's `level`. A rule that
   * degrades some findings to warnings sets `"warn"` here.
   */
  level?: "error" | "warn"
}

/** Context handed to a `GateRule.test`. */
export interface GateContext<R extends Resolved = Resolved> {
  /** The resolved app the gates run over. */
  resolved: R
  /**
   * The item the rule is scoped to, when the runner supplies one; rules that
   * sweep all items read them off `resolved` instead.
   */
  item?: ResolvedItem
  /**
   * Read an artifact file relative to `resolved.rootDir` (rejects with
   * `AppConfigError` when it escapes the root or does not exist).
   */
  readArtifact(relPath: string): Promise<string>
  /** A parsed contract object for `ctx.item`, when the runner supplies one. */
  contract?: unknown
}

export interface GateRule<R extends Resolved = Resolved> {
  id: string
  level: "error" | "warn"
  test: (ctx: GateContext<R>) => GateFinding[] | Promise<GateFinding[]>
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
  /** Free-form attributes an app attaches to a finding (e.g. `book`, `chapter`). */
  attrs?: Record<string, string>
}

export interface VerifyReport {
  ok: boolean
  findings: VerifyFinding[]
  summary: { errors: number; warnings: number; skipped: number }
}

/**
 * A caller scope function over the app's own resolved type: its key in
 * `scopes` is the scope it reports under. It receives a `ScopeContext`
 * handle (the same `readArtifact` root-escape guard gate rules get), so an
 * umbrella scope can read artifacts while emitting error/warn/skipped
 * findings at its own per-finding levels. May be async — `verify` awaits
 * it. Existing sync single-argument signatures keep working (the context
 * argument is additive at the call site).
 */
export type ScopeFn<R extends Resolved = Resolved> = (
  resolved: R,
  ctx: ScopeContext<R>,
) => VerifyFinding[] | Promise<VerifyFinding[]>

/** Context handed to a `ScopeFn` alongside the resolved app. */
export interface ScopeContext<R extends Resolved = Resolved> {
  /** The resolved app the scopes run over. */
  resolved: R
  /**
   * Read an artifact file relative to `resolved.rootDir` (rejects with
   * `AppConfigError` when it escapes the root or does not exist).
   */
  readArtifact(relPath: string): Promise<string>
}

export interface VerifyInput<R extends Resolved = Resolved> {
  rules?: readonly GateRule<R>[]
  template?: (item: ResolvedItem) => object
  contractsDir?: string
  scopes?: Record<string, ScopeFn<R>>
}

export const DEFAULT_APP_FILE = "config/app.yaml"
export const DEFAULT_ITEMS_GLOB = "config/items/*.yaml"
export const DEFAULT_CONTRACTS_DIR = "contracts"

// ---------------------------------------------------------------------------
// JSON Schema conversion
// ---------------------------------------------------------------------------

/** Structural guard: does the schema expose zod's `_zod` internals, so `z.toJSONSchema` can walk it? */
function isZodSchema(schema: SchemaLike<unknown>): schema is z.ZodType {
  return "_zod" in schema
}

/**
 * Convert a schema to JSON Schema. A `SchemaLike` that is not a zod schema
 * cannot be introspected — that is a CLEAR kit error, not a type constraint:
 * the public generic surface stays zod-free, and apps that pass a
 * hand-rolled `{ parse }` emit their JSON Schemas themselves.
 */
function schemaToJsonSchema(schema: SchemaLike<unknown>, label: string): JsonSchemaPair["app"] {
  if (!isZodSchema(schema)) {
    throw new AppConfigError(
      `jsonSchemas(): the ${label} schema is not a zod schema, so the kit cannot convert it to JSON Schema. Pass a zod schema (zod is this kit's peer dependency) or emit the JSON Schema yourself.`,
    )
  }
  return z.toJSONSchema(schema, { io: "input" })
}

// ---------------------------------------------------------------------------
// Kit
// ---------------------------------------------------------------------------

export type AppKit<
  AOut extends Record<string, unknown>,
  IOut extends Record<string, unknown>,
> = {
  readonly def: AppKitDefinition<AOut, IOut>
  load(rootDir: string, opts?: LoadOptions): Resolved<AOut, IOut>
  jsonSchemas(opts?: JsonSchemasOptions): JsonSchemaPair
  writeSchemas(dir: string): void
  contracts(input: {
    resolved: Resolved<AOut, IOut>
    template: (item: ResolvedItem<IOut>) => object
    dir: string
  }): { write(): void; check(): ContractDrift[] }
  gates(
    resolved: Resolved<AOut, IOut>,
    rules: readonly GateRule<Resolved<AOut, IOut>>[],
  ): Promise<GateResult>
  verify(
    resolved: Resolved<AOut, IOut>,
    input?: VerifyInput<Resolved<AOut, IOut>>,
  ): Promise<VerifyReport>
}

/**
 * The loose kit surface the CLI programs against — same methods, values
 * erased to `Record<string, unknown>`. A concrete kit is assignable to it
 * (method params compare bivariantly).
 */
export type AnyKit = {
  load(rootDir: string, opts?: LoadOptions): Resolved
  jsonSchemas(opts?: JsonSchemasOptions): JsonSchemaPair
  writeSchemas(dir: string): void
  contracts(input: {
    resolved: Resolved
    template: (item: ResolvedItem) => object
    dir: string
  }): { write(): void; check(): ContractDrift[] }
  gates(resolved: Resolved, rules: readonly GateRule[]): Promise<GateResult>
  verify(resolved: Resolved, input?: VerifyInput): Promise<VerifyReport>
}

export function defineAppConfig<
  AOut extends Record<string, unknown>,
  IOut extends Record<string, unknown>,
>(def: AppKitDefinition<AOut, IOut>): AppKit<AOut, IOut> {
  const precedence = normalizePrecedence(def.precedence)

  function load(rootDir: string, opts: LoadOptions = {}): Resolved<AOut, IOut> {
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
      const resolved = resolveDefaultsPath(rawApp, def.defaultsKey, rootDir, appFile)
      if (resolved.value !== undefined) {
        if (isPlainObject(resolved.value)) {
          defaults = resolved.value
        } else if (Array.isArray(resolved.value) && resolved.mount !== undefined) {
          // An array leaf (e.g. defaultsKey "knowledge.defaults") mounts under
          // its parent segment so mergeArraysBy can key it by field name.
          defaults = { [resolved.mount]: resolved.value }
        } else {
          throw new AppConfigError(
            `${relative(rootDir, appFile)}: "${def.defaultsKey}" must be an object, got ${typeof resolved.value}`,
          )
        }
      }
    }

    let entries: readonly Record<string, unknown>[] = []
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

    const fileInfos = resolveItemFileInfos(rootDir, opts.itemsGlob ?? DEFAULT_ITEMS_GLOB)
    const items = new Map<string, ResolvedItem<IOut>>()
    const mergeOpts: MergeOptions = def.mergeArraysBy !== undefined ? { arraysBy: def.mergeArraysBy } : {}
    for (const info of fileInfos) {
      const raw: unknown = parseYamlFile(info.path)
      if (!isPlainObject(raw)) {
        throw new AppConfigError(
          `${relative(rootDir, info.path)}: item file must be an object`,
        )
      }
      const idPick = pick(raw, "id")
      const id =
        idPick.found && typeof idPick.value === "string" && idPick.value !== ""
          ? idPick.value
          : info.key
      const entryIndex = entries.findIndex((e) => entryMatches(def.matchKey, e, raw))
      const entry = entryIndex >= 0 ? entries[entryIndex] : {}
      const byLayer: Record<Layer, unknown> = { defaults, entry, item: raw }
      let merged = mergeLayers(precedence.map((layer) => byLayer[layer]), mergeOpts)
      let projected: Record<string, unknown> | undefined
      if (def.project !== undefined) {
        if (!isPlainObject(merged)) {
          throw new AppConfigError(
            `${relative(rootDir, info.path)}: merged item value must be an object for project()`,
          )
        }
        projected = def.project(merged, {
          id,
          itemPath: info.path,
          dir: info.dir,
          app,
          entry: entryIndex >= 0 && entry !== undefined ? entry : null,
        })
        merged = projected
      }
      const value = def.item.parse(merged)
      items.set(id, {
        id,
        value,
        ...(projected !== undefined ? { projected } : {}),
        itemPath: info.path,
        dir: info.dir,
        entryIndex: entryIndex >= 0 ? entryIndex : null,
      })
    }

    if (items.size !== fileInfos.length) {
      throw new AppConfigError(`duplicate item keys across ${fileInfos.length} item files`)
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

  function jsonSchemas(opts?: JsonSchemasOptions): JsonSchemaPair {
    const consumer = opts?.toJSONSchema
    return {
      app: consumer ? consumer(def.app, "app") : schemaToJsonSchema(def.app, "app"),
      item: consumer ? consumer(def.item, "item") : schemaToJsonSchema(def.item, "item"),
    }
  }

  function writeSchemas(dir: string): void {
    mkdirSync(dir, { recursive: true })
    const { app, item } = jsonSchemas()
    writeFileSync(join(dir, "app.schema.json"), JSON.stringify(app, null, 2) + "\n")
    writeFileSync(join(dir, "item.schema.json"), JSON.stringify(item, null, 2) + "\n")
  }

  function contracts(input: {
    resolved: Resolved<AOut, IOut>
    template: (item: ResolvedItem<IOut>) => object
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

  async function gates(
    resolved: Resolved<AOut, IOut>,
    rules: readonly GateRule<Resolved<AOut, IOut>>[],
  ): Promise<GateResult> {
    const findings: GateResultFinding[] = []
    const readArtifact = makeReadArtifact(resolved.rootDir)
    for (const rule of rules) {
      const ctx: GateContext<Resolved<AOut, IOut>> = { resolved, readArtifact }
      const out = await rule.test(ctx)
      for (const f of out) {
        findings.push({
          rule: rule.id,
          level: f.level ?? rule.level,
          message: f.message,
          ...(f.item !== undefined ? { item: f.item } : {}),
          ...(f.attrs !== undefined ? { attrs: f.attrs } : {}),
        })
      }
    }
    return { ok: !findings.some((f) => f.level === "error"), findings }
  }

  async function verify(
    resolved: Resolved<AOut, IOut>,
    input: VerifyInput<Resolved<AOut, IOut>> = {},
  ): Promise<VerifyReport> {
    const findings: VerifyFinding[] = []

    if (input.rules !== undefined) {
      const result = await gates(resolved, input.rules)
      for (const f of result.findings) {
        findings.push({
          scope: "gates",
          level: f.level,
          message: `${f.rule}: ${f.message}`,
          ...(f.item !== undefined ? { item: f.item } : {}),
          ...(f.attrs !== undefined ? { attrs: f.attrs } : {}),
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

    const scopeCtx: ScopeContext<Resolved<AOut, IOut>> = {
      resolved,
      readArtifact: makeReadArtifact(resolved.rootDir),
    }
    for (const [scope, fn] of Object.entries(input.scopes ?? {})) {
      for (const f of await fn(resolved, scopeCtx)) {
        findings.push({
          scope,
          level: f.level,
          message: f.message,
          ...(f.item !== undefined ? { item: f.item } : {}),
          ...(f.attrs !== undefined ? { attrs: f.attrs } : {}),
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

/** Resolve a defaults key, which may be a nested dot path (`"presets.default"`).
 * Returns the leaf value plus, for array leaves, the parent segment to mount
 * the array under (so mergeArraysBy can key it by field name). */
export function resolveDefaultsPath(
  rawApp: object,
  defaultsKey: string,
  rootDir: string,
  appFile: string,
): { value: unknown; mount?: string } {
  const segments = defaultsKey.split(".")
  let current: unknown = rawApp
  let walked = ""
  for (const segment of segments) {
    walked = walked === "" ? segment : `${walked}.${segment}`
    if (!isPlainObject(current)) {
      throw new AppConfigError(
        `${relative(rootDir, appFile)}: "${walked}" (from defaultsKey "${defaultsKey}") must be an object, got ${typeof current}`,
      )
    }
    const p = pick(current, segment)
    if (!p.found || p.value === undefined) return { value: undefined }
    current = p.value
  }
  const parent = segments.length > 1 ? segments[segments.length - 2] : undefined
  return parent !== undefined ? { value: current, mount: parent } : { value: current }
}

/** Compare one `items[]` entry with one raw item under the kit's matchKey. */
export function entryMatches(matchKey: MatchKey | undefined, entry: object, item: object): boolean {
  if (matchKey === undefined) {
    const eid = pick(entry, "id")
    const iid = pick(item, "id")
    return eid.found && iid.found && eid.value === iid.value
  }
  if (typeof matchKey === "function") {
    return isPlainObject(entry) && isPlainObject(item) && matchKey(entry, item)
  }
  const e = pick(entry, matchKey.entry)
  const i = pick(item, matchKey.item)
  return e.found && i.found && canonicalJson(e.value) === canonicalJson(i.value)
}

/** Read an artifact relative to the resolved root, without letting it escape. */
function makeReadArtifact(rootDir: string): (relPath: string) => Promise<string> {
  return (relPath: string): Promise<string> => {
    const abs = resolve(rootDir, relPath)
    const rel = relative(rootDir, abs)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return Promise.reject(new AppConfigError(`artifact path escapes rootDir: ${relPath}`))
    }
    try {
      return Promise.resolve(readFileSync(abs, "utf8"))
    } catch {
      return Promise.reject(new AppConfigError(`artifact not found: ${relPath}`))
    }
  }
}

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
 * One resolved item file: its absolute path, the directory containing it,
 * and the key the item will be registered under when its YAML carries no
 * string `id` (the per-item directory name for `dir/<dir>/file.yaml` globs, the
 * file basename otherwise).
 */
export interface ItemFileInfo {
  path: string
  dir: string
  key: string
}

/**
 * Resolve an items glob into item file infos. Supported shapes:
 *
 * - `config/items/x.yaml` with a `*` filename pattern — flat directory
 * - a leading doublestar segment — recursive
 * - `manuscripts/<dir>/book.yaml` — a fixed basename inside per-item directories
 * - `groups/team-<n>/item.yaml` — wildcard directory segments
 *
 * Output is sorted by path for determinism.
 */
export function resolveItemFileInfos(root: string, glob: string): ItemFileInfo[] {
  const lastSlash = glob.lastIndexOf("/")
  const pattern = lastSlash >= 0 ? glob.slice(lastSlash + 1) : glob
  const dirPart = lastSlash >= 0 ? glob.slice(0, lastSlash) : ""
  const dirs = resolveDirs(root, dirPart === "" ? [] : dirPart.split("/"), glob)
  const out: ItemFileInfo[] = []
  if (pattern.includes("*")) {
    if (!pattern.startsWith("*.")) {
      throw new AppConfigError(`unsupported items glob "${glob}" (expected *.yaml / *.yml)`)
    }
    const ext = pattern.slice(1)
    for (const d of dirs) {
      for (const p of listYaml(d, ext)) out.push({ path: p, dir: d, key: basename(p, ext) })
    }
  } else {
    for (const d of dirs) {
      const p = join(d, pattern)
      if (existsSync(p) && statSync(p).isFile()) out.push({ path: p, dir: d, key: basename(d) })
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** Resolve an items glob to file paths (see `resolveItemFileInfos`). */
export function resolveItemFiles(root: string, glob: string): string[] {
  return resolveItemFileInfos(root, glob).map((f) => f.path)
}

/** Expand directory segments — `**` (any depth), wildcard segments, literals — under root. */
function resolveDirs(root: string, segments: readonly string[], glob: string): string[] {
  let dirs = [root]
  for (const seg of segments) {
    if (seg === "**") {
      const next: string[] = []
      for (const d of dirs) {
        next.push(d)
        next.push(...descendantDirs(d))
      }
      dirs = next
    } else if (seg.includes("*")) {
      const re = segmentRegex(seg)
      const next: string[] = []
      for (const d of dirs) {
        for (const name of readdirSync(d).sort()) {
          const p = join(d, name)
          if (statSync(p).isDirectory() && re.test(name)) next.push(p)
        }
      }
      dirs = next
    } else {
      dirs = dirs.map((d) => join(d, seg)).filter((p) => {
        if (!existsSync(p) || !statSync(p).isDirectory()) {
          throw new AppConfigError(`items directory not found: ${p} (glob "${glob}")`)
        }
        return true
      })
    }
  }
  return dirs
}

/** A directory segment with `*` wildcards → an anchored name regex. */
function segmentRegex(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")
  return new RegExp(`^${escaped}$`)
}

function descendantDirs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      out.push(p)
      out.push(...descendantDirs(p))
    }
  }
  return out
}

function listYaml(dir: string, ext: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(ext))
    .map((name) => join(dir, name))
    .filter((p) => statSync(p).isFile())
}
