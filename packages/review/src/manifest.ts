/**
 * REVIEW.md parser — same manifest doctrine as AIP-15's WORKFLOW.md
 * (`@agentproto/workflow/manifest`): a markdown file whose YAML frontmatter
 * is the declaration and whose body is free-form documentation. This module
 * parses a *string*; reading the file off disk is the host's job.
 *
 * Field-level shape runs through the strict zod below. The cross-field rules
 * that make a review sound run after it, here, at PARSE time — a manifest that
 * could produce a misleading verdict never gets as far as a run:
 *   - check ids are unique;
 *   - a binding may only reference declared checks (unknown ref = error);
 *   - an `effects: true` check (mutation-capable) may appear ONLY in a
 *     binding's `prepare`, never as an attesting lane in `checks`;
 *   - a `prepare` entry must be an `effects: true` check;
 *   - every binding selects at least one blocking lane (a binding that can
 *     never block would attest nothing);
 *   - no bindings declared ⇒ an implied `default` binding over every
 *     non-effects check.
 */

import matter from "gray-matter"
import { z } from "zod"
import type { Quorum, Severity } from "./types.js"

/** Default per-lane timeouts, applied when a check omits `timeoutMs`. A lane
 *  is ALWAYS bounded — an unbounded lane could hang a review forever. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000
export const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60_000

/** The binding implied when a manifest declares none. */
export const DEFAULT_BINDING = "default"

/** The default range base when `target.base` is omitted. */
export const DEFAULT_BASE_REF = "origin/main"

export const idSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be lowercase kebab-case ([a-z][a-z0-9-]*)").max(64)

/** A check id in a binding's `prepare`/`checks`: a local id, or a namespaced
 *  `<as>/<id>` referencing a `uses[]` pack's check. */
const checkRefSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/, "must be a check id or <namespace>/<id>")
  .max(129)

const commandCheckSchema = z
  .object({
    id: idSchema,
    kind: z.literal("command"),
    /** Shell command line (run via `sh -c`). May carry `{name}` placeholders —
     *  see `substitutePlaceholders`. */
    run: z.string().min(1),
    /** Working directory, relative to the repo root. Default: the repo root. */
    cwd: z.string().min(1).optional(),
    blocking: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    effects: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict()

const agentCheckSchema = z
  .object({
    id: idSchema,
    kind: z.literal("agent"),
    /** Harness preset id the reviewer session spawns under (the daemon's
     *  existing preset surface — no model/auth config lives here). */
    preset: z.string().min(1),
    /** Path to the markdown rubric, relative to the REVIEW.md's directory. */
    rubric: z.string().min(1),
    blockOn: z.enum(["high", "medium", "low"]).optional(),
    blocking: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    effects: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict()

const bindingSchema = z
  .object({
    /** Informational trigger label (`pre-push`, `pr`, …). Nothing in this
     *  package dispatches on it — hooks/CI shims select a binding by name. */
    on: z.string().min(1).optional(),
    prepare: z.array(checkRefSchema).optional(),
    checks: z.array(checkRefSchema).min(1),
    quorum: z.literal("all-blocking-pass").optional(),
  })
  .strict()

const overrideSchema = z
  .object({
    blockOn: z.enum(["high", "medium", "low"]).optional(),
    blocking: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    preset: z.string().min(1).optional(),
  })
  .strict()

const usesEntrySchema = z
  .object({
    /** `npm name | ./relative/path | git+https://...#<40-hex sha>`. */
    pack: z.string().min(1),
    /** Namespace: the pack's checks become `<as>/<id>`. */
    as: idSchema,
    /** Subset of the pack's checks to import. Default: all. */
    checks: z.array(idSchema).optional(),
    /** Default harness preset for the pack's agent checks (presets are
     *  host-specific, so a pack's own agent checks may omit one). */
    preset: z.string().min(1).optional(),
    /** Per-check field overrides, keyed by the pack's own (unnamespaced)
     *  check id. */
    overrides: z.record(idSchema, overrideSchema).optional(),
    /** A pack's `command` checks run shell commands in the consumer's
     *  checkout — third-party code execution. Required (true) for any
     *  non-relative pack that declares one; relative-path packs are exempt
     *  (same repo, same trust). Default false. */
    allowCommands: z.boolean().optional(),
  })
  .strict()

const targetSchema = z.union([
  z.literal("git-range"),
  z
    .object({
      kind: z.literal("git-range"),
      /** Ref the default range is cut from: `merge-base(<base>)..HEAD`. */
      base: z.string().min(1).optional(),
    })
    .strict(),
])

export const reviewFrontmatterSchema = z
  .object({
    kind: z.literal("review"),
    id: idSchema,
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    target: targetSchema,
    checks: z.array(z.discriminatedUnion("kind", [commandCheckSchema, agentCheckSchema])).min(1),
    bindings: z.record(idSchema, bindingSchema).optional(),
    uses: z.array(usesEntrySchema).optional(),
    verdict: z
      .object({
        /** Default directory `review_export` writes attestations into when
         *  the caller names no `outPath` (relative to the repo root). */
        exportDir: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type ReviewFrontmatter = z.infer<typeof reviewFrontmatterSchema>

/** A normalized command check — every default applied. */
export interface CommandCheck {
  id: string
  kind: "command"
  run: string
  cwd?: string
  blocking: boolean
  timeoutMs: number
  effects: boolean
  description?: string
}

/** A normalized agent check — every default applied. */
export interface AgentCheck {
  id: string
  kind: "agent"
  preset: string
  rubric: string
  blockOn: Severity
  blocking: boolean
  timeoutMs: number
  effects: false
  description?: string
  /** Set on a check imported from a `uses[]` pack: the absolute directory
   *  `rubric` is relative to (the pack's root), rather than this REVIEW.md's
   *  own directory. Set by `resolvePacks`; a check declared directly in this
   *  REVIEW.md never has one. */
  rubricBase?: string
}

export type ReviewCheck = CommandCheck | AgentCheck

export interface ReviewBinding {
  name: string
  on?: string
  /** Effects-capable checks run sequentially BEFORE the range is frozen. */
  prepare: string[]
  /** Attesting lanes, run in parallel against the frozen range. Ids from a
   *  `uses[]` pack are namespaced `<as>/<id>`. */
  checks: string[]
  quorum: Quorum
}

/** A per-check field override inside a `uses[]` entry, keyed by the pack's
 *  own (unnamespaced) check id. */
export interface UsesOverride {
  blockOn?: Severity
  blocking?: boolean
  timeoutMs?: number
  preset?: string
}

/** A normalized `uses[]` entry — a review pack this manifest consumes. Not
 *  yet resolved: the pack's own checks aren't loaded until
 *  {@link resolvePacks} runs (a host step — reading/fetching the pack is
 *  I/O this pure package doesn't do). */
export interface ReviewUse {
  pack: string
  as: string
  /** Subset of the pack's checks to import. `undefined` ⇒ all. */
  checks?: string[]
  preset?: string
  overrides: Record<string, UsesOverride>
  allowCommands: boolean
}

export interface ReviewManifest {
  kind: "review"
  id: string
  name?: string
  description?: string
  target: { kind: "git-range"; base: string }
  /** Local checks only until `resolvePacks` runs, then local + every
   *  imported pack check (namespaced), merged. */
  checks: ReviewCheck[]
  /** Fully validated once `uses` is empty; when `uses` is non-empty, a
   *  binding referencing a namespaced check is left UNVALIDATED (structure
   *  only — `on`/`prepare`/`checks`/`quorum` defaults applied) until
   *  {@link resolvePacks} merges the pack checks in and re-validates. */
  bindings: Record<string, ReviewBinding>
  /** Review packs this manifest consumes, normalized but not yet resolved. */
  uses: ReviewUse[]
  verdict: { exportDir?: string }
  /** The markdown body — documentation only. */
  body: string
}

export class ReviewManifestError extends Error {
  constructor(message: string) {
    super(`parseReviewManifest: ${message}`)
    this.name = "ReviewManifestError"
  }
}

function normalizeCheck(c: ReviewFrontmatter["checks"][number]): ReviewCheck {
  if (c.kind === "command") {
    return {
      id: c.id,
      kind: "command",
      run: c.run,
      ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
      blocking: c.blocking ?? true,
      timeoutMs: c.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      effects: c.effects ?? false,
      ...(c.description !== undefined ? { description: c.description } : {}),
    }
  }
  if (c.effects === true) {
    // An agent that edits the tree is a fixer, not a reviewer. Step 1 runs
    // prepare steps as plain commands through the workflow engine's gate
    // machinery; an agent prepare step has no executor yet.
    throw new ReviewManifestError(
      `check '${c.id}': 'effects: true' is only supported on command checks — an agent check is always a read-only reviewer`,
    )
  }
  return {
    id: c.id,
    kind: "agent",
    preset: c.preset,
    rubric: c.rubric,
    blockOn: c.blockOn ?? "high",
    blocking: c.blocking ?? true,
    timeoutMs: c.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    effects: false,
    ...(c.description !== undefined ? { description: c.description } : {}),
  }
}

export function assertUnique(ids: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new ReviewManifestError(`${label} lists '${id}' more than once`)
    seen.add(id)
  }
}

/** A 40-hex git commit sha — the only pin `uses[].pack` accepts for a
 *  `git+` ref. */
const FULL_SHA = /^[0-9a-f]{40}$/

function normalizeUse(u: z.infer<typeof usesEntrySchema>): ReviewUse {
  if (u.pack.startsWith("git+")) {
    const hash = u.pack.indexOf("#")
    const pin = hash === -1 ? "" : u.pack.slice(hash + 1)
    if (!FULL_SHA.test(pin)) {
      throw new ReviewManifestError(
        `uses '${u.as}': git pack ref '${u.pack}' must be pinned to a full 40-hex commit sha ` +
          `(git+https://...#<sha>) — a floating branch, tag, or short sha is not reproducible`,
      )
    }
  }
  return {
    pack: u.pack,
    as: u.as,
    ...(u.checks !== undefined ? { checks: u.checks } : {}),
    ...(u.preset !== undefined ? { preset: u.preset } : {}),
    overrides: u.overrides ?? {},
    allowCommands: u.allowCommands ?? false,
  }
}

/** Binding structure with every default filled in, but check/prepare refs
 *  NOT yet validated against `byId` — the shared shape both the immediate
 *  (no-`uses`) path and {@link resolvePacks} finalize from. */
function normalizeBindings(declared: Record<string, z.infer<typeof bindingSchema>>): Record<string, ReviewBinding> {
  const out: Record<string, ReviewBinding> = {}
  for (const [name, b] of Object.entries(declared)) {
    out[name] = {
      name,
      ...(b.on !== undefined ? { on: b.on } : {}),
      prepare: b.prepare ?? [],
      checks: b.checks,
      quorum: b.quorum ?? "all-blocking-pass",
    }
  }
  return out
}

/**
 * Validate + finalize bindings against a COMPLETE check map: unique refs,
 * every ref resolves, `effects: true` checks only in `prepare`, at least one
 * blocking check per binding, and (only when `raw` is empty) the implied
 * `default` binding over every non-effects check in `allChecks`. Shared by
 * `parseReviewManifest` (no `uses`) and `resolvePacks` (after merging pack
 * checks in) — the one place this logic lives.
 */
export function finalizeBindings(
  allChecks: readonly ReviewCheck[],
  raw: Record<string, ReviewBinding>,
): Record<string, ReviewBinding> {
  const byId = new Map(allChecks.map((c) => [c.id, c]))
  const bindings: Record<string, ReviewBinding> = {}
  for (const [name, b] of Object.entries(raw)) {
    assertUnique(b.prepare, `binding '${name}' prepare`)
    assertUnique(b.checks, `binding '${name}' checks`)
    for (const ref of b.prepare) {
      const check = byId.get(ref)
      if (!check) throw new ReviewManifestError(`binding '${name}' prepare references unknown check '${ref}'`)
      if (!check.effects) {
        throw new ReviewManifestError(
          `binding '${name}' prepare lists '${ref}', which is not an 'effects: true' check — ` +
            `prepare is for mutation-capable steps; list a read-only check under 'checks' instead`,
        )
      }
    }
    for (const ref of b.checks) {
      const check = byId.get(ref)
      if (!check) throw new ReviewManifestError(`binding '${name}' checks references unknown check '${ref}'`)
      if (check.effects) {
        throw new ReviewManifestError(
          `binding '${name}' checks lists '${ref}', an 'effects: true' check — a mutation-capable ` +
            `check can only run in a binding's 'prepare' phase, never as an attesting lane`,
        )
      }
    }
    bindings[name] = b
  }

  if (Object.keys(bindings).length === 0) {
    const lanes = allChecks.filter((c) => !c.effects).map((c) => c.id)
    if (lanes.length === 0) {
      throw new ReviewManifestError(
        "no bindings declared and no non-effects check to imply a 'default' binding from",
      )
    }
    bindings[DEFAULT_BINDING] = { name: DEFAULT_BINDING, prepare: [], checks: lanes, quorum: "all-blocking-pass" }
  }

  for (const b of Object.values(bindings)) {
    if (!b.checks.some((ref) => byId.get(ref)!.blocking)) {
      throw new ReviewManifestError(
        `binding '${b.name}' selects no blocking check — its verdict could never block, so it would attest nothing`,
      )
    }
  }
  return bindings
}

/** Parse + validate a REVIEW.md source string. Throws {@link ReviewManifestError}.
 *
 *  When the manifest declares `uses[]`, binding validation for a namespaced
 *  ref (`<as>/<id>`) is DEFERRED to {@link resolvePacks} — the pack's checks
 *  aren't loaded yet, so an unknown-ref / effects-placement / blocking-check
 *  error naming a pack check can't be raised here. A manifest with `uses[]`
 *  must declare its bindings explicitly (the implied `default` binding only
 *  knows local checks, which would silently exclude every pack check). */
export function parseReviewManifest(source: string): ReviewManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new ReviewManifestError("missing or empty frontmatter")
  }
  const result = reviewFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new ReviewManifestError(
      `invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  const fm = result.data

  const checks = fm.checks.map(normalizeCheck)
  assertUnique(
    checks.map((c) => c.id),
    "checks[]",
  )

  const uses = (fm.uses ?? []).map(normalizeUse)
  assertUnique(
    uses.map((u) => u.as),
    "uses[]",
  )

  const raw = normalizeBindings(fm.bindings ?? {})
  let bindings: Record<string, ReviewBinding>
  if (uses.length === 0) {
    bindings = finalizeBindings(checks, raw)
  } else {
    if (Object.keys(raw).length === 0) {
      throw new ReviewManifestError(
        "uses[] requires at least one explicit binding — the implied 'default' binding only knows " +
          "local checks, which would silently exclude every check a pack brings in",
      )
    }
    // Local-only refs (no '/') can be checked now; a namespaced ref is left
    // for resolvePacks, once the pack it names is actually loaded.
    for (const [name, b] of Object.entries(raw)) {
      assertUnique(b.prepare, `binding '${name}' prepare`)
      assertUnique(b.checks, `binding '${name}' checks`)
      for (const ref of [...b.prepare, ...b.checks]) {
        if (ref.includes("/")) {
          const as = ref.slice(0, ref.indexOf("/"))
          if (!uses.some((u) => u.as === as)) {
            throw new ReviewManifestError(`binding '${name}' references '${ref}', but no uses[] entry declares namespace '${as}'`)
          }
        }
      }
    }
    bindings = raw
  }

  const target = fm.target === "git-range" ? { kind: "git-range" as const } : fm.target
  return {
    kind: "review",
    id: fm.id,
    ...(fm.name !== undefined ? { name: fm.name } : {}),
    ...(fm.description !== undefined ? { description: fm.description } : {}),
    target: { kind: "git-range", base: target.base ?? DEFAULT_BASE_REF },
    checks,
    bindings,
    uses,
    verdict: { ...(fm.verdict?.exportDir !== undefined ? { exportDir: fm.verdict.exportDir } : {}) },
    body: parsed.content,
  }
}

/** Look up a check by id. Throws {@link ReviewManifestError} on a miss. */
export function getCheck(manifest: ReviewManifest, id: string): ReviewCheck {
  const check = manifest.checks.find((c) => c.id === id)
  if (!check) throw new ReviewManifestError(`unknown check '${id}'`)
  return check
}

/** Resolve a binding by name — `undefined` selects the sole declared binding,
 *  or `default` when several exist. Throws on an unknown/ambiguous name. */
export function resolveBinding(manifest: ReviewManifest, name?: string): ReviewBinding {
  const names = Object.keys(manifest.bindings)
  if (name === undefined) {
    if (names.length === 1) return manifest.bindings[names[0]!]!
    const fallback = manifest.bindings[DEFAULT_BINDING]
    if (fallback) return fallback
    throw new ReviewManifestError(
      `review '${manifest.id}' declares several bindings (${names.join(", ")}) — name one`,
    )
  }
  const binding = manifest.bindings[name]
  if (!binding) {
    throw new ReviewManifestError(
      `review '${manifest.id}' has no binding '${name}' — available: ${names.join(", ")}`,
    )
  }
  return binding
}
