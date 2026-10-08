/**
 * Poison-item quarantine for polled sentinel batches.
 *
 * A provider that cannot turn a polled item into a `SentinelEvent` reports it
 * as malformed. The runtime must not advance (and acknowledge) the cursor past
 * it without a durable trace, or the item is lost the moment the remote drops
 * acked rows — yet it also must not stall the subscription forever on an item
 * that will never parse. So: record it here (fsynced append), THEN ack.
 *
 * Records carry identifiers, the parse error and a digest only — never the
 * envelope `data` or any credential — so the file is safe to inspect and ship
 * in a bug report. Recording is idempotent per
 * (sentinel, provider, remote delivery id | seq, digest): a redelivered batch
 * after a crash between "quarantined" and "acked" does not duplicate lines.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { appendLineDurableSync } from "./durable-file.js"
import type { SentinelMalformedItem } from "./sentinel-providers/types.js"

export interface SentinelQuarantineRecord {
  /** Idempotency key. */
  key: string
  quarantinedAt: string
  sentinelId: string
  provider: string
  remoteId?: string
  seq?: number
  remoteDeliveryId?: string
  error: string
  excerpt?: SentinelMalformedItem["excerpt"]
  digest?: string
  bytes?: number
}

export interface SentinelQuarantine {
  /** Durably record one poison item (idempotent). Throws when the write
   *  fails — the caller must then NOT acknowledge the cursor. */
  record(input: {
    sentinelId: string
    provider: string
    remoteId?: string
    item: SentinelMalformedItem
  }): SentinelQuarantineRecord
  list(filter?: { sentinelId?: string }): SentinelQuarantineRecord[]
}

export interface SentinelQuarantineOptions {
  /** JSONL path. Omitted ⇒ in-memory only (tests). */
  filePath?: string
  nowMs?: () => number
}

export function defaultSentinelQuarantinePath(): string {
  return resolve(process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto"), "sentinel-quarantine.jsonl")
}

function keyFor(sentinelId: string, provider: string, item: SentinelMalformedItem): string {
  const identity = item.remoteDeliveryId ?? (item.seq !== undefined ? `seq:${item.seq}` : "")
  return [sentinelId, provider, identity, item.digest ?? ""].join("|")
}

function loadFile(filePath: string): SentinelQuarantineRecord[] {
  if (!existsSync(filePath)) return []
  const out: SentinelQuarantineRecord[] = []
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (line.trim() === "") continue
    try {
      const rec = JSON.parse(line) as SentinelQuarantineRecord
      if (rec && typeof rec.key === "string") out.push(rec)
    } catch {
      // a torn trailing line (crash mid-append) — skip, the item re-quarantines
    }
  }
  return out
}

export function createSentinelQuarantine(opts: SentinelQuarantineOptions = {}): SentinelQuarantine {
  const nowMs = opts.nowMs ?? Date.now
  const records = new Map<string, SentinelQuarantineRecord>()
  let loaded = false

  function ensureLoaded(): void {
    if (loaded) return
    if (opts.filePath) for (const rec of loadFile(opts.filePath)) records.set(rec.key, rec)
    loaded = true
  }

  return {
    record({ sentinelId, provider, remoteId, item }): SentinelQuarantineRecord {
      ensureLoaded()
      const key = keyFor(sentinelId, provider, item)
      const existing = records.get(key)
      if (existing) return existing
      const rec: SentinelQuarantineRecord = {
        key,
        quarantinedAt: new Date(nowMs()).toISOString(),
        sentinelId,
        provider,
        ...(remoteId !== undefined ? { remoteId } : {}),
        ...(item.seq !== undefined ? { seq: item.seq } : {}),
        ...(item.remoteDeliveryId !== undefined ? { remoteDeliveryId: item.remoteDeliveryId } : {}),
        error: item.error,
        ...(item.excerpt ? { excerpt: item.excerpt } : {}),
        ...(item.digest !== undefined ? { digest: item.digest } : {}),
        ...(item.bytes !== undefined ? { bytes: item.bytes } : {}),
      }
      if (opts.filePath) appendLineDurableSync(opts.filePath, JSON.stringify(rec))
      records.set(key, rec)
      return rec
    },

    list(filter): SentinelQuarantineRecord[] {
      ensureLoaded()
      const all = [...records.values()]
      return filter?.sentinelId ? all.filter(r => r.sentinelId === filter.sentinelId) : all
    },
  }
}
