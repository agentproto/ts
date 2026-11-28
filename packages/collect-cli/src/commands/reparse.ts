import { readdir } from "node:fs/promises"
import { resolve } from "node:path"
import {
  Actor,
  CollectItem,
  type CollectStore,
  type Connector,
  Observation,
  type ParseResult,
  Pickup,
  type RawIndexEntry,
  canonicalUrl,
  itemIdFromUrl,
  itemSeenKeys,
  seenKey,
  sha256Hex,
  stableStringify,
  textFingerprint,
} from "@agentproto/collect"
import { initStore } from "@agentproto/collect/node"
import { type ExitCode, type Io, UsageError, err, out, outJson } from "../io"
import { parse, positional } from "../args"
import { loadConnectors, storePathOf } from "../load"
import { CONNECTOR_OPTION } from "./connectors"
import { open } from "./shared"

interface Totals {
  raws: number
  parsed: number
  failedRaws: number
  items: number
  duplicates: number
  observations: number
  actors: number
  pickups: number
  problems: string[]
}

/** Rebuild one raw's records into `target`, with the same dedup levels the engine applies. */
async function ingestRaw(
  target: CollectStore,
  connector: Connector,
  entry: RawIndexEntry,
  position: number,
  bytes: Uint8Array,
  writtenActors: Set<string>,
  totals: Totals,
): Promise<void> {
  const parsed: ParseResult = await connector.parse({
    connector: connector.id,
    task: { id: `reparse:${entry.hash.slice(0, 12)}`, params: {} },
    raw: { ref: entry.ref, url: entry.url, ext: entry.ext, bytes, httpStatus: entry.httpStatus, fetchedAt: entry.fetchedAt, transport: entry.transport as never },
  })
  const keyOf = (kind: string, i: number) => sha256Hex(JSON.stringify([entry.runId ?? "", "reparse", position, entry.hash, kind, i]))
  const items: CollectItem[] = []
  for (const p of parsed.items ?? []) {
    const canonical = p.canonicalUrl ?? (p.url ? canonicalUrl(p.url) : undefined)
    const id = p.id ?? (canonical ? await itemIdFromUrl(p.source, canonical) : undefined)
    if (!id) throw new Error("an item needs an id or a url")
    const contentId = p.contentId ?? (p.text ? await textFingerprint(p.text) : undefined)
    const item = CollectItem.parse({
      ...p,
      id,
      canonicalUrl: canonical,
      contentId,
      firstSeenAt: p.firstSeenAt ?? entry.fetchedAt,
      runId: entry.runId,
      rawRefs: [...new Set([...(p.rawRefs ?? []), entry.ref])],
    })
    if (connector.ext && item.ext !== undefined) connector.ext.parse(item.ext)
    items.push(item)
  }
  const observations: Observation[] = []
  for (const [i, o] of (parsed.observations ?? []).entries()) {
    observations.push(
      Observation.parse({ measuredAt: entry.fetchedAt, transport: entry.transport, rawRef: entry.ref, ...o, runId: entry.runId, taskId: "reparse", recordKey: await keyOf("observation", i) }),
    )
  }
  const pickups: Pickup[] = []
  for (const [i, p] of (parsed.pickups ?? []).entries()) {
    pickups.push(
      Pickup.parse({
        firstSeenAt: entry.fetchedAt,
        measuredAt: entry.fetchedAt,
        ...p,
        runId: entry.runId,
        taskId: "reparse",
        recordKey: await keyOf("pickup", i),
        evidence: { rawRef: entry.ref, ...p.evidence },
      }),
    )
  }
  const actors = (parsed.actors ?? []).map((a) => Actor.parse(a))

  // Everything parsed and validated: now write.
  const idMap = new Map<string, string>()
  const resolveId = async (id: string) => idMap.get(id) ?? (await target.seenGet(seenKey("id", id))) ?? id
  const created: CollectItem[] = []
  for (const item of items) {
    const idKey = seenKey("id", item.id)
    let owner = await target.seenGet(idKey)
    if (owner === undefined && (await target.seenHas(idKey))) owner = item.id
    let level = owner ? 1 : 0
    if (!owner && item.canonicalUrl) {
      owner = await target.seenGet(seenKey("url", item.canonicalUrl))
      if (owner) level = 2
    }
    if (owner) {
      idMap.set(item.id, owner)
      if (level === 2) await target.seenAdd(idKey, owner)
      totals.duplicates++
      continue
    }
    await target.upsertItem(item)
    for (const k of itemSeenKeys(item)) await target.seenAdd(k, item.id)
    created.push(item)
    totals.items++
  }
  for (const item of created) {
    if (!item.links) continue
    const links = { ...item.links }
    let changed = false
    for (const name of ["target", "parent", "root", "quoted"] as const) {
      const v = links[name]
      if (v === undefined) continue
      const r = await resolveId(v)
      if (r !== v) {
        links[name] = r
        changed = true
      }
    }
    if (changed) await target.upsertItem({ ...item, links })
  }
  for (const o of observations) {
    await target.appendObservation({ ...o, itemId: await resolveId(o.itemId) })
    totals.observations++
  }
  for (const a of actors) {
    const k = stableStringify(a)
    if (writtenActors.has(k)) continue
    writtenActors.add(k)
    await target.appendActor(a)
    totals.actors++
  }
  for (const p of pickups) {
    await target.appendPickup({ ...p, itemId: await resolveId(p.itemId), ...(p.pickupItemId ? { pickupItemId: await resolveId(p.pickupItemId) } : {}) })
    totals.pickups++
  }
}

/**
 * Rebuild items, observations, actors and pickups from the stored raw
 * responses, through each connector's pure `parse`. No network.
 *
 * The source store is never modified: the result goes into a new store
 * (`--into`), which must not exist yet or be empty. Raw bodies are copied
 * with their index lines, so the new store is complete on its own. Run
 * history is not copied. To adopt the result, check it, then swap the
 * directories yourself.
 */
export async function runReparse(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { ...CONNECTOR_OPTION, store: { type: "string" }, into: { type: "string" } })
  positional(positionals, "none", 0)
  if (!values.into) throw new UsageError("reparse needs --into <new store path>: the source store is never rewritten in place")
  const sourcePath = storePathOf(io, values.store)
  const targetPath = resolve(io.cwd, values.into)
  if (sourcePath === targetPath) throw new UsageError("--into must be a different path than the source store")
  const existing = await readdir(targetPath).catch(() => [] as string[])
  if (existing.length > 0) throw new UsageError(`--into ${values.into} is not empty`)

  const { registry } = await loadConnectors(values.connector ?? [], io.cwd)
  const source = await open(sourcePath)
  // Hold the source lock while reading, so no run writes under us.
  const lock = await source.acquireLock()
  const totals: Totals = { raws: 0, parsed: 0, failedRaws: 0, items: 0, duplicates: 0, observations: 0, actors: 0, pickups: 0, problems: [] }
  try {
    const target = await initStore(targetPath)
    const writtenActors = new Set<string>()
    let position = 0
    for await (const entry of source.rawIndex()) {
      totals.raws++
      const bytes = await source.getRaw(entry.ref)
      if (!bytes) {
        totals.problems.push(`${entry.ref}: raw body is missing`)
        continue
      }
      await target.putRaw({
        connector: entry.connector,
        ext: entry.ext,
        bytes,
        url: entry.url,
        fetchedAt: entry.fetchedAt,
        httpStatus: entry.httpStatus,
        transport: entry.transport,
        runId: entry.runId,
        failure: entry.failure,
      })
      if (entry.failure) {
        totals.failedRaws++
        position++
        continue
      }
      const connector = registry.get(entry.connector)
      if (!connector) {
        const msg = `connector "${entry.connector}" is not registered (load it with --connector <module>)`
        if (!totals.problems.includes(msg)) totals.problems.push(msg)
        position++
        continue
      }
      try {
        await ingestRaw(target, connector, entry, position, bytes, writtenActors, totals)
        totals.parsed++
      } catch (e) {
        totals.problems.push(`${entry.ref}: ${e instanceof Error ? e.message : String(e)}`)
      }
      position++
    }
  } finally {
    await lock.release()
  }
  if (values.json) outJson(io, { into: targetPath, ...totals })
  else {
    out(io, `reparsed ${totals.parsed} of ${totals.raws} raw(s) into ${targetPath}`)
    out(io, `items=${totals.items} duplicates=${totals.duplicates} observations=${totals.observations} actors=${totals.actors} pickups=${totals.pickups} failedRaws=${totals.failedRaws}`)
    for (const p of totals.problems) err(io, `problem: ${p}`)
  }
  return totals.problems.length > 0 ? 1 : 0
}
