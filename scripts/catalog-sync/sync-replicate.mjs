#!/usr/bin/env node
/**
 * Replicate media pricing sync - scrapes the public model pages (anonymous,
 * keyless) and writes `packages/model-catalog/src/<modality>/replicate-pricing.generated.ts`.
 *
 * Each page embeds the same billing JSON the authenticated API returns:
 *   billingConfig.current_tiers[].prices[]  -> unit rates (per image, per second)
 *   price / p50price                        -> hardware-billed per-second rate
 *
 * MODEL COVERAGE: the union of
 *   - the hand-written PRICING table in
 *     packages/catalog-sync/src/generators/image-replicate.ts, and
 *   - the `provider: "replicate"` entries of agentik-studio's image and video
 *     catalogs (read-only reference), plus the two test fixtures.
 * A page that is gone (404), has no billing JSON, or bills in a unit this
 * catalog cannot express is reported as SKIPPED and its previous committed
 * price is kept. No price is invented.
 *
 * A page that EXISTS but has an unrecognised billing shape throws: the script
 * then exits WITHOUT WRITING, so the previously committed prices survive
 * untouched instead of silently becoming zero or wrong.
 *
 * Exit codes follow run-all.mjs: 0 = synced (skips included), any other = a
 * real failure. There is no key-absent skip path here: the pages are public.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  parseReplicateModelPage,
  selectReplicatePrice,
} from "../../packages/catalog-sync/src/sources/replicate-model-page.mjs"
import {
  fetchedAtLedgerRelPath,
  hashJson,
  readFetchedAtLedger,
  resolveFetchedAt,
  serializeFetchedAtLedger,
} from "../../packages/catalog-sync/src/fetched-at.mjs"

const ROOT = resolve(import.meta.dirname, "../..")
const LEDGER_ID = "media-replicate"
const REQUEST_DELAY_MS = 250

/**
 * Models to scrape.
 *
 * Image: the 13 names of the hand-written PRICING table (mapped to their
 * Replicate owner/name), the Replicate image models in agentik-studio's
 * catalog, and the two fixtures (flux-schnell, rembg).
 * Video: the Replicate video models in agentik-studio's catalog.
 */
const MODELS = [
  // Hand-written PRICING table in image-replicate.ts (13).
  { owner: "google", name: "nano-banana-pro", modality: "image" },
  { owner: "google", name: "nano-banana-2", modality: "image" },
  { owner: "google", name: "nano-banana", modality: "image" },
  { owner: "black-forest-labs", name: "flux-2-dev", modality: "image" },
  { owner: "black-forest-labs", name: "flux-kontext-pro", modality: "image" },
  { owner: "black-forest-labs", name: "flux-kontext-max", modality: "image" },
  { owner: "black-forest-labs", name: "flux-1.1-pro-ultra", modality: "image" },
  { owner: "bytedance", name: "seedream-4", modality: "image" },
  { owner: "recraft-ai", name: "recraft-v3", modality: "image" },
  { owner: "minimax", name: "image-01", modality: "image" },
  { owner: "openai", name: "gpt-image-1", modality: "image" },
  { owner: "ideogram-ai", name: "ideogram-v3-turbo", modality: "image" },
  { owner: "black-forest-labs", name: "flux-1.1-pro", modality: "image" },

  // agentik-studio image catalog, provider "replicate".
  { owner: "agentiknet", name: "avatar-model-001", modality: "image" },
  { owner: "agentik", name: "custom-simone_infographic_1", modality: "image" },
  { owner: "agentik-ai", name: "theo-sutter-0.1", modality: "image" },
  { owner: "stability-ai", name: "sdxl", modality: "image" },
  { owner: "stability-ai", name: "stable-diffusion-3", modality: "image" },
  { owner: "nvidia", name: "sana", modality: "image" },
  { owner: "fofr", name: "sticker-maker", modality: "image" },
  { owner: "fofr", name: "pulid-base", modality: "image" },

  // Test fixtures (also real public pages).
  { owner: "black-forest-labs", name: "flux-schnell", modality: "image" },
  { owner: "cjwbw", name: "rembg", modality: "image" },

  // agentik-studio video catalog, provider "replicate".
  { owner: "google", name: "veo-3.1-fast", modality: "video" },
  { owner: "google", name: "veo-3.1", modality: "video" },
  { owner: "kwaivgi", name: "kling-v3-omni-video", modality: "video" },
  { owner: "kwaivgi", name: "kling-v3-video", modality: "video" },
  { owner: "openai", name: "sora-2", modality: "video" },
  { owner: "openai", name: "sora-2-pro", modality: "video" },
  { owner: "xai", name: "grok-imagine-video", modality: "video" },
  { owner: "minimax", name: "hailuo-2.3", modality: "video" },
  { owner: "minimax", name: "hailuo-2.3-fast", modality: "video" },
  { owner: "minimax", name: "hailuo-02", modality: "video" },
  { owner: "bytedance", name: "seedance-1-pro-fast", modality: "video" },
  { owner: "bytedance", name: "seedance-1-lite", modality: "video" },
  { owner: "wan-video", name: "wan-2.5-t2v", modality: "video" },
  { owner: "wan-video", name: "wan-2.5-i2v", modality: "video" },
  { owner: "wan-video", name: "wan-2.5-i2v-fast", modality: "video" },
  { owner: "pixverse", name: "pixverse-v5.6", modality: "video" },
  { owner: "runwayml", name: "gen-4.5", modality: "video" },
  { owner: "veed", name: "fabric-1.0", modality: "video" },
  { owner: "pixverse", name: "lipsync", modality: "video" },
  { owner: "bytedance", name: "dreamactor-m2.0", modality: "video" },
  { owner: "kwaivgi", name: "kling-v2.5-turbo-pro", modality: "video" },
  { owner: "luma", name: "ray-flash-2-540p", modality: "video" },
]

const CONST_BY_MODALITY = {
  image: "REPLICATE_IMAGE_PRICING",
  video: "REPLICATE_VIDEO_PRICING",
  audio: "REPLICATE_AUDIO_PRICING",
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

function outputPathOf(modality) {
  return resolve(
    ROOT,
    "packages/model-catalog/src",
    modality,
    "replicate-pricing.generated.ts"
  )
}

/** Existing generated entries, keyed by route, as their raw source lines. */
function readExistingEntries(path) {
  const entries = new Map()
  if (!existsSync(path)) return entries
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^ {2}"([^"]+)": (\{.*\}),$/.exec(line)
    if (m) entries.set(m[1], line)
  }
  return entries
}

function serializeLine(id, entry) {
  return `  ${JSON.stringify(id)}: { unit: ${JSON.stringify(entry.unit)}, priceUsd: ${entry.priceUsd}, source: "replicate", fetchedAt: ${JSON.stringify(entry.fetchedAt)} },`
}

function serialize(modality, lines) {
  const constName = CONST_BY_MODALITY[modality]
  const ids = [...lines.keys()].sort()
  const out = [
    "// AUTO-GENERATED by scripts/catalog-sync/sync-replicate.mjs.",
    "// Do not edit by hand - re-run `pnpm catalog:sync-native`.",
    "// Source: public Replicate model pages (billingConfig / price / p50price).",
    "",
    'import type { MediaPricing } from "../pricing/media.js"',
    "",
    `export const ${constName}: Record<string, MediaPricing> = {`,
  ]
  for (const id of ids) out.push(lines.get(id))
  out.push("}")
  out.push("")
  return out.join("\n")
}

async function fetchPage(owner, name) {
  const url = `https://replicate.com/${owner}/${name}`
  const res = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "agentproto-catalog-sync/1.0",
    },
  })
  if (res.status === 404) return { url, missing: true }
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status} ${res.statusText}`)
  }
  return { url, missing: false, html: await res.text() }
}

async function main() {
  const today = todayIso()
  const ledger = readFetchedAtLedger(LEDGER_ID)
  const linesByModality = {}
  const skipped = []

  for (const [index, model] of MODELS.entries()) {
    if (index > 0) await sleep(REQUEST_DELAY_MS)
    const id = `replicate:${model.owner}/${model.name}`
    const outPath = outputPathOf(model.modality)
    linesByModality[model.modality] ??= readExistingEntries(outPath)

    let html
    try {
      const page = await fetchPage(model.owner, model.name)
      if (page.missing) {
        skipped.push({ id, reason: "page not found (404)" })
        console.log(`  - ${id}: skipped (404)`)
        continue
      }
      html = page.html
    } catch (err) {
      throw new Error(`${id}: fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    const page = parseReplicateModelPage(html)
    if (page.owner !== model.owner || page.name !== model.name) {
      throw new Error(
        `${id}: page resolved to ${page.owner}/${page.name}, expected ${model.owner}/${model.name}`
      )
    }
    const selected = selectReplicatePrice(page)
    if (!selected) {
      skipped.push({
        id,
        reason: `no expressible price (tiers: ${page.tierPrices.map(t => t.metric).join(", ") || "none"})`,
      })
      console.log(`  - ${id}: skipped (no expressible price)`)
      continue
    }
    const { ledger: next, entry } = resolveFetchedAt(
      ledger,
      id,
      hashJson({ unit: selected.unit, priceUsd: selected.priceUsd }),
      today
    )
    for (const key of Object.keys(next)) ledger[key] = next[key]
    linesByModality[model.modality].set(id, serializeLine(id, {
      unit: selected.unit,
      priceUsd: selected.priceUsd,
      fetchedAt: entry.fetchedAt,
    }))
    console.log(
      `  ✓ ${id}: ${selected.priceUsd} ${selected.unit} (${selected.title || selected.metric})`
    )
  }

  for (const [modality, lines] of Object.entries(linesByModality)) {
    const path = outputPathOf(modality)
    writeFileSync(path, serialize(modality, lines), "utf8")
    console.log(`✓ Wrote ${path} (${lines.size} entries)`)
  }

  const ledgerPath = resolve(ROOT, fetchedAtLedgerRelPath(LEDGER_ID))
  writeFileSync(ledgerPath, serializeFetchedAtLedger(ledger), "utf8")
  console.log(`✓ Wrote ${ledgerPath}`)

  if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length} model(s); previous prices kept:`)
    for (const { id, reason } of skipped) console.log(`  - ${id}: ${reason}`)
  }
}

main().catch(err => {
  console.error(`sync-replicate: ${err instanceof Error ? err.message : String(err)}`)
  console.error("sync-replicate: keeping the last committed prices (no file written)")
  process.exit(1)
})
