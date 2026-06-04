/**
 * WebImporter — turns a list of URLs into corpus sources by reducing
 * each to text through an injected FetcherPort. The importer is pure:
 * it slugs, hashes, and shapes ImportedSource; the FetcherPort supplies
 * the environment-bound "URL → { title, text }" capability (YouTube
 * captions, article readability, or — at a fatter tier — transcription).
 *
 * Config (target.config):
 *   - urls: string[]          — required. The source URLs to import.
 *   - maxUrls?: number        — defaults to 1000.
 *   - tags?: string[]         — applied to every imported source.
 *   - language?: string       — fallback BCP-47 when the fetcher omits one.
 *
 * A URL the fetcher returns `null` for (e.g. a caption-less video on a
 * non-transcribing tier) is skipped — the runner records it as a
 * warning rather than aborting the batch.
 *
 * Pure kit code — consumes FetcherPort, no node:fs / no network of its
 * own. Slug: derived from title, else the URL. Hash: sha256 of the text.
 */

import { createHash } from "node:crypto"
import type { FetcherPort } from "../ports/fetcher.port.js"
import type {
  CorpusImporter,
  ImportedSource,
  ImporterTarget,
} from "./types.js"

export interface WebImporterOptions {
  readonly fetcher: FetcherPort
}

interface WebConfig {
  readonly urls: readonly string[]
  readonly maxUrls?: number
  readonly tags?: readonly string[]
  readonly language?: string
}

export class WebImporter implements CorpusImporter {
  readonly id = "web"
  readonly label = "Web (URLs)"

  constructor(private readonly opts: WebImporterOptions) {}

  async *enumerate(target: ImporterTarget): AsyncIterable<ImportedSource> {
    const config = parseConfig(target.config)
    const maxUrls = config.maxUrls ?? 1000
    const seenSlugs = new Set<string>()
    let yielded = 0

    for (const url of config.urls) {
      if (yielded >= maxUrls) break

      const fetched = await this.opts.fetcher.fetch(url)
      // null = the fetcher couldn't reduce this URL to text; skip it.
      // The runner surfaces skipped URLs as warnings on the batch.
      if (!fetched || !fetched.text.trim()) continue

      const slug = uniqueSlug(
        makeSlug(fetched.title) || makeSlug(url) || "source",
        seenSlugs
      )
      const language = fetched.language ?? config.language

      yield {
        slug,
        title: fetched.title.slice(0, 200) || slug,
        contentHash: sha256(fetched.text),
        body: fetched.text,
        originalUrl: url,
        authority: "secondary",
        ...(language ? { language } : {}),
        ...(config.tags && config.tags.length > 0
          ? { tags: config.tags }
          : {}),
        corpusMetadata: {
          importerSourceUrl: url,
          fetchKind: fetched.kind,
          ...(fetched.via ? { fetchedVia: fetched.via } : {}),
        },
      }
      yielded++
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseConfig(raw: Readonly<Record<string, unknown>>): WebConfig {
  const rawUrls = raw.urls
  if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
    throw new Error("WebImporter: config.urls is required (non-empty string[])")
  }
  const urls = rawUrls.filter(
    (x): x is string => typeof x === "string" && x.length > 0
  )
  if (urls.length === 0) {
    throw new Error("WebImporter: config.urls contained no usable strings")
  }
  const rawTags = raw.tags
  return {
    urls,
    maxUrls: typeof raw.maxUrls === "number" ? raw.maxUrls : undefined,
    tags: Array.isArray(rawTags)
      ? rawTags.filter((x): x is string => typeof x === "string")
      : undefined,
    language: typeof raw.language === "string" ? raw.language : undefined,
  }
}

function makeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 96)
}

function uniqueSlug(base: string, seen: Set<string>): string {
  let slug = base
  let n = 2
  while (seen.has(slug)) {
    slug = `${base}-${n}`.slice(0, 96)
    n++
  }
  seen.add(slug)
  return slug
}

function sha256(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex")
}
