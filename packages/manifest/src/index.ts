/**
 * @agentproto/manifest — generic verbs for AIP doctypes.
 *
 * Every per-AIP package (`@agentproto/tool`, `@agentproto/driver`, …)
 * supplies a `DoctypeSpec` describing the per-package knobs (name,
 * AIP number, schema literal, path convention, validator, parser).
 * `createVerbs(spec)` returns the full lifecycle:
 *
 *   create(params, opts)            params → .md on disk
 *   load(path)                      .md on disk → handle
 *   list(dir, filter?)              walk → handle[]
 *   update(path, mutator)           load → patch → write back
 *   resolve(block, ctx?)            { inline | ref | file } → handle
 *   delete(path)                    fs.unlink
 *
 * Adding a new verb is a single place; every package picks it up
 * automatically — same model as `createDoctype` for the validation
 * pipeline.
 */

import { filterSerializable } from "@agentproto/define-doctype"
import matter from "gray-matter"
import type { Dirent } from "node:fs"
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { randomBytes } from "node:crypto"

/**
 * Per-package descriptor consumed by `createVerbs`.
 *
 * Generic over the params shape (input to `define`) and the handle
 * shape (output of `define`). For most AIPs `THandle` extends
 * `TParams` — handles are just frozen, defaulted definitions.
 */
export interface DoctypeSpec<
  TParams extends { id?: string; slug?: string; name?: string },
  THandle,
> {
  /** Lower-case singular: "tool", "driver", "operator". Used in errors. */
  name: string
  /** AIP number — surfaces in error messages for provenance. */
  aip: number
  /** Frontmatter `schema:` literal (e.g. "agentproto/tool/v1"). */
  schemaLiteral: string
  /**
   * Filename of the doctype's manifest. By default `<DOCTYPE>.md`,
   * derived from `name.toUpperCase()`. Override only when the
   * doctype's filename diverges from convention.
   */
  filename?: string
  /**
   * Path-of-handle convention. Given a validated handle, return the
   * workspace-relative path the manifest lives at. Examples:
   *   tool:     `(h) => `${h.id}/TOOL.md``
   *   policy:   `(h) => `policies/${h.slug}/POLICY.md``
   *   operator: `(h) => `${h.id}/OPERATOR.md``
   */
  pathOf(handle: THandle): string
  /** TS authoring path: validates params + applies defaults. */
  define(params: TParams): THandle
  /** MD authoring path: parses YAML+body. Throws on invalid frontmatter. */
  parse(source: string): { frontmatter: Record<string, unknown>; body: string }
  /**
   * Optional projection: handle → manifest-shaped frontmatter object.
   * Default: pass the params through `filterSerializable` (drops zod
   * schemas + functions). Override when the handle and frontmatter
   * shapes diverge non-trivially.
   */
  toFrontmatter?(params: TParams): Record<string, unknown>
}

export interface CreateOptions {
  /** Workspace-relative or absolute base directory. */
  dir: string
  /** Body markdown after the frontmatter. Defaults to a one-line stub. */
  body?: string
  /** Render only — don't write. Returns the rendered string. */
  dryRun?: boolean
}

export interface VerbResult<THandle> {
  path: string
  handle: THandle
  rendered: string
}

export interface ListOptions {
  /** Filter the discovered handles. Receives the loaded handle. */
  filter?: <H>(handle: H) => boolean
  /** Skip subdirectories matching these names. Default: ["node_modules", ".git", "dist", ".next"]. */
  skipDirs?: readonly string[]
}

export type RefBlock<TParams> =
  | { inline: TParams }
  | { ref: string }
  | { file: string }

export interface ResolveContext {
  /** Base dir for `file:` references. Required when resolving file blocks. */
  baseDir?: string
  /**
   * Registry resolver for `ref:` strings (e.g. `@agentik/runners/python-3.12`
   * → handle). Optional; throws when an unresolvable ref is encountered.
   */
  resolveRef?: (ref: string) => Promise<unknown> | unknown
}

export interface Verbs<TParams, THandle> {
  /** TS-authored params → write `<dir>/<pathOf(handle)>` on disk. */
  create(params: TParams, opts: CreateOptions): Promise<VerbResult<THandle>>
  /** Read a manifest from disk → handle. */
  load(path: string): Promise<{ path: string; handle: THandle; body: string }>
  /** Walk `dir` for the doctype's `*.md` files; return loaded handles. */
  list(dir: string, opts?: ListOptions): Promise<THandle[]>
  /** Load → mutate → write back. Mutator receives the loaded params. */
  update(
    path: string,
    mutator: (params: TParams, ctx: { handle: THandle; body: string }) => TParams | Promise<TParams>,
    opts?: { body?: string; dryRun?: boolean },
  ): Promise<VerbResult<THandle>>
  /**
   * Resolve a `{ inline | ref | file }` block to a handle. Used by
   * doctypes that compose other doctypes (AIP-17/30/36 pattern).
   */
  resolve(
    block: RefBlock<TParams>,
    ctx?: ResolveContext,
  ): Promise<THandle>
  /** Remove the manifest file. Does NOT recurse into the containing dir. */
  delete(path: string): Promise<void>
}

const DEFAULT_SKIP_DIRS: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".turbo",
]

export function createVerbs<
  TParams extends { id?: string; slug?: string; name?: string },
  THandle,
>(spec: DoctypeSpec<TParams, THandle>): Verbs<TParams, THandle> {
  const filename = spec.filename ?? `${spec.name.toUpperCase()}.md`
  const toFrontmatter =
    spec.toFrontmatter ??
    ((params: TParams) =>
      filterSerializable({
        schema: spec.schemaLiteral,
        ...params,
      }) as Record<string, unknown>)

  async function create(
    params: TParams,
    opts: CreateOptions,
  ): Promise<VerbResult<THandle>> {
    const handle = spec.define(params)
    const relativePath = spec.pathOf(handle)
    const path = join(opts.dir, relativePath)
    const frontmatter = toFrontmatter(params)
    const rendered = matter.stringify(
      opts.body ?? defaultBody(spec, frontmatter),
      frontmatter,
    )
    if (!opts.dryRun) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, rendered, "utf8")
    }
    return { path, handle, rendered }
  }

  async function load(
    path: string,
  ): Promise<{ path: string; handle: THandle; body: string }> {
    const source = await readFile(path, "utf8")
    const { frontmatter, body } = spec.parse(source)
    // The frontmatter is already zod-validated by `parse` (each per-
    // package parser runs the schema). Cast through `define` so the
    // cross-AIP invariants run too — same path the TS authoring uses.
    const handle = spec.define(frontmatter as unknown as TParams)
    return { path, handle, body }
  }

  async function list(
    dir: string,
    opts: ListOptions = {},
  ): Promise<THandle[]> {
    const skip = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS)
    const out: THandle[] = []

    async function walk(current: string): Promise<void> {
      // The Dirent overload returns `Dirent<NonSharedBuffer>[]` in
      // Node 22+'s @types/node when called with non-string buffer
      // input. Coerce by typing the entries as `Dirent[]` (string
      // names by default) since we always pass a string path.
      let entries: Dirent[]
      try {
        entries = (await readdir(current, { withFileTypes: true })) as Dirent[]
      } catch {
        return
      }
      for (const entry of entries) {
        const entryName = String(entry.name)
        if (entry.isDirectory()) {
          if (skip.has(entryName)) continue
          await walk(join(current, entryName))
          continue
        }
        if (!entry.isFile()) continue
        if (entryName !== filename) continue
        try {
          const { handle } = await load(join(current, entryName))
          if (!opts.filter || opts.filter(handle)) out.push(handle)
        } catch {
          // Malformed manifests skip the list — `load` will throw the
          // useful diagnostic when a caller wants to see it.
        }
      }
    }

    await walk(dir)
    return out
  }

  async function update(
    path: string,
    mutator: (
      params: TParams,
      ctx: { handle: THandle; body: string },
    ) => TParams | Promise<TParams>,
    opts: { body?: string; dryRun?: boolean } = {},
  ): Promise<VerbResult<THandle>> {
    const { handle, body } = await load(path)
    // Reconstruct params from the frontmatter — the load path already
    // validated, so this is just a reverse projection.
    const source = await readFile(path, "utf8")
    const { frontmatter } = spec.parse(source)
    const params = frontmatter as unknown as TParams
    const mutated = await mutator(params, { handle, body })
    const newHandle = spec.define(mutated)
    const newFrontmatter = toFrontmatter(mutated)
    const rendered = matter.stringify(
      opts.body ?? body,
      newFrontmatter,
    )
    if (!opts.dryRun) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, rendered, "utf8")
    }
    return { path, handle: newHandle, rendered }
  }

  async function resolve(
    block: RefBlock<TParams>,
    ctx: ResolveContext = {},
  ): Promise<THandle> {
    if ("inline" in block) {
      return spec.define(block.inline)
    }
    if ("file" in block) {
      const baseDir = ctx.baseDir ?? "."
      const path = isAbsolute(block.file) ? block.file : join(baseDir, block.file)
      const { handle } = await load(path)
      return handle
    }
    if ("ref" in block) {
      if (!ctx.resolveRef) {
        throw new Error(
          `${spec.name}.resolve (AIP-${spec.aip}): block has \`ref: '${block.ref}'\` but no resolveRef provided in context — registries must inject their own resolver`,
        )
      }
      const resolved = await ctx.resolveRef(block.ref)
      return spec.define(resolved as TParams)
    }
    throw new Error(
      `${spec.name}.resolve (AIP-${spec.aip}): block must have one of inline | ref | file`,
    )
  }

  async function deleteFn(path: string): Promise<void> {
    await rm(path, { force: true })
  }

  return { create, load, list, update, resolve, delete: deleteFn }
}

/**
 * A render-and-validate thunk for use with {@link updateManifestSet}.
 *
 * Wrap an existing verb call with `dryRun: true` so that validation and
 * rendering happen without touching disk. `updateManifestSet` calls the thunk
 * in its phase-1 pass; if it throws the entire operation is aborted before
 * any file is written.
 *
 * @example
 * ```ts
 * const ops: ManifestOp[] = [
 *   () => toolVerbs.create(toolParams,   { dir, dryRun: true }),
 *   () => agentVerbs.update(agentPath, mutator, { dryRun: true }),
 * ]
 * await updateManifestSet(ops)
 * ```
 */
export type ManifestOp = () => Promise<{ path: string; rendered: string }>

export interface ManifestSetOptions {
  /**
   * If true, copy each existing target to `<path>.bak` before the commit
   * (rename) phase. The backup is created before any rename so the original
   * content survives a partial failure. Backup files are never removed on
   * error — the caller can inspect them for recovery.
   */
  backup?: boolean
}

/**
 * Write multiple manifests as a best-effort atomic set.
 *
 * ## Sequence
 * 1. **Render + validate** — call every `op()` thunk concurrently. Any
 *    validation error aborts here; nothing is written.
 * 2. **Stage** — write each rendered string to a sibling temp file
 *    `<path>.tmp-<hex>` in the same directory.
 * 3. **Backup** *(optional)* — if `opts.backup`, copy each existing target to
 *    `<path>.bak`.
 * 4. **Commit** — `rename(tmp, target)` for each file sequentially.
 *
 * ## Atomicity guarantee (honest)
 * Each individual `rename()` is atomic on POSIX (same-device, same-dir swap).
 * The **sequence** of renames is NOT globally atomic. A process crash between
 * two renames leaves some targets at their new content and others unchanged —
 * there is no cross-file rollback. This is an inherent POSIX limitation;
 * true multi-file atomicity requires a WAL or journal outside this package.
 *
 * ## Error handling
 * On any error in the stage or commit phase all remaining `.tmp-*` temp files
 * are removed before rethrowing. Targets that were already committed in the
 * same run are **not** rolled back — they hold their new content. Targets not
 * yet reached remain unchanged.
 */
export async function updateManifestSet(
  ops: ManifestOp[],
  opts: ManifestSetOptions = {},
): Promise<Array<{ path: string; rendered: string }>> {
  // Phase 1: Render + validate all ops. Fail early; nothing written yet.
  const results = await Promise.all(ops.map((op) => op()))

  const suffix = randomBytes(4).toString("hex")
  // Mirrors `results` index-for-index. Empty string = not yet staged (skip cleanup).
  const tmps: string[] = new Array(results.length).fill("")

  try {
    // Phase 2: Stage — write each to a sibling .tmp file.
    // entries() yields [index, element] with element fully typed (no undefined).
    for (const [i, { path, rendered }] of results.entries()) {
      const tmp = `${path}.tmp-${suffix}`
      await mkdir(dirname(path), { recursive: true })
      await writeFile(tmp, rendered, "utf8")
      tmps[i] = tmp
    }

    // Phase 3: Backup (optional) — copy existing targets before rename.
    if (opts.backup) {
      for (const { path } of results) {
        try {
          await access(path)
          await copyFile(path, `${path}.bak`)
        } catch {
          // File doesn't exist yet — no backup needed.
        }
      }
    }

    // Phase 4: Commit — atomic rename of each staged tmp → target.
    // Each rename() is individually atomic (POSIX same-device).
    // The loop is NOT globally atomic; see the doc-comment above.
    for (const [i, { path }] of results.entries()) {
      // tmps[i] is guaranteed non-null: same length as results, set in phase 2.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await rename(tmps[i]!, path)
      tmps[i] = "" // Committed; exclude from cleanup if a later rename fails.
    }
  } catch (err) {
    // Remove staged .tmp files that were not yet committed.
    await Promise.allSettled(
      tmps.filter(Boolean).map((t) => rm(t, { force: true })),
    )
    throw err
  }

  return results
}

function defaultBody<P, H>(
  spec: DoctypeSpec<P extends { id?: string; slug?: string; name?: string } ? P : never, H>,
  frontmatter: Record<string, unknown>,
): string {
  const id =
    typeof frontmatter.name === "string"
      ? frontmatter.name
      : typeof frontmatter.id === "string"
        ? frontmatter.id
        : typeof frontmatter.slug === "string"
          ? frontmatter.slug
          : spec.name
  return `# ${id}\n`
}

