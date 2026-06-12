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

import {
  compileLegacyPlaybookBinding,
  createAxisRegistry,
  matchesSelector,
  parseSelectorFrontmatter,
} from "../binding/index.js"
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
  // Explicit `selector:` wins; malformed or absent falls back to the
  // legacy compile so an old or broken file keeps its targets binding.
  const explicitSelector = parseSelectorFrontmatter(fm.selector)
  const selector =
    explicitSelector ?? compileLegacyPlaybookBinding(targets, bindsOperator)
  const selectorSource = explicitSelector ? "selector" : "legacy"

  return Object.freeze({
    path: file.path,
    slug,
    title,
    status,
    kind,
    priority,
    targets,
    bindsOperator,
    selector,
    selectorSource,
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

const AXES = createAxisRegistry()

function matches(p: Playbook, q: PlaybookQuery): boolean {
  if (q.status !== undefined) {
    const wanted = Array.isArray(q.status) ? q.status : [q.status]
    if (!wanted.includes(p.status)) return false
  }
  if (q.kind !== undefined && p.kind !== q.kind) return false
  if (q.dimensions !== undefined) {
    return matchesSelector(p.selector, q.dimensions, { axes: AXES })
  }
  if (q.forOperatorSlug !== undefined) {
    // Legacy sugar: the caller's slugs are axis-ambiguous handles, so
    // try them on both axes — exactly the old either-axis behavior.
    const slugs = Array.isArray(q.forOperatorSlug)
      ? q.forOperatorSlug
      : [q.forOperatorSlug]
    return matchesSelector(
      p.selector,
      { identity: slugs, role: slugs },
      { axes: AXES }
    )
  }
  if (q.operatorRef !== undefined) {
    return p.targets.some(
      (t) => t.kind === "operator" && t.ref === q.operatorRef
    )
  }
  return true
}
