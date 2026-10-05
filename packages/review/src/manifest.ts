/**
 * REVIEW.md parser — same manifest doctrine as AIP-15's WORKFLOW.md
 * (`@agentproto/workflow/manifest`): a markdown file whose YAML frontmatter
 * is the declaration and whose body is free-form documentation. This module
 * parses a *string*; reading the file off disk is the host's job.
 *
 * Field-level shape runs through the zod schema generated from AIP-62's
 * `REVIEW.schema.json` (`./schema.ts`). The cross-field rules that make a
 * review sound run after it, here, at PARSE time — a manifest that
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
import type { z } from "zod"
import type { Quorum, Severity } from "./types.js"
import { parseGitPackRef, GitPackRefError } from "./git-pack-ref.js"
import { reviewFrontmatterSchema, type ReviewFrontmatter } from "./schema.js"

export { reviewFrontmatterSchema, type ReviewFrontmatter }

/** Default per-lane timeouts, applied when a check omits `timeoutMs`. A lane
 *  is ALWAYS bounded — an unbounded lane could hang a review forever. These
 *  mirror the `default`s in `REVIEW.schema.json` (a test pins them). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000
export const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60_000

/** The binding implied when a manifest declares none. */
export const DEFAULT_BINDING = "default"

/** The default range base when `target.base` is omitted. */
export const DEFAULT_BASE_REF = "origin/main"

/** A review definition as authored: the frontmatter shape, before defaults. */
export type ReviewDefinition = z.input<typeof reviewFrontmatterSchema>

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
  /** Ordered fallback reviewers, tried only when the reviewer in `preset` (and
   *  each earlier fallback) is unavailable — never after a verdict. Disjoint
   *  from `preset` and from itself. */
  fallbackPresets: string[]
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
  fallbackPresets?: string[]
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
  fallbackPresets?: string[]
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
  /** The diagnostic without the `parseReviewManifest: ` prefix, so another
   *  entry point (`defineReview`) can re-prefix it and stay byte-identical. */
  readonly detail: string
  constructor(message: string) {
    super(`parseReviewManifest: ${message}`)
    this.name = "ReviewManifestError"
    this.detail = message
  }
}

function normalizeCheck(c: ReviewFrontmatter["checks"][number]): ReviewCheck {
  if (c.kind === "command") {
    return {
      id: c.id,
      kind: "command",
      run: c.run,
      ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
      blocking: c.blocking,
      timeoutMs: c.timeoutMs,
      effects: c.effects,
      ...(c.description !== undefined ? { description: c.description } : {}),
    }
  }
  return {
    id: c.id,
    kind: "agent",
    preset: c.preset,
    fallbackPresets: c.fallbackPresets ?? [],
    rubric: c.rubric,
    blockOn: c.blockOn,
    blocking: c.blocking,
    timeoutMs: c.timeoutMs,
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

/** A reviewer chain (`[preset, ...fallbackPresets]`) may name each preset once:
 *  a fallback equal to the primary, or a repeated fallback, can never add a
 *  second chance. Throws {@link ReviewManifestError}. */
export function assertReviewerChain(label: string, preset: string, fallbackPresets: readonly string[]): void {
  const seen = new Set([preset])
  for (const fb of fallbackPresets) {
    if (seen.has(fb)) {
      throw new ReviewManifestError(
        fb === preset
          ? `${label}: fallbackPresets lists '${fb}', which is already the primary preset`
          : `${label}: fallbackPresets lists '${fb}' more than once`,
      )
    }
    seen.add(fb)
  }
}

function normalizeUse(u: NonNullable<ReviewFrontmatter["uses"]>[number]): ReviewUse {
  return {
    pack: u.pack,
    as: u.as,
    ...(u.checks !== undefined ? { checks: u.checks } : {}),
    ...(u.preset !== undefined ? { preset: u.preset } : {}),
    ...(u.fallbackPresets !== undefined ? { fallbackPresets: u.fallbackPresets } : {}),
    overrides: u.overrides ?? {},
    allowCommands: u.allowCommands,
  }
}

/** Binding structure with every default filled in, but check/prepare refs
 *  NOT yet validated against `byId` — the shared shape both the immediate
 *  (no-`uses`) path and {@link resolvePacks} finalize from. */
function normalizeBindings(declared: NonNullable<ReviewFrontmatter["bindings"]>): Record<string, ReviewBinding> {
  const out: Record<string, ReviewBinding> = {}
  for (const [name, b] of Object.entries(declared)) {
    out[name] = {
      name,
      ...(b.on !== undefined ? { on: b.on } : {}),
      prepare: b.prepare ?? [],
      checks: b.checks,
      quorum: b.quorum,
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

/** One human-readable line per schema issue. Two failures get a purpose-built
 *  message instead of the schema's generic one: `effects: true` on an agent
 *  check (the union arm rejects it with only "expected false") and an
 *  unpinned / non-https git pack ref (the schema's regex can't say why). */
function describeIssues(issues: readonly z.core.$ZodIssue[], data: unknown): string {
  const fm = data as { checks?: unknown[]; uses?: unknown[] } | undefined
  return issues
    .map((i) => {
      const path = i.path.join(".")
      const [head, idx, field] = i.path
      if (head === "checks" && field === "effects" && typeof idx === "number") {
        const c = fm?.checks?.[idx] as { kind?: unknown } | undefined
        if (c?.kind === "agent") return `${path}: 'effects: true' is only supported on command checks`
      }
      if (head === "uses" && field === "pack" && typeof idx === "number" && i.path.length === 3) {
        const pack = (fm?.uses?.[idx] as { pack?: unknown } | undefined)?.pack
        if (typeof pack === "string" && pack.startsWith("git+")) {
          try {
            parseGitPackRef(pack)
          } catch (e) {
            if (e instanceof GitPackRefError) return `${path}: ${e.message}`
          }
        }
      }
      return `${path}: ${i.message}`
    })
    .join("; ")
}

/** Field-shape validation against the generated schema, for an
 *  already-parsed frontmatter object. Shared by `parseReviewManifest` and
 *  `defineReview`, so a malformed REVIEW.md and a malformed definition fail
 *  with the same diagnostic. Throws {@link ReviewManifestError}. */
export function checkReviewFrontmatter(data: unknown): ReviewFrontmatter {
  const result = reviewFrontmatterSchema.safeParse(data)
  if (!result.success) {
    throw new ReviewManifestError(`invalid frontmatter — ${describeIssues(result.error.issues, data)}`)
  }
  return result.data
}

/** Apply the cross-field rules to schema-valid frontmatter and build the
 *  normalized manifest. Throws {@link ReviewManifestError}.
 *
 *  When the manifest declares `uses[]`, binding validation for a namespaced
 *  ref (`<as>/<id>`) is DEFERRED to {@link resolvePacks} — the pack's checks
 *  aren't loaded yet, so an unknown-ref / effects-placement / blocking-check
 *  error naming a pack check can't be raised here. A manifest with `uses[]`
 *  must declare its bindings explicitly (the implied `default` binding only
 *  knows local checks, which would silently exclude every pack check). */
export function buildReviewManifest(fm: ReviewFrontmatter, body: string): ReviewManifest {
  const checks = fm.checks.map(normalizeCheck)
  assertUnique(
    checks.map((c) => c.id),
    "checks[]",
  )
  for (const c of checks) {
    if (c.kind === "agent") assertReviewerChain(`check '${c.id}'`, c.preset, c.fallbackPresets)
  }

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

  const base = typeof fm.target === "string" ? DEFAULT_BASE_REF : fm.target.base
  return {
    kind: "review",
    id: fm.id,
    ...(fm.name !== undefined ? { name: fm.name } : {}),
    ...(fm.description !== undefined ? { description: fm.description } : {}),
    target: { kind: "git-range", base },
    checks,
    bindings,
    uses,
    verdict: { ...(fm.verdict?.exportDir !== undefined ? { exportDir: fm.verdict.exportDir } : {}) },
    body,
  }
}

/** Parse + validate a REVIEW.md source string. Throws {@link ReviewManifestError}. */
export function parseReviewManifest(source: string): ReviewManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new ReviewManifestError("missing or empty frontmatter")
  }
  return buildReviewManifest(checkReviewFrontmatter(parsed.data), parsed.content)
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
