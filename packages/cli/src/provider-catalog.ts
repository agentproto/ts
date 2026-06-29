/**
 * Live-on-setup provider catalog cache.
 *
 * When a user runs `agentproto auth provider set elevenlabs <key>`, we
 * eagerly fetch *their* account catalog (which voices/models exist — the
 * AVAILABILITY axis) and cache it under `~/.agentproto/catalog/<id>.json`.
 * At `serve` boot the overlay loader reads those files and layers them over
 * the committed baseline via `registerCatalogOverlay`.
 *
 * PRICING never comes from here — it stays pinned in the committed
 * `@agentproto/model-catalog` package, refreshed only via the reviewed
 * catalog-sync PR. This path only refreshes account-specific availability.
 *
 * The raw → CatalogVoice mapping is the SAME deterministic mapper the
 * build-time generator uses (`@agentproto/model-catalog/providers`), so the
 * live overlay and the committed baseline are always shape-compatible.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import {
  ElevenLabsVoicesSnapshotSchema,
  MinimaxVoicesSnapshotSchema,
  mapElevenLabsVoices,
  mapMinimaxVoices,
} from "@agentproto/model-catalog/providers"
import type { CatalogVoice } from "@agentproto/model-catalog/schema/voice"

/** Default fetch timeout — a slow provider must not wedge `provider set`. */
const FETCH_TIMEOUT_MS = 15_000

// ── Cache file shape ──────────────────────────────────────────────────────

export interface CatalogCacheFile {
  version: 1
  /** Provider key (`elevenlabs`, `minimax`). */
  provider: string
  /** Catalog kind — only `voice` today. */
  kind: "voice"
  /** sha256 of the raw provider response — drives the smart-skip rewrite. */
  sourceSha: string
  /** Wall-clock ISO timestamp of the fetch. */
  fetchedAt: string
  /** Mapped, baseline-compatible voices. */
  voices: CatalogVoice[]
}

// ── Provider source descriptors ───────────────────────────────────────────
// Mirror the catalog-sync CatalogSources (provider API facts). Kept inline so
// the CLI need not depend on the build-time catalog-sync package.

interface VoiceSource {
  /** Cache id / filename stem (`voice-elevenlabs`). */
  id: string
  /** Build the authed request + map the response to voices. */
  fetchVoices(apiKey: string, baseUrl?: string): Promise<CatalogVoice[]>
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }
  return res.json()
}

const VOICE_SOURCES: Record<string, VoiceSource> = {
  elevenlabs: {
    id: "voice-elevenlabs",
    async fetchVoices(apiKey, baseUrl) {
      const base = baseUrl ?? "https://api.elevenlabs.io"
      const raw = await fetchJson(`${base}/v1/voices`, {
        method: "GET",
        headers: { "xi-api-key": apiKey },
      })
      return mapElevenLabsVoices(ElevenLabsVoicesSnapshotSchema.parse(raw))
    },
  },
  minimax: {
    id: "voice-minimax",
    async fetchVoices(apiKey, baseUrl) {
      const base = baseUrl ?? "https://api.minimax.io"
      const raw = await fetchJson(`${base}/v1/get_voice`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ voice_type: "system" }),
      })
      return mapMinimaxVoices(MinimaxVoicesSnapshotSchema.parse(raw))
    },
  },
}

/** Providers that expose a live, account-specific catalog. */
export function hasProviderCatalog(provider: string): boolean {
  return provider in VOICE_SOURCES
}

// ── Paths ─────────────────────────────────────────────────────────────────

export function catalogCacheDir(): string {
  return resolve(homedir(), ".agentproto", "catalog")
}

export function catalogCachePath(id: string): string {
  return join(catalogCacheDir(), `${id}.json`)
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

// ── Refresh (eager, on `provider set`) ────────────────────────────────────

export interface RefreshResult {
  /** Cache id (`voice-elevenlabs`). */
  id: string
  /** Number of voices cached. */
  count: number
  /** True when the response was unchanged and the file was left as-is. */
  skipped: boolean
  /** Absolute cache path written/kept. */
  path: string
}

/**
 * Fetch a provider's live catalog with the given key and write the cache.
 * Returns null when the provider has no live catalog (nothing to do).
 * Smart-skip: if the new response's sha matches the cached one, the file is
 * left untouched and `skipped: true` is returned.
 */
export async function refreshProviderCatalog(
  provider: string,
  apiKey: string,
  baseUrl?: string,
): Promise<RefreshResult | null> {
  const source = VOICE_SOURCES[provider]
  if (!source) return null

  const voices = await source.fetchVoices(apiKey, baseUrl)
  // sha over the mapped, normalized voices — stable across provider field
  // reordering, and exactly what the overlay consumes.
  const serialized = JSON.stringify(voices)
  const sourceSha = sha256(serialized)
  const path = catalogCachePath(source.id)

  const existing = await readCatalogCache(source.id)
  if (existing && existing.sourceSha === sourceSha) {
    return { id: source.id, count: voices.length, skipped: true, path }
  }

  const file: CatalogCacheFile = {
    version: 1,
    provider,
    kind: "voice",
    sourceSha,
    fetchedAt: new Date().toISOString(),
    voices,
  }
  await mkdir(catalogCacheDir(), { recursive: true })
  await writeFile(path, JSON.stringify(file, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
  return { id: source.id, count: voices.length, skipped: false, path }
}

// ── Read (boot overlay loader, piece 3) ───────────────────────────────────

async function readCatalogCache(id: string): Promise<CatalogCacheFile | null> {
  try {
    const raw = await readFile(catalogCachePath(id), "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as CatalogCacheFile).voices)
    ) {
      return null
    }
    return parsed as CatalogCacheFile
  } catch {
    return null // ENOENT / malformed → no cache
  }
}

/**
 * Read every cached provider catalog and fold it into a single voice list
 * for `registerCatalogOverlay({ voice })`. Missing/empty dir → `[]`.
 */
export async function loadCachedCatalogVoices(): Promise<CatalogVoice[]> {
  let names: string[]
  try {
    names = await readdir(catalogCacheDir())
  } catch {
    return [] // dir absent → nothing cached
  }
  const voices: CatalogVoice[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const file = await readCatalogCache(name.slice(0, -".json".length))
    if (file?.kind === "voice") voices.push(...file.voices)
  }
  return voices
}
