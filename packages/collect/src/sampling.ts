import type { MetricName, Recipe } from "./schemas"
import type { SamplingRecord } from "./store"

export type SamplingConfig = NonNullable<Recipe["sampling"]>

/** What the sampler needs to know about one candidate item. */
export interface SamplingCandidate {
  /** Stable item id. */
  id: string
  kind?: string
  /** Metric values the parse returned for this item. */
  metrics: Partial<Record<MetricName, number>>
  /** Canonical URL of the item. */
  url?: string
  /** `links.target` of the item, when set. */
  target?: string
  outboundLinks?: string[]
}

export type SamplingDecision = Omit<SamplingRecord, "at" | "connector" | "taskId">

/** Small seeded PRNG: the same seed always gives the same sequence in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 32-bit FNV-1a hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Host of a URL, lower-cased, without a trailing DNS root dot and without a leading `www.`. No public-suffix list. */
export function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "")
    return host || undefined
  } catch {
    return undefined
  }
}

/**
 * The host a candidate counts against: for a submission, the host of the
 * article it points to (`links.target` when it is a URL, else the first
 * outbound link); otherwise, or when neither is a URL, the host of its own URL.
 */
export function candidateDomain(c: SamplingCandidate): string | undefined {
  if (c.kind === "submission") {
    const t = domainOf(c.target) ?? domainOf(c.outboundLinks?.[0])
    if (t) return t
  }
  return domainOf(c.url)
}

/**
 * Shuffle by a seeded Fisher-Yates over ids sorted lexicographically, so the
 * order depends only on the seed, the batch key and the set of ids.
 */
export function seededOrder<T extends { id: string }>(items: T[], seed: number, batchKey: string): T[] {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const rnd = mulberry32((seed ^ hashString(batchKey)) >>> 0)
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const tmp = sorted[i]!
    sorted[i] = sorted[j]!
    sorted[j] = tmp
  }
  return sorted
}

export interface SamplingPlan {
  /** New decisions to persist, one per distinct candidate, in decision order. */
  lines: SamplingDecision[]
  /** Ids (representatives and their repeats or URL aliases) whose records must not be written. */
  dropped: Set<string>
}

export interface Sampler {
  /**
   * Decide a batch without changing any counter. Candidates already decided
   * (in this run or in the journal) reuse their decision and produce no line.
   * `known` holds the ids of candidates whose item already exists: they are not
   * sampled and use no budget. Repeats of an id, and candidates sharing a URL,
   * form one group that gets one decision, taken on the member with the highest
   * metric value (ties: smaller URL, then smaller id).
   */
  plan(batchKey: string, candidates: SamplingCandidate[], known?: ReadonlySet<string>): SamplingPlan
  /** Take a plan's lines into the counters. Call it once they are persisted. */
  apply(lines: SamplingDecision[]): void
}

interface Group {
  members: SamplingCandidate[]
}

/**
 * Counters live in the sampler and are rebuilt from `prior` (the lines of
 * `sampling.jsonl`), so a resumed run takes the same decisions.
 */
export function createSampler(config: SamplingConfig, primary: MetricName | undefined, prior: SamplingDecision[]): Sampler {
  const bands = config.bands ?? []
  const seed = config.seed
  const decided = new Map<string, SamplingDecision>()
  const decidedUrl = new Map<string, SamplingDecision>()
  const bandKept = bands.map(() => 0)
  const domainKept = new Map<string, number>()

  function apply(lines: SamplingDecision[]) {
    for (const d of lines) {
      if (decided.has(d.candidate)) continue
      decided.set(d.candidate, d)
      if (d.url && !decidedUrl.has(d.url)) decidedUrl.set(d.url, d)
      if (d.decision !== "kept") continue
      if (d.band !== undefined && d.band < bandKept.length) bandKept[d.band]!++
      if (d.domain) domainKept.set(d.domain, (domainKept.get(d.domain) ?? 0) + 1)
    }
  }
  apply(prior)

  const bandMetric = (i: number) => bands[i]!.metric ?? primary
  /** The value a group's representative is picked on: the first band metric it has, else the primary counter. */
  function rank(c: SamplingCandidate): number {
    for (let i = 0; i < bands.length; i++) {
      const m = bandMetric(i)
      const v = m ? c.metrics[m] : undefined
      if (v !== undefined) return v
    }
    const v = primary ? c.metrics[primary] : undefined
    return v ?? Number.NEGATIVE_INFINITY
  }
  function representative(g: Group): SamplingCandidate {
    return [...g.members].sort((a, b) => {
      const d = rank(b) - rank(a)
      if (d !== 0 && !Number.isNaN(d)) return d
      const ua = a.url ?? "￿"
      const ub = b.url ?? "￿"
      if (ua !== ub) return ua < ub ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })[0]!
  }

  function plan(batchKey: string, candidates: SamplingCandidate[], known: ReadonlySet<string> = new Set()): SamplingPlan {
    // Groups: one per id, merged when two ids share a URL.
    const groups: Group[] = []
    const byId = new Map<string, Group>()
    const byUrl = new Map<string, Group>()
    for (const c of candidates) {
      let g = byId.get(c.id) ?? (c.url ? byUrl.get(c.url) : undefined)
      if (!g) {
        g = { members: [] }
        groups.push(g)
      }
      const other = c.url ? byUrl.get(c.url) : undefined
      if (other && other !== g) {
        for (const m of other.members) {
          g.members.push(m)
          byId.set(m.id, g)
          if (m.url) byUrl.set(m.url, g)
        }
        groups.splice(groups.indexOf(other), 1)
      }
      g.members.push(c)
      byId.set(c.id, g)
      if (c.url) byUrl.set(c.url, g)
    }

    // Every group that is not already an item is ordered together, those decided in the journal included,
    // so a task redone after a crash takes its remaining decisions in the same positions as an uninterrupted one.
    const dropped = new Set<string>()
    const pool: Array<{ id: string; g: Group; rep: SamplingCandidate; earlier?: SamplingDecision }> = []
    for (const g of groups) {
      let earlier: SamplingDecision | undefined
      for (const m of g.members) earlier ??= decided.get(m.id) ?? (m.url ? decidedUrl.get(m.url) : undefined)
      // An item that already exists always wins over an earlier drop: it is not sampled and uses no budget.
      // One kept earlier stays in the ordering, so a replayed task keeps its positions.
      if (g.members.some((m) => known.has(m.id)) && earlier?.decision !== "kept") continue
      const rep = representative(g)
      pool.push({ id: rep.id, g, rep, earlier })
    }

    // Counters as they will be once this plan is applied; the real ones stay untouched until `apply`.
    const bandLocal = [...bandKept]
    const domainLocal = new Map<string, number>()
    const domainCount = (d: string) => (domainKept.get(d) ?? 0) + (domainLocal.get(d) ?? 0)

    function decideOne(c: SamplingCandidate): SamplingDecision {
      const domain = candidateDomain(c)
      const base = {
        candidate: c.id,
        ...(c.url ? { url: c.url } : {}),
        ...(domain ? { domain } : {}),
        ...(seed !== undefined ? { seed } : {}),
      }
      const drop = (rule: string, band?: number): SamplingDecision => ({
        ...base,
        decision: "dropped",
        rule,
        ...(band !== undefined ? { band } : {}),
      })
      let band: number | undefined
      if (bands.length > 0) {
        let missing = true
        for (let i = 0; i < bands.length; i++) {
          const m = bandMetric(i)
          const v = m ? c.metrics[m] : undefined
          if (v === undefined) continue
          missing = false
          const b = bands[i]!
          if ((b.min === undefined || v >= b.min) && (b.max === undefined || v <= b.max)) {
            band = i
            break
          }
        }
        if (band === undefined) {
          if (!missing) return drop("out_of_bands")
          if (!config.keepMissingMetric) return drop("no_metric")
        }
      }
      if (band !== undefined) {
        const quota = bands[band]!.quota
        if (quota !== undefined && bandLocal[band]! >= quota) return drop("band_quota", band)
      }
      if (domain && config.perDomainCap !== undefined && domainCount(domain) >= config.perDomainCap) {
        return drop("domain_cap", band)
      }
      if (band !== undefined) bandLocal[band]!++
      if (domain) domainLocal.set(domain, (domainLocal.get(domain) ?? 0) + 1)
      return { ...base, decision: "kept", ...(band !== undefined ? { band } : {}) }
    }

    const ordered = seed !== undefined ? seededOrder(pool, seed, batchKey) : pool
    const lines: SamplingDecision[] = []
    for (const { g, rep, earlier } of ordered) {
      if (earlier) {
        if (earlier.decision === "dropped") for (const m of g.members) dropped.add(m.id)
        continue
      }
      const d = decideOne(rep)
      lines.push(d)
      if (d.decision === "dropped") for (const m of g.members) dropped.add(m.id)
    }
    return { lines, dropped }
  }

  return { plan, apply }
}
