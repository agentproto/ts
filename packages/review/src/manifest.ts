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

const idSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be lowercase kebab-case ([a-z][a-z0-9-]*)").max(64)

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
    prepare: z.array(idSchema).optional(),
    checks: z.array(idSchema).min(1),
    quorum: z.literal("all-blocking-pass").optional(),
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
}

export type ReviewCheck = CommandCheck | AgentCheck

export interface ReviewBinding {
  name: string
  on?: string
  /** Effects-capable checks run sequentially BEFORE the range is frozen. */
  prepare: string[]
  /** Attesting lanes, run in parallel against the frozen range. */
  checks: string[]
  quorum: Quorum
}

export interface ReviewManifest {
  kind: "review"
  id: string
  name?: string
  description?: string
  target: { kind: "git-range"; base: string }
  checks: ReviewCheck[]
  bindings: Record<string, ReviewBinding>
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

function assertUnique(ids: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new ReviewManifestError(`${label} lists '${id}' more than once`)
    seen.add(id)
  }
}

/** Parse + validate a REVIEW.md source string. Throws {@link ReviewManifestError}. */
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
  const byId = new Map(checks.map((c) => [c.id, c]))

  const declared = fm.bindings ?? {}
  const bindings: Record<string, ReviewBinding> = {}
  for (const [name, b] of Object.entries(declared)) {
    const prepare = b.prepare ?? []
    assertUnique(prepare, `binding '${name}' prepare`)
    assertUnique(b.checks, `binding '${name}' checks`)
    for (const ref of prepare) {
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
    bindings[name] = {
      name,
      ...(b.on !== undefined ? { on: b.on } : {}),
      prepare,
      checks: b.checks,
      quorum: b.quorum ?? "all-blocking-pass",
    }
  }

  if (Object.keys(bindings).length === 0) {
    const lanes = checks.filter((c) => !c.effects).map((c) => c.id)
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

  const target = fm.target === "git-range" ? { kind: "git-range" as const } : fm.target
  return {
    kind: "review",
    id: fm.id,
    ...(fm.name !== undefined ? { name: fm.name } : {}),
    ...(fm.description !== undefined ? { description: fm.description } : {}),
    target: { kind: "git-range", base: target.base ?? DEFAULT_BASE_REF },
    checks,
    bindings,
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
