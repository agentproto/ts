/**
 * `corpus discover <topic> [path]` — multi-channel source discovery.
 *
 * Fans out across web + youtube (+ social best-effort), deduplicates URLs,
 * MERGES into `<path>/urls.discovered.txt` (union with any URLs already in
 * the file, deduped by exact URL — so multi-round discovery sessions
 * accumulate instead of last-run-wins; pass --fresh to overwrite), prints a
 * per-channel summary, and optionally chains import-web via --import.
 *
 * Web search: inline minimal HTTP fetcher — @agstudio/integration-search is
 * not available in this workspace (cross-boundary package). Provider priority:
 *   SERPER_API_KEY → EXA_API_KEY → TAVILY_API_KEY → GOOGLE_SEARCH_API_KEY
 *
 * YouTube channel: shells `yt-dlp "ytsearch<max>:<topic>" --flat-playlist
 *   --print "%(url)s"` — the same yt-dlp binary used by import-web.
 *
 * Social channel: best-effort; skipped with a notice if Bureau is unreachable.
 */

import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"
import { runImportWeb } from "./import-web.js"

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  topic: string | undefined
  outputPath: string | undefined
  max: number
  channels: Set<string>
  lang: string | undefined
  tags: string[]
  doImport: boolean
  fresh: boolean
}

function parse(args: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    topic: undefined,
    outputPath: undefined,
    max: 20,
    channels: new Set(["web"]),
    lang: undefined,
    tags: [],
    doImport: false,
    fresh: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const next = () => args[++i]
    switch (a) {
      case "--max": { const v = next(); if (v) out.max = Number(v); break }
      case "--channels": {
        const v = next()
        if (v) out.channels = new Set(v.split(",").map(s => s.trim()).filter(Boolean))
        break
      }
      case "--lang": out.lang = next(); break
      case "--tags": {
        const v = next()
        if (v) out.tags.push(...v.split(",").map(s => s.trim()).filter(Boolean))
        break
      }
      case "--import": out.doImport = true; break
      case "--fresh": out.fresh = true; break
      default:
        if (!a.startsWith("-")) {
          if (out.topic === undefined) out.topic = a
          else if (out.outputPath === undefined) out.outputPath = a
        }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Web search — inline minimal fetcher (no integration-search dependency)
// ---------------------------------------------------------------------------

interface SearchResult { url: string; title?: string }

/** Serper: POST https://google.serper.dev/search */
async function searchSerper(query: string, lang: string | undefined, max: number): Promise<SearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY!
  const gl = lang === "fr" ? "fr" : lang ?? "us"
  const hl = lang ?? "en"
  const body = JSON.stringify({ q: query, gl, hl, num: max })
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body,
  })
  if (!res.ok) throw new Error(`Serper ${res.status}: ${await res.text()}`)
  const json = await res.json() as { organic?: Array<{ link?: string; title?: string }> }
  return (json.organic ?? []).flatMap(r => r.link ? [{ url: r.link, title: r.title }] : [])
}

/** Exa: POST https://api.exa.ai/search */
async function searchExa(query: string, _lang: string | undefined, max: number): Promise<SearchResult[]> {
  const apiKey = process.env.EXA_API_KEY!
  const body = JSON.stringify({ query, numResults: max, type: "neural", contents: { text: false } })
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body,
  })
  if (!res.ok) throw new Error(`Exa ${res.status}: ${await res.text()}`)
  const json = await res.json() as { results?: Array<{ url?: string; title?: string }> }
  return (json.results ?? []).flatMap(r => r.url ? [{ url: r.url, title: r.title }] : [])
}

/** Tavily: POST https://api.tavily.com/search */
async function searchTavily(query: string, _lang: string | undefined, max: number): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY!
  const body = JSON.stringify({ api_key: apiKey, query, max_results: max })
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`)
  const json = await res.json() as { results?: Array<{ url?: string; title?: string }> }
  return (json.results ?? []).flatMap(r => r.url ? [{ url: r.url, title: r.title }] : [])
}

/** Google Custom Search: GET https://www.googleapis.com/customsearch/v1 */
async function searchGoogle(query: string, lang: string | undefined, max: number): Promise<SearchResult[]> {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY!
  const cx = process.env.GOOGLE_SEARCH_CX ?? ""
  const params = new URLSearchParams({
    key: apiKey, q: query, num: String(Math.min(max, 10)),
    ...(cx ? { cx } : {}),
    ...(lang ? { lr: `lang_${lang}`, hl: lang } : {}),
  })
  const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`)
  if (!res.ok) throw new Error(`Google ${res.status}: ${await res.text()}`)
  const json = await res.json() as { items?: Array<{ link?: string; title?: string }> }
  return (json.items ?? []).flatMap(r => r.link ? [{ url: r.link, title: r.title }] : [])
}

type WebSearchFn = (q: string, lang: string | undefined, max: number) => Promise<SearchResult[]>

/** Pick the first available search provider by env key, in priority order. */
function resolveWebProvider(): { name: string; fn: WebSearchFn } | null {
  if (process.env.SERPER_API_KEY) return { name: "serper", fn: searchSerper }
  if (process.env.EXA_API_KEY) return { name: "exa", fn: searchExa }
  if (process.env.TAVILY_API_KEY) return { name: "tavily", fn: searchTavily }
  if (process.env.GOOGLE_SEARCH_API_KEY) return { name: "google", fn: searchGoogle }
  return null
}

/** Build 2-3 query variants for the topic + optional lang. */
function buildWebQueries(topic: string, lang: string | undefined): string[] {
  const langSuffix = lang && lang !== "en" ? ` ${lang}` : ""
  const q1 = topic
  const q2 = `${topic} guide tutorial${langSuffix}`
  const q3 = lang && lang !== "en" ? `${topic} ressources ${lang}` : `${topic} best practices resources`
  return [q1, q2, q3]
}

async function discoverWeb(topic: string, lang: string | undefined, max: number): Promise<{ urls: string[]; provider: string }> {
  const provider = resolveWebProvider()
  if (!provider) {
    process.stderr.write("corpus discover: no web search API key found (SERPER_API_KEY / EXA_API_KEY / TAVILY_API_KEY / GOOGLE_SEARCH_API_KEY) — web channel skipped.\n")
    return { urls: [], provider: "none" }
  }

  const queries = buildWebQueries(topic, lang)
  const seen = new Set<string>()
  const urls: string[] = []

  for (const q of queries) {
    if (urls.length >= max) break
    try {
      const results = await provider.fn(q, lang, max)
      for (const r of results) {
        if (urls.length >= max) break
        if (!seen.has(r.url)) {
          seen.add(r.url)
          urls.push(r.url)
        }
      }
    } catch (e) {
      process.stderr.write(`corpus discover: web search query "${q}" failed — ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }

  return { urls, provider: provider.name }
}

// ---------------------------------------------------------------------------
// YouTube channel
// ---------------------------------------------------------------------------

async function discoverYoutube(topic: string, max: number): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "yt-dlp",
      [`ytsearch${max}:${topic}`, "--flat-playlist", "--print", "%(url)s", "--no-warnings"],
      { timeout: 60_000 },
      (err, stdout, _stderr) => {
        if (err) {
          process.stderr.write(`corpus discover: youtube channel failed — ${err.message}\n`)
          resolve([])
          return
        }
        resolve(
          stdout
            .split("\n")
            .map(l => l.trim())
            .filter(l => l.startsWith("http"))
        )
      }
    )
  })
}

// ---------------------------------------------------------------------------
// Social channel (best-effort)
// ---------------------------------------------------------------------------

async function discoverSocial(_topic: string, _lang: string | undefined, _max: number): Promise<string[]> {
  process.stdout.write("  social channel needs a Bureau session — skipped.\n")
  return []
}

// ---------------------------------------------------------------------------
// Output-file merge
// ---------------------------------------------------------------------------

/** Read the existing urls.discovered.txt, one URL per line. Missing file ⇒ []. */
async function readExistingUrls(outFile: string): Promise<string[]> {
  try {
    const prior = await readFile(outFile, "utf-8")
    return prior
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return [] // first run — nothing to merge
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runDiscover(args: readonly string[]): Promise<ExitCode> {
  const parsed = parse(args)

  if (!parsed.topic) {
    return fail("discover requires a <topic> argument. Usage: corpus discover <topic> [path] [--max N] [--channels web,youtube,social] [--lang fr] [--tags t] [--import] [--fresh]", 2)
  }

  const outputPath = parsed.outputPath
    ? resolveWorkspacePath(parsed.outputPath)
    : process.cwd()

  process.stdout.write(`discover "${parsed.topic}"\n`)
  process.stdout.write(`  channels: ${[...parsed.channels].join(", ")} · max: ${parsed.max}${parsed.lang ? ` · lang: ${parsed.lang}` : ""}\n`)

  const webUrls: string[] = []
  const ytUrls: string[] = []
  const socialUrls: string[] = []

  // Web channel
  if (parsed.channels.has("web")) {
    const { urls, provider } = await discoverWeb(parsed.topic, parsed.lang, parsed.max)
    webUrls.push(...urls)
    if (urls.length > 0) process.stdout.write(`  web (${provider}): ${urls.length} URLs\n`)
  }

  // YouTube channel
  if (parsed.channels.has("youtube")) {
    const urls = await discoverYoutube(parsed.topic, parsed.max)
    ytUrls.push(...urls)
    if (urls.length > 0) process.stdout.write(`  youtube: ${urls.length} URLs\n`)
  }

  // Social channel
  if (parsed.channels.has("social")) {
    const urls = await discoverSocial(parsed.topic, parsed.lang, parsed.max)
    socialUrls.push(...urls)
  }

  // Dedup across channels (web first, then youtube, then social)
  const seen = new Set<string>()
  const allUrls: string[] = []
  for (const url of [...webUrls, ...ytUrls, ...socialUrls]) {
    if (!seen.has(url)) {
      seen.add(url)
      allUrls.push(url)
    }
  }

  process.stdout.write(`\n  web: ${webUrls.length} · youtube: ${ytUrls.length} · social: ${socialUrls.length} · total: ${allUrls.length} unique\n`)

  if (allUrls.length === 0) {
    process.stderr.write("corpus discover: no URLs found across any channel.\n")
    return 1
  }

  // Merge into urls.discovered.txt: union with any previously-discovered
  // URLs (exact-URL dedup, prior order preserved) so multi-round discovery
  // sessions accumulate. --fresh opts into the old overwrite behavior.
  await mkdir(outputPath, { recursive: true })
  const outFile = join(outputPath, "urls.discovered.txt")
  const existing: string[] = parsed.fresh ? [] : await readExistingUrls(outFile)
  const merged = [...existing]
  const known = new Set(existing)
  for (const url of allUrls) {
    if (!known.has(url)) {
      known.add(url)
      merged.push(url)
    }
  }
  const added = merged.length - existing.length
  await writeFile(outFile, merged.join("\n") + "\n", "utf-8")
  process.stdout.write(
    `\n  written → ${outFile} (${merged.length} URLs` +
      (parsed.fresh
        ? ", --fresh overwrite"
        : `, ${added} new, ${existing.length} kept from previous runs`) +
      `)\n`
  )

  // Chain import-web if requested
  if (parsed.doImport) {
    process.stdout.write("\n  --import: chaining import-web…\n")
    const importArgs: string[] = [
      outputPath,
      "--urls-file", outFile,
      ...parsed.tags.flatMap(t => ["--tags", t]),
      ...(parsed.lang ? ["--lang", parsed.lang] : []),
    ]
    return runImportWeb(importArgs)
  }

  return 0
}
