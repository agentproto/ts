/**
 * PlaybookRegistry — load + index every AIP-12 PLAYBOOK.md in the
 * workspace's `playbooks/` directory.
 *
 * The registry is a thin read layer over a `CorpusWorkspaceSnapshot`:
 *   - parses raw frontmatter into the typed `Playbook` shape,
 *   - exposes O(1) lookups by slug,
 *   - filters by status / kind / target operator on listBy().
 *
 * No FsPort dependency — the snapshot already carries the parsed
 * files. The lifecycle layer is the one that writes; this registry
 * is pure read.
 */

import type { CorpusWorkspaceSnapshot, ParsedFile } from "../types.js"
import type {
  Playbook,
  PlaybookCorpusMeta,
  PlaybookKind,
  PlaybookQuery,
  PlaybookStatus,
  PlaybookTarget,
} from "./types.js"

export interface PlaybookRegistryOptions {
  readonly snapshot: CorpusWorkspaceSnapshot
}

export class PlaybookRegistry {
  private readonly bySlug: ReadonlyMap<string, Playbook>
  private readonly all: readonly Playbook[]

  constructor(opts: PlaybookRegistryOptions) {
    const parsed: Playbook[] = []
    for (const file of opts.snapshot.playbooks) {
      const playbook = parsePlaybook(file)
      if (playbook) parsed.push(playbook)
    }
    parsed.sort((a, b) => b.priority - a.priority)
    this.all = Object.freeze(parsed)
    const map = new Map<string, Playbook>()
    for (const p of parsed) map.set(p.slug, p)
    this.bySlug = map
  }

  list(): readonly Playbook[] {
    return this.all
  }

  bySlugOrNull(slug: string): Playbook | null {
    return this.bySlug.get(slug) ?? null
  }

  listBy(query: PlaybookQuery = {}): readonly Playbook[] {
    return this.all.filter((p) => matches(p, query))
  }
}

// ── Parsing ─────────────────────────────────────────────────────────

function parsePlaybook(file: ParsedFile): Playbook | null {
  const fm = file.frontmatter
  const slug = typeof fm.slug === "string" ? fm.slug : null
  const title = typeof fm.title === "string" ? fm.title : null
  if (!slug || !title) return null

  const status = readStatus(fm)
  const kind: PlaybookKind = fm.kind === "block-replacement"
    ? "block-replacement"
    : "overlay"
  const priority = typeof fm.priority === "number" ? fm.priority : 100
  const bindsOperator =
    typeof fm.binds_operator === "string" ? fm.binds_operator : undefined
  const targets = readTargets(fm)
  const supersedes = readStringArray(fm.supersedes)
  const corpus = readCorpusMeta(fm)

  return Object.freeze({
    path: file.path,
    slug,
    title,
    status,
    kind,
    priority,
    targets,
    bindsOperator,
    supersedes,
    body: file.body,
    corpus,
    versionToken: file.versionToken,
    file,
  })
}

function readStatus(fm: Readonly<Record<string, unknown>>): PlaybookStatus {
  const s = fm.status
  if (s === "active" || s === "shadow" || s === "archived") return s
  return "shadow"
}

function readTargets(
  fm: Readonly<Record<string, unknown>>
): readonly PlaybookTarget[] {
  const raw = fm.targets
  if (!Array.isArray(raw)) return []
  const out: PlaybookTarget[] = []
  for (const t of raw as readonly unknown[]) {
    if (typeof t !== "object" || t === null) continue
    const o = t as { kind?: unknown; ref?: unknown }
    if (
      typeof o.ref !== "string" ||
      (o.kind !== "operator" &&
        o.kind !== "role" &&
        o.kind !== "skill" &&
        o.kind !== "runtime")
    )
      continue
    out.push({ kind: o.kind, ref: o.ref })
  }
  return Object.freeze(out)
}

function readStringArray(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return []
  return Object.freeze(
    (v as readonly unknown[]).filter((x): x is string => typeof x === "string")
  )
}

function readCorpusMeta(
  fm: Readonly<Record<string, unknown>>
): PlaybookCorpusMeta {
  const meta = (fm.metadata as { corpus?: unknown })?.corpus
  if (!meta || typeof meta !== "object") return {}
  return Object.freeze(meta as PlaybookCorpusMeta)
}

// ── Query matching ─────────────────────────────────────────────────

function matches(p: Playbook, q: PlaybookQuery): boolean {
  if (q.status !== undefined) {
    const wanted = Array.isArray(q.status) ? q.status : [q.status]
    if (!wanted.includes(p.status)) return false
  }
  if (q.kind !== undefined && p.kind !== q.kind) return false
  if (q.forOperatorSlug !== undefined) {
    const slugs = Array.isArray(q.forOperatorSlug)
      ? q.forOperatorSlug
      : [q.forOperatorSlug]
    return slugs.some(
      (slug) =>
        p.bindsOperator === slug ||
        p.targets.some(
          (t) => t.kind === "operator" && refMatchesSlug(t.ref, slug)
        )
    )
  }
  if (q.operatorRef !== undefined) {
    return p.targets.some(
      (t) => t.kind === "operator" && t.ref === q.operatorRef
    )
  }
  return true
}

function refMatchesSlug(ref: string, slug: string): boolean {
  // AIP-12 target.ref shapes: "marketing-analyst", "operator/marketing-analyst",
  // "ws://operators/marketing-analyst", or globs like "operator/*".
  if (ref === slug) return true
  if (ref === `operator/${slug}`) return true
  if (ref === `ws://operators/${slug}`) return true
  if (ref === "operator/*" || ref === "ws://operators/*") return true
  return false
}
