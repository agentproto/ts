import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Actor, CollectItem, Observation, Pickup, Recipe } from "../schemas"

const ROOT = join(__dirname, "..", "..", ".test-stores")

/** Fresh directory under the package (never the system temp dir). */
export async function testDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  await mkdir(ROOT, { recursive: true })
  const path = await mkdtemp(join(ROOT, "s-"))
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) }
}

export const T = "2026-11-28T10:00:00Z"

export const item = (n: number, extra: Partial<CollectItem> = {}): CollectItem => ({
  id: `hn:${n}`,
  source: "hn",
  kind: "post",
  subjects: [],
  firstSeenAt: T,
  canonicalUrl: `https://example.com/${n}`,
  contentId: `c${n}`,
  ...extra,
})
export const observation = (n: number, views: number): Observation => ({
  itemId: `hn:${n}`,
  measuredAt: T,
  metrics: { views },
})
export const actor = (name: string): Actor => ({ ref: `hn:${name}`, audience: [] })
export const pickup = (n: number): Pickup => ({
  itemId: `hn:${n}`,
  kind: "crosspost",
  relation: "citation",
  evidence: { similarity: 0.9 },
  method: "near_text",
  verified: false,
  firstSeenAt: T,
  measuredAt: T,
})
export const recipe: Recipe = { sources: [{ connector: "hn", queries: [], }], workers: 8 }
