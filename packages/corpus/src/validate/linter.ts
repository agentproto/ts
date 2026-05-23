/**
 * CorpusLinter — implements the AIP-10 lint kinds declared in
 * KNOWLEDGE.md.lints[]. Five canonical kinds + `custom` delegation
 * hook for hosts that ship their own checks.
 *
 * Lint kinds (per AIP-10 spec):
 *   - require-source — entries of kinds X MUST have ≥1 source ref
 *   - min-confidence — entries of kinds X SHOULD have confidence ≥ N
 *   - max-age        — entries of kinds X with updated_at older than N days
 *   - broken-ref     — sources/links/supersedes references that don't resolve
 *   - orphan         — entries that no other entry references (incoming = 0)
 *   - custom         — delegated to host-supplied callbacks keyed by lint id
 *
 * The linter assumes the workspace has already passed schema validation.
 * Running lint on invalid workspace yields garbage. Callers should run
 * the validator first; the writer pipeline enforces this.
 */

import type {
  CorpusWorkspaceSnapshot,
  LintIssue,
  LintReport,
  ParsedFile,
} from "../types.js"
import type { ClockPort } from "../ports/clock.port.js"

interface LintDeclaration {
  readonly id: string
  readonly kind:
    | "require-source"
    | "min-confidence"
    | "max-age"
    | "broken-ref"
    | "orphan"
    | "custom"
  readonly appliesTo: string
  readonly severity: "error" | "warn" | "info"
  readonly params?: Readonly<Record<string, unknown>>
}

export type CustomLintRunner = (
  decl: LintDeclaration,
  snapshot: CorpusWorkspaceSnapshot
) => readonly LintIssue[]

export interface CorpusLinterOptions {
  readonly clock: ClockPort
  /** Per-id implementations for `kind: custom` lints. */
  readonly customRunners?: Readonly<Record<string, CustomLintRunner>>
}

export class CorpusLinter {
  constructor(private readonly opts: CorpusLinterOptions) {}

  lint(snapshot: CorpusWorkspaceSnapshot): LintReport {
    const decls = extractLintDeclarations(snapshot)
    const issues: LintIssue[] = []

    for (const decl of decls) {
      switch (decl.kind) {
        case "require-source":
          issues.push(...this.lintRequireSource(decl, snapshot))
          break
        case "min-confidence":
          issues.push(...this.lintMinConfidence(decl, snapshot))
          break
        case "max-age":
          issues.push(...this.lintMaxAge(decl, snapshot))
          break
        case "broken-ref":
          issues.push(...this.lintBrokenRef(decl, snapshot))
          break
        case "orphan":
          issues.push(...this.lintOrphan(decl, snapshot))
          break
        case "custom": {
          const runner = this.opts.customRunners?.[decl.id]
          if (runner) issues.push(...runner(decl, snapshot))
          break
        }
      }
    }

    return reportFrom(issues)
  }

  // ── Lint implementations ────────────────────────────────────────────

  private lintRequireSource(
    decl: LintDeclaration,
    snapshot: CorpusWorkspaceSnapshot
  ): LintIssue[] {
    const out: LintIssue[] = []
    for (const entry of snapshot.entries) {
      if (!matchesAppliesTo(entry, decl.appliesTo)) continue
      const sources = (entry.frontmatter.sources ?? []) as readonly unknown[]
      if (sources.length === 0) {
        out.push({
          lintId: decl.id,
          path: entry.path,
          message: `entry has no sources[] (kind=${entry.frontmatter.kind ?? "?"})`,
          severity: decl.severity,
        })
      }
    }
    return out
  }

  private lintMinConfidence(
    decl: LintDeclaration,
    snapshot: CorpusWorkspaceSnapshot
  ): LintIssue[] {
    const min = numberParam(decl, "min", 0.5)
    const out: LintIssue[] = []
    for (const entry of snapshot.entries) {
      if (!matchesAppliesTo(entry, decl.appliesTo)) continue
      const c = entry.frontmatter.confidence
      if (typeof c === "number" && c < min) {
        out.push({
          lintId: decl.id,
          path: entry.path,
          message: `confidence ${c} < min ${min}`,
          severity: decl.severity,
        })
      }
    }
    return out
  }

  private lintMaxAge(
    decl: LintDeclaration,
    snapshot: CorpusWorkspaceSnapshot
  ): LintIssue[] {
    const days = numberParam(decl, "days", 365)
    const cutoffMs = this.opts.clock.nowMs() - days * 86_400_000
    const out: LintIssue[] = []
    for (const entry of snapshot.entries) {
      if (!matchesAppliesTo(entry, decl.appliesTo)) continue
      const updated = entry.frontmatter.updated_at
      if (typeof updated !== "string") continue
      const t = Date.parse(updated)
      if (Number.isNaN(t)) continue
      if (t < cutoffMs) {
        out.push({
          lintId: decl.id,
          path: entry.path,
          message: `updated_at ${updated} older than ${days}d`,
          severity: decl.severity,
        })
      }
    }
    return out
  }

  private lintBrokenRef(
    decl: LintDeclaration,
    snapshot: CorpusWorkspaceSnapshot
  ): LintIssue[] {
    const sourceIds = new Set<string>()
    for (const s of snapshot.sources) {
      const id = s.frontmatter.id
      if (typeof id === "string") sourceIds.add(id)
    }
    const entrySlugs = new Set<string>()
    for (const e of snapshot.entries) {
      const slug = e.frontmatter.slug
      if (typeof slug === "string") entrySlugs.add(slug)
    }

    const out: LintIssue[] = []
    for (const entry of snapshot.entries) {
      if (!matchesAppliesTo(entry, decl.appliesTo)) continue
      // sources[] — must resolve in source registry
      const sources = (entry.frontmatter.sources ?? []) as readonly unknown[]
      for (const s of sources) {
        if (typeof s === "string" && !sourceIds.has(s)) {
          out.push({
            lintId: decl.id,
            path: entry.path,
            message: `unresolved source ref: ${s}`,
            severity: decl.severity,
          })
        }
      }
      // supersedes / contradicts / links — must resolve in entry slug set
      for (const field of ["supersedes", "contradicts", "links"] as const) {
        const refs = (entry.frontmatter[field] ?? []) as readonly unknown[]
        for (const r of refs) {
          if (typeof r === "string" && !entrySlugs.has(r)) {
            out.push({
              lintId: decl.id,
              path: entry.path,
              message: `unresolved ${field} ref: ${r}`,
              severity: decl.severity,
            })
          }
        }
      }
    }
    return out
  }

  private lintOrphan(
    decl: LintDeclaration,
    snapshot: CorpusWorkspaceSnapshot
  ): LintIssue[] {
    // Build the incoming-reference set across all entries
    const incoming = new Set<string>()
    for (const e of snapshot.entries) {
      for (const field of ["supersedes", "contradicts", "links"] as const) {
        const refs = (e.frontmatter[field] ?? []) as readonly unknown[]
        for (const r of refs) {
          if (typeof r === "string") incoming.add(r)
        }
      }
    }

    const out: LintIssue[] = []
    for (const entry of snapshot.entries) {
      if (!matchesAppliesTo(entry, decl.appliesTo)) continue
      const slug = entry.frontmatter.slug
      if (typeof slug !== "string") continue
      if (!incoming.has(slug)) {
        out.push({
          lintId: decl.id,
          path: entry.path,
          message: `entry has no incoming references (orphan)`,
          severity: decl.severity,
        })
      }
    }
    return out
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractLintDeclarations(
  snapshot: CorpusWorkspaceSnapshot
): readonly LintDeclaration[] {
  if (!snapshot.workspace) return []
  const raw = (snapshot.workspace.frontmatter.lints ?? []) as readonly unknown[]
  const decls: LintDeclaration[] = []
  for (const r of raw) {
    if (!isLintDeclaration(r)) continue
    decls.push(r)
  }
  return decls
}

function isLintDeclaration(x: unknown): x is LintDeclaration {
  if (typeof x !== "object" || x === null) return false
  const o = x as Record<string, unknown>
  return (
    typeof o.id === "string" &&
    typeof o.kind === "string" &&
    typeof o.appliesTo === "string" &&
    typeof o.severity === "string"
  )
}

function matchesAppliesTo(entry: ParsedFile, appliesTo: string): boolean {
  if (appliesTo === "*") return true
  // Compare the AIP-10 `kind` field (lowercase) against the lint's
  // appliesTo PascalCase entity type. We compare case-insensitively
  // because entities are declared as e.g. "Principle" in KNOWLEDGE.md
  // but entries set `kind: principle`.
  const kind = entry.frontmatter.kind
  if (typeof kind !== "string") return false
  return appliesTo.toLowerCase() === kind.toLowerCase()
}

function numberParam(
  decl: LintDeclaration,
  key: string,
  fallback: number
): number {
  const params = decl.params ?? {}
  const v = (params as Record<string, unknown>)[key]
  return typeof v === "number" ? v : fallback
}

function reportFrom(issues: LintIssue[]): LintReport {
  let errorCount = 0
  let warnCount = 0
  let infoCount = 0
  for (const i of issues) {
    if (i.severity === "error") errorCount++
    else if (i.severity === "warn") warnCount++
    else infoCount++
  }
  return {
    issues: Object.freeze([...issues]),
    errorCount,
    warnCount,
    infoCount,
  }
}
