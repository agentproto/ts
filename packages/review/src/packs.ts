/**
 * Review packs: an installable, pinned, reusable bundle of checks + rubrics
 * a REVIEW.md can `uses:` (see `manifest.ts`'s `uses[]`).
 *
 * Two halves:
 *   - {@link parsePackManifest} parses a PACK's own REVIEW.md
 *     (`kind: review-pack`) — a strict subset of the review manifest shape:
 *     no `bindings`, no `prepare`, no `effects: true` check, and an agent
 *     check's `preset` is optional (presets are host-specific, so a pack
 *     can't hardcode one).
 *   - {@link resolvePacks} is the "host seam, not the pure package" step:
 *     given a manifest's `uses[]` and an injected {@link PackLoader} (the
 *     runtime resolves relative paths / npm packages / pinned git shas; a
 *     test hands in a fake), it loads each pack, applies the `checks:`
 *     subset / `preset` / `overrides`, namespaces the result `<as>/<id>`,
 *     computes each pack's content digest, merges everything into the
 *     consumer's checks, and re-finalizes bindings now that every
 *     namespaced ref actually resolves to a real check.
 */

import matter from "gray-matter"
import { z } from "zod"
import {
  assertUnique,
  finalizeBindings,
  idSchema,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  ReviewManifestError,
  type AgentCheck,
  type CommandCheck,
  type ReviewCheck,
  type ReviewManifest,
} from "./manifest.js"
import { sha256Hex } from "./attestation.js"
import type { PackDigest, Severity } from "./types.js"

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const packCommandCheckSchema = z
  .object({
    id: idSchema,
    kind: z.literal("command"),
    run: z.string().min(1),
    cwd: z.string().min(1).optional(),
    blocking: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    effects: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict()

const packAgentCheckSchema = z
  .object({
    id: idSchema,
    kind: z.literal("agent"),
    /** Presets are host-specific — a pack's own agent checks may omit one;
     *  the consuming `uses[]` entry (or its `overrides`) must supply it. */
    preset: z.string().min(1).optional(),
    rubric: z.string().min(1),
    blockOn: z.enum(["high", "medium", "low"]).optional(),
    blocking: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    effects: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict()

/** No `bindings`, no `prepare`, no `target` — a pack is checks + rubrics
 *  only; declaring any of those is an unrecognized-key parse error. */
const packFrontmatterSchema = z
  .object({
    kind: z.literal("review-pack"),
    id: idSchema,
    version: z.string().regex(SEMVER, "must be semver (x.y.z)"),
    description: z.string().optional(),
    checks: z.array(z.discriminatedUnion("kind", [packCommandCheckSchema, packAgentCheckSchema])).min(1),
  })
  .strict()

type PackFrontmatter = z.infer<typeof packFrontmatterSchema>

/** A pack's command check — identical shape to a consumer's own. */
export type PackCommandCheck = CommandCheck

/** A pack's agent check — like {@link AgentCheck}, but `preset` is optional
 *  (presets are host-specific; the consumer's `uses[]` entry supplies one). */
export interface PackAgentCheck {
  id: string
  kind: "agent"
  preset?: string
  rubric: string
  blockOn: Severity
  blocking: boolean
  timeoutMs: number
  effects: false
  description?: string
}

export type PackCheck = PackCommandCheck | PackAgentCheck

export interface PackManifest {
  kind: "review-pack"
  id: string
  version: string
  description?: string
  checks: PackCheck[]
  /** The markdown body — documentation only. */
  body: string
}

export class PackManifestError extends Error {
  constructor(message: string) {
    super(`parsePackManifest: ${message}`)
    this.name = "PackManifestError"
  }
}

function normalizePackCheck(c: PackFrontmatter["checks"][number]): PackCheck {
  if (c.effects === true) {
    throw new PackManifestError(
      `check '${c.id}': a review pack may not declare an 'effects: true' check — a pack's command checks ` +
        `run in the CONSUMER's checkout and must never be mutation-capable`,
    )
  }
  if (c.kind === "command") {
    return {
      id: c.id,
      kind: "command",
      run: c.run,
      ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
      blocking: c.blocking ?? true,
      timeoutMs: c.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      effects: false,
      ...(c.description !== undefined ? { description: c.description } : {}),
    }
  }
  return {
    id: c.id,
    kind: "agent",
    ...(c.preset !== undefined ? { preset: c.preset } : {}),
    rubric: c.rubric,
    blockOn: c.blockOn ?? "high",
    blocking: c.blocking ?? true,
    timeoutMs: c.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    effects: false,
    ...(c.description !== undefined ? { description: c.description } : {}),
  }
}

/** Parse + validate a pack's own REVIEW.md source string. Throws
 *  {@link PackManifestError}. */
export function parsePackManifest(source: string): PackManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new PackManifestError("missing or empty frontmatter")
  }
  const result = packFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new PackManifestError(
      `invalid frontmatter — ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    )
  }
  const fm = result.data
  const checks = fm.checks.map(normalizePackCheck)
  assertUnique(
    checks.map((c) => c.id),
    "checks[]",
  )
  return {
    kind: "review-pack",
    id: fm.id,
    version: fm.version,
    ...(fm.description !== undefined ? { description: fm.description } : {}),
    checks,
    body: parsed.content,
  }
}

/** One resolved pack's content, as the runtime (or a test fake) hands it
 *  back. Reading rubric bytes is deferred to {@link readRubric} — only the
 *  checks a `uses[]` entry actually selects need their bytes hashed. */
export interface PackSource {
  manifest: PackManifest
  /** The pack's REVIEW.md source bytes (hashed into the pack digest). */
  source: string
  /** How this ref was resolved (informational: does NOT by itself decide
   *  trust — see {@link trusted}). */
  refKind: "relative" | "npm" | "git"
  /** Governs the `allowCommands` exemption: true ONLY for a same-repo,
   *  same-trust pack — the loader's own job to decide (a "relative" ref
   *  string alone proves nothing; the resolved path could still point
   *  outside the repo, or at untracked content the repo doesn't actually
   *  own). Always false for an npm or git pack. */
  trusted: boolean
  /** Absolute directory `readRubric`'s paths (and a lane executor reading
   *  the rubric at run time) are relative to. Carried onto each imported
   *  agent check as `AgentCheck.rubricBase`. */
  root: string
  /** Read one rubric file's bytes, given the path as declared on the check
   *  (relative to `root`). */
  readRubric(relPath: string): Promise<Uint8Array>
}

/** The host seam `resolvePacks` is parameterized by — the runtime resolves
 *  `npm name | ./relative/path | git+https://...#<40-hex sha>`; a test
 *  hands in a fake source directly. */
export interface PackLoader {
  load(ref: string): Promise<PackSource>
}

export interface ResolvePacksResult {
  /** The consumer's manifest with every `uses[]` pack's selected checks
   *  merged in (namespaced `<as>/<id>`) and bindings re-finalized against
   *  the complete check set. Identical to the input when `uses` is empty. */
  manifest: ReviewManifest
  /** Every resolved pack's digest, in `uses[]` order — what the attestation
   *  records (`Attestation.packs`). Empty when the manifest declares none. */
  packs: PackDigest[]
  /** `as` → its digest — the host's composition eligibility check
   *  (`review-compose.ts`) needs this: a lane whose check came from a pack
   *  additionally requires the PRIOR attestation to carry the identical
   *  pack digest, not just a matching rubric digest. */
  packByNamespace: Record<string, PackDigest>
}

/**
 * Resolve `manifest.uses[]` through `loader` and merge the result in. A
 * no-op (returns `manifest` unchanged) when `uses` is empty, so a caller can
 * always call this unconditionally. Throws {@link ReviewManifestError} for
 * every cross-field rule the frozen design lists: an unknown name in a
 * `checks:` subset, a command check without `allowCommands` on a
 * non-relative pack, an agent check with no preset anywhere, a namespaced id
 * colliding with an existing check, or (via `finalizeBindings`) a binding
 * that still references an unknown check once every pack is merged in.
 */
export async function resolvePacks(manifest: ReviewManifest, loader: PackLoader): Promise<ResolvePacksResult> {
  if (manifest.uses.length === 0) return { manifest, packs: [], packByNamespace: {} }

  const mergedChecks: ReviewCheck[] = [...manifest.checks]
  const seenIds = new Set(mergedChecks.map((c) => c.id))
  const pushChecked = (c: ReviewCheck): void => {
    if (seenIds.has(c.id)) throw new ReviewManifestError(`check '${c.id}' (from a uses[] pack) collides with an existing check id`)
    seenIds.add(c.id)
    mergedChecks.push(c)
  }

  const packs: PackDigest[] = []
  const packByNamespace: Record<string, PackDigest> = {}

  for (const use of manifest.uses) {
    const loaded = await loader.load(use.pack)
    const selectable = new Map(loaded.manifest.checks.map((c) => [c.id, c]))
    if (use.checks) {
      for (const name of use.checks) {
        if (!selectable.has(name)) {
          throw new ReviewManifestError(
            `uses '${use.as}' (${use.pack}): checks[] names '${name}', which pack '${loaded.manifest.id}' does not declare`,
          )
        }
      }
    }
    const selectedIds = use.checks ?? [...selectable.keys()]

    const rubricFiles: Array<{ path: string; bytes: Uint8Array }> = []
    for (const id of selectedIds) {
      const check = selectable.get(id)!
      const override = use.overrides[id] ?? {}
      const namespacedId = `${use.as}/${id}`

      if (check.kind === "command") {
        if (!(use.allowCommands || loaded.trusted)) {
          throw new ReviewManifestError(
            `uses '${use.as}' (${use.pack}): check '${id}' is a command check — it would run shell ` +
              `commands in this checkout from third-party pack content. Set allowCommands: true on the ` +
              `uses entry to allow it.`,
          )
        }
        pushChecked({
          ...check,
          id: namespacedId,
          blocking: override.blocking ?? check.blocking,
          timeoutMs: override.timeoutMs ?? check.timeoutMs,
        })
        continue
      }

      const preset = override.preset ?? use.preset ?? check.preset
      if (!preset) {
        throw new ReviewManifestError(
          `uses '${use.as}' (${use.pack}): agent check '${id}' has no preset — set 'preset' on the uses ` +
            `entry, 'overrides.${id}.preset', or a preset directly on the pack's check`,
        )
      }
      const merged: AgentCheck = {
        id: namespacedId,
        kind: "agent",
        preset,
        rubric: check.rubric,
        blockOn: override.blockOn ?? check.blockOn,
        blocking: override.blocking ?? check.blocking,
        timeoutMs: override.timeoutMs ?? check.timeoutMs,
        effects: false,
        ...(check.description !== undefined ? { description: check.description } : {}),
        rubricBase: loaded.root,
      }
      pushChecked(merged)
      rubricFiles.push({ path: check.rubric, bytes: await loaded.readRubric(check.rubric) })
    }

    const digestLines = [
      `REVIEW.md\0${sha256Hex(loaded.source)}`,
      ...rubricFiles.map((r) => `${r.path}\0${sha256Hex(r.bytes)}`),
    ].sort()
    const digest: PackDigest = {
      ref: use.pack,
      id: loaded.manifest.id,
      version: loaded.manifest.version,
      sha256: sha256Hex(digestLines.join("\n")),
    }
    packs.push(digest)
    packByNamespace[use.as] = digest
  }

  const bindings = finalizeBindings(mergedChecks, manifest.bindings)
  return { manifest: { ...manifest, checks: mergedChecks, bindings }, packs, packByNamespace }
}
