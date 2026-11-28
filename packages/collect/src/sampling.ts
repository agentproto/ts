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

/** Host of a URL, lower-cased, with a leading `www.` removed. No public-suffix list. */
export function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "")
    return host || undefined
  } catch {
    return undefined
  }
}

/**
 * The host a candidate counts against: for a submission, the host of the
 * article it points to (`links.target` when it is a URL, else the first
 * outbound link); otherwise the host of its own canonical URL.
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

export interface Sampler {
  /**
   * Decide a batch. Returns one decision per distinct candidate id, in decision
   * order; a candidate already decided (earlier in the run, or in `prior`)
   * returns its earlier decision with `fresh: false`.
   */
  decide(batchKey: string, candidates: SamplingCandidate[]): Array<{ decision: SamplingDecision; fresh: boolean }>
}

/**
 * Counters live in the sampler and are rebuilt from `prior` (the lines of
 * `sampling.jsonl`), so a resumed run takes the same decisions.
 */
export function createSampler(config: SamplingConfig, primary: MetricName | undefined, prior: SamplingRecord[]): Sampler {
  const bands = config.bands ?? []
  const decided = new Map<string, SamplingDecision>()
  const bandKept = bands.map(() => 0)
  const domainKept = new Map<string, number>()
  for (const r of prior) {
    if (decided.has(r.candidate)) continue
    const { at: _at, connector: _c, taskId: _t, ...decision } = r
    decided.set(r.candidate, decision)
    if (r.decision === "kept") {
      if (r.band !== undefined && r.band < bandKept.length) bandKept[r.band]!++
      if (r.domain) domainKept.set(r.domain, (domainKept.get(r.domain) ?? 0) + 1)
    }
  }
  const seed = config.seed

  function decideOne(c: SamplingCandidate): SamplingDecision {
    const domain = candidateDomain(c)
    const base = { candidate: c.id, ...(domain ? { domain } : {}), ...(seed !== undefined ? { seed } : {}) }
    const dropped = (rule: string, band?: number): SamplingDecision => ({
      ...base,
      decision: "dropped",
      rule,
      ...(band !== undefined ? { band } : {}),
    })
    let band: number | undefined
    if (bands.length > 0) {
      const metric = (i: number) => bands[i]!.metric ?? primary
      let missing = true
      for (let i = 0; i < bands.length; i++) {
        const name = metric(i)
        const v = name ? c.metrics[name] : undefined
        if (v === undefined) continue
        missing = false
        const b = bands[i]!
        if ((b.min === undefined || v >= b.min) && (b.max === undefined || v <= b.max)) {
          band = i
          break
        }
      }
      if (band === undefined) {
        if (missing && !config.keepMissingMetric) return dropped("no_metric")
        if (!missing) return dropped("out_of_bands")
      }
    }
    if (band !== undefined) {
      const quota = bands[band]!.quota
      if (quota !== undefined && bandKept[band]! >= quota) return dropped("band_quota", band)
    }
    if (domain && config.perDomainCap !== undefined && (domainKept.get(domain) ?? 0) >= config.perDomainCap) {
      return dropped("domain_cap", band)
    }
    if (band !== undefined) bandKept[band]!++
    if (domain) domainKept.set(domain, (domainKept.get(domain) ?? 0) + 1)
    return { ...base, decision: "kept", ...(band !== undefined ? { band } : {}) }
  }

  return {
    decide(batchKey, candidates) {
      const unique: SamplingCandidate[] = []
      const seenHere = new Set<string>()
      for (const c of candidates) {
        if (seenHere.has(c.id)) continue
        seenHere.add(c.id)
        unique.push(c)
      }
      const ordered = seed !== undefined ? seededOrder(unique, seed, batchKey) : unique
      return ordered.map((c) => {
        const earlier = decided.get(c.id)
        if (earlier) return { decision: earlier, fresh: false }
        const decision = decideOne(c)
        decided.set(c.id, decision)
        return { decision, fresh: true }
      })
    },
  }
}
