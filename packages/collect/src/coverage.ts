import type { Connector, ConnectorRegistry } from "./connector"
import type { CollectStore } from "./store"
import type { CoverageCell, Coverage, MetricName } from "./schemas"

/** The connectors whose declared primary counters decide `withPrimaryMetric`. */
export type CoverageConnectors = ConnectorRegistry | readonly Connector[]

const UNKNOWN = "unknown"
const NO_SUBJECT = "none"

/**
 * Coverage of what a store holds: platform (item source) x format x language x
 * subject. `withPrimaryMetric` uses the primary counter each connector
 * declares (matched on the item source); a source with no connector, or one
 * that declares no primary counter, never counts. An item with several
 * subjects counts in each subject's cell, one with none in the `none` cell. Missing format or language reads `unknown`.
 * Streams the store; memory is proportional to the number of items.
 */
export async function computeCoverage(store: CollectStore, connectors: CoverageConnectors = []): Promise<Coverage> {
  const primary: Record<string, MetricName | undefined> = {}
  const list: Connector[] = Array.isArray(connectors) ? [...connectors] : (connectors as ConnectorRegistry).list()
  for (const c of list) {
    primary[c.id] = c.counters.find((k) => k.primary)?.name
  }
  const metricsByItem = new Map<string, Set<string>>()
  for await (const o of store.observations()) {
    let set = metricsByItem.get(o.itemId)
    if (!set) metricsByItem.set(o.itemId, (set = new Set()))
    for (const k of Object.keys(o.metrics)) set.add(k)
  }
  const audience = new Set<string>()
  for await (const a of store.actors()) {
    if (a.audience.some((r) => (r.kind === "followers" || r.kind === "subscribers") && r.value !== undefined)) {
      audience.add(a.ref)
    }
  }
  const items = []
  const contentCounts = new Map<string, number>()
  for await (const item of store.items()) {
    items.push(item)
    if (item.contentId) contentCounts.set(item.contentId, (contentCounts.get(item.contentId) ?? 0) + 1)
  }

  const cells = new Map<string, CoverageCell>()
  for (const item of items) {
    const seen = metricsByItem.get(item.id)
    const main = primary[item.source]
    const hasPrimary = seen !== undefined && main !== undefined && seen.has(main)
    const hasAudience = item.authorRef !== undefined && audience.has(item.authorRef)
    const hasAge = item.postedAt !== undefined && seen !== undefined
    const hasAuthorId = item.authorRef !== undefined
    const unique = item.contentId !== undefined && contentCounts.get(item.contentId) === 1
    const eligible = hasAudience && hasPrimary && hasAge && hasAuthorId
    const subjects = [...new Set(item.subjects.map((s) => s.label))]
    for (const subject of subjects.length ? subjects : [NO_SUBJECT]) {
      const platform = item.source
      const format = item.format ?? UNKNOWN
      const language = item.language ?? UNKNOWN
      const key = JSON.stringify([platform, format, language, subject])
      let cell = cells.get(key)
      if (!cell) {
        cell = {
          platform,
          format,
          language,
          subject,
          items: 0,
          withAuthorAudience: 0,
          withPrimaryMetric: 0,
          withAge: 0,
          withAuthorId: 0,
          withUniqueContent: 0,
          eligible: 0,
        }
        cells.set(key, cell)
      }
      cell.items++
      if (hasAudience) cell.withAuthorAudience++
      if (hasPrimary) cell.withPrimaryMetric++
      if (hasAge) cell.withAge++
      if (hasAuthorId) cell.withAuthorId++
      if (unique) cell.withUniqueContent++
      if (eligible) cell.eligible++
    }
  }
  return {
    cells: [...cells.values()].sort((a, b) =>
      JSON.stringify([a.platform, a.format, a.language, a.subject]).localeCompare(
        JSON.stringify([b.platform, b.format, b.language, b.subject]),
      ),
    ),
  }
}
