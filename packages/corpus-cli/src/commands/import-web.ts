/**
 * `corpus import-web [workspace]` — import a list of URLs into the
 * corpus workspace as AIP-10 sources + discovered candidates, fetching
 * each URL's text through the user's authenticated browser.
 *
 *   corpus import-web ./corpora/recruiting \
 *     --urls-file ./urls.txt \
 *     --browser-mcp http://127.0.0.1:9223/mcp \
 *     --tags recruiting --lang en
 *
 * Pipeline: WebImporter (FetcherPort ← BrowserMcpFetcher) → ImporterRunner
 * writes `sources/web/<batch>/<slug>.md` + appends `_candidates.yaml`.
 * Pushing the resulting candidates into a knowledge engine (RAG) is the
 * SEPARATE corpus promote/WriterPort step — not this command.
 *
 * The only external connection is the chrome-devtools-mcp browser
 * endpoint; everything else is local filesystem.
 */

import { readFile, readdir } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { z } from "zod"

/** Source frontmatter — just the URL provenance used for resume de-dup. */
const SOURCE_URL_FRONTMATTER = z
  .object({
    metadata: z
      .object({
        corpus: z
          .object({
            originalUrl: z.string().optional().catch(undefined),
            importerSourceUrl: z.string().optional().catch(undefined),
          })
          .loose()
          .optional()
          .catch(undefined),
      })
      .loose()
      .optional()
      .catch(undefined),
  })
  .loose()
import { join } from "node:path"
import matter from "gray-matter"
import {
  ImporterRunner,
  WebImporter,
  systemClock,
} from "@agentproto/corpus"
import type { FetcherPort } from "@agentproto/corpus"
import {
  BrowserMcpFetcher,
  type BrowserMcpLike,
} from "../ports/browser-fetcher.adapter.js"
import { ScrapeMcpFetcher } from "../ports/scrape-mcp-fetcher.adapter.js"
import { YtDlpWhisperFetcher } from "../ports/ytdlp-whisper-fetcher.adapter.js"
import { YtDlpCaptionsFetcher } from "../ports/ytdlp-captions-fetcher.adapter.js"
import { OpenAiWhisperStt, type SttPort } from "../ports/stt.port.js"
import { AssemblyAiStt } from "../ports/assemblyai-stt.adapter.js"
import { ChunkedStt } from "../ports/chunked-stt.adapter.js"
import { HttpReadabilityFetcher } from "../ports/http-readability-fetcher.adapter.js"
import { PdfFetcher } from "../ports/pdf-fetcher.adapter.js"
import { CompositeFetcher } from "../ports/composite-fetcher.js"
import { ThrottleFetcher } from "../ports/throttle-fetcher.adapter.js"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { OsIdentityAdapter } from "../ports/os-identity.adapter.js"
import { connectBrowserMcp } from "../ports/browser-mcp-connect.js"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"

interface ParsedArgs {
  workspace: string | undefined
  urlsFile: string | undefined
  urls: string[]
  tags: string[]
  lang: string | undefined
  max: number | undefined
  maxDurationSec: number | undefined
  cookiesFromBrowser: string | undefined
  cookiesFile: string | undefined
  ffmpegLocation: string | undefined
  throttleMs: number
  force: boolean
  diarize: boolean
  noCaptions: boolean
  browserMcp: string | undefined
  scrapeMcp: string | undefined
  importerId: string
  dryRun: boolean
}

function parse(args: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    workspace: undefined,
    urlsFile: undefined,
    urls: [],
    tags: [],
    lang: undefined,
    max: undefined,
    maxDurationSec: undefined,
    cookiesFromBrowser: undefined,
    cookiesFile: undefined,
    ffmpegLocation: undefined,
    throttleMs: 2000,
    force: false,
    diarize: false,
    noCaptions: false,
    browserMcp: process.env.BROWSER_MCP_URL,
    scrapeMcp: process.env.SCRAPE_MCP_URL,
    importerId: "web",
    dryRun: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const next = () => args[++i]
    switch (a) {
      case "--urls-file": out.urlsFile = next(); break
      case "--url": { const v = next(); if (v) out.urls.push(v); break }
      case "--tags": { const v = next(); if (v) out.tags.push(...v.split(",").map(s => s.trim()).filter(Boolean)); break }
      case "--lang": out.lang = next(); break
      case "--max": { const v = next(); if (v) out.max = Number(v); break }
      case "--max-duration": { const v = next(); if (v) out.maxDurationSec = Number(v); break }
      case "--cookies-from-browser": out.cookiesFromBrowser = next(); break
      case "--cookies": out.cookiesFile = next(); break
      case "--ffmpeg-location": out.ffmpegLocation = next(); break
      case "--throttle": { const v = next(); if (v) out.throttleMs = Number(v); break }
      case "--force": out.force = true; break
      case "--diarize": out.diarize = true; break
      case "--no-captions": out.noCaptions = true; break
      case "--browser-mcp": out.browserMcp = next(); break
      case "--scrape-mcp": out.scrapeMcp = next(); break
      case "--importer-id": out.importerId = next() ?? "web"; break
      case "--dry-run": out.dryRun = true; break
      default:
        if (!a.startsWith("-") && out.workspace === undefined) out.workspace = a
    }
  }
  return out
}

async function readUrls(parsed: ParsedArgs): Promise<string[]> {
  const fromFile: string[] = []
  if (parsed.urlsFile) {
    const raw = await readFile(parsed.urlsFile, "utf-8")
    for (const line of raw.split("\n")) {
      const url = line.trim()
      // Tolerate "Title — https://…" lines (the brief's format): take the URL.
      const m = url.match(/https?:\/\/\S+/)
      if (m) fromFile.push(m[0])
    }
  }
  // Dedupe input while preserving order.
  const seen = new Set<string>()
  return [...fromFile, ...parsed.urls].filter(u => (seen.has(u) ? false : seen.add(u)))
}

/**
 * Scan already-ingested source URLs from the workspace — the corpus is
 * the source of truth for "what's done". Reads every `sources/**​/*.md`
 * frontmatter and collects `metadata.corpus.originalUrl`. Re-running
 * import-web skips these, so batching is just "re-run with --max N until
 * empty" — resumable by construction, no separate state file.
 */
async function scanIngestedUrls(workspaceRoot: string): Promise<Set<string>> {
  const seen = new Set<string>()
  const sourcesDir = join(workspaceRoot, "sources")
  let entries: Dirent[]
  try {
    entries = await readdir(sourcesDir, {
      recursive: true,
      withFileTypes: true,
    })
  } catch {
    return seen // no sources/ yet
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue
    try {
      const raw = await readFile(join(e.parentPath, e.name), "utf-8")
      const fm = SOURCE_URL_FRONTMATTER.parse(matter(raw).data)
      const url =
        fm.metadata?.corpus?.originalUrl ?? fm.metadata?.corpus?.importerSourceUrl
      if (url) seen.add(url)
    } catch {
      // unreadable / non-frontmatter file — ignore
    }
  }
  return seen
}

export async function runImportWeb(args: readonly string[]): Promise<ExitCode> {
  const parsed = parse(args)
  const target = resolveWorkspacePath(parsed.workspace)
  const urls = await readUrls(parsed)

  if (urls.length === 0) {
    return fail("import-web requires --urls-file <path> and/or one or more --url <u>.", 2)
  }

  // Resume: skip URLs already ingested (their source records originalUrl).
  // --force re-fetches everything.
  const done = parsed.force ? new Set<string>() : await scanIngestedUrls(target)
  const todo = urls.filter(u => !done.has(u))
  const batch = parsed.max !== undefined ? todo.slice(0, parsed.max) : todo
  const remaining = todo.length - batch.length

  const videoLabel = parsed.noCaptions
    ? (parsed.diarize ? "AssemblyAI" : "Whisper")
    : `captions-first → ${parsed.diarize ? "AssemblyAI" : "Whisper"} fallback`
  const plan =
    `  workspace: ${target}\n` +
    `  urls:      ${urls.length} total · ${done.size && !parsed.force ? `${urls.length - todo.length} already ingested · ` : ""}${todo.length} to do\n` +
    `  this run:  ${batch.length}${parsed.max !== undefined ? ` (--max ${parsed.max})` : ""} · ${remaining} remaining after\n` +
    `  video:     ${videoLabel}\n` +
    `  throttle:  ${parsed.throttleMs} ms between fetches\n`

  if (batch.length === 0) {
    process.stdout.write(`import-web → ${target}\n  nothing to do — all ${urls.length} URLs already ingested.\n`)
    return 0
  }

  if (parsed.dryRun) {
    process.stdout.write(`import-web (dry run)\n${plan}`)
    for (const u of batch.slice(0, 20)) process.stdout.write(`    - ${u}\n`)
    if (batch.length > 20) process.stdout.write(`    … +${batch.length - 20} more\n`)
    return 0
  }
  process.stdout.write(`import-web\n${plan}`)

  // Build the fetcher chain (first non-null wins):
  //   1. videos    → yt-dlp captions/auto-subs  (free, no key; default)
  //   2. videos    → yt-dlp audio → Whisper     (caption-less fallback; needs OPENAI_API_KEY)
  //   3. PDFs      → plain HTTP + unpdf extraction (pure-JS, no browser/key)
  //   4. articles  → authed browser readability (only if --browser-mcp given)
  //   5. articles  → plain HTTP readability     (browser-free fallback)
  const chain: FetcherPort[] = []

  // Tier-1 (free, no key): pull the video's captions/auto-subs. Resolves
  // captioned videos for zero cost; returns null for caption-less ones so
  // the Whisper tier below takes over. Modern yt-dlp retrieves auto-subs
  // reliably, so this is the default video path (disable with --no-captions).
  if (!parsed.noCaptions) {
    chain.push(
      new YtDlpCaptionsFetcher({
        ...(parsed.lang ? { preferLang: parsed.lang } : {}),
        ...(parsed.maxDurationSec ? { maxDurationSec: parsed.maxDurationSec } : {}),
        ...(parsed.cookiesFromBrowser
          ? { cookiesFromBrowser: parsed.cookiesFromBrowser }
          : {}),
        ...(parsed.cookiesFile ? { cookiesFile: parsed.cookiesFile } : {}),
      })
    )
  }

  // Pick the video STT: --diarize → AssemblyAI (speaker-labelled, for
  // multi-speaker interviews/panels), else OpenAI Whisper (flat, cheaper,
  // faster). Both satisfy SttPort, so the fetcher is identical.
  let stt: SttPort | undefined
  if (parsed.diarize) {
    const aaiKey = process.env.ASSEMBLYAI_API_KEY
    if (aaiKey) stt = new AssemblyAiStt({ apiKey: aaiKey })
    else
      process.stderr.write(
        "corpus: --diarize needs ASSEMBLYAI_API_KEY — video URLs will be skipped.\n"
      )
  } else {
    const openaiKey = process.env.OPENAI_API_KEY
    // Wrap Whisper in ChunkedStt so multi-hour media (full courses,
    // masterclasses) gets ffmpeg-segmented under the 25 MB cap instead of
    // being rejected. AssemblyAI has no such cap, so it stays unwrapped.
    if (openaiKey)
      stt = new ChunkedStt({ base: new OpenAiWhisperStt({ apiKey: openaiKey }) })
    else
      process.stderr.write(
        parsed.noCaptions
          ? "corpus: OPENAI_API_KEY not set — video URLs will be skipped (no transcription).\n"
          : "corpus: OPENAI_API_KEY not set — caption-less videos will be skipped (captioned videos still import).\n"
      )
  }
  if (stt)
    chain.push(
      new YtDlpWhisperFetcher({
        stt,
        ...(parsed.maxDurationSec
          ? { maxDurationSec: parsed.maxDurationSec }
          : {}),
        ...(parsed.cookiesFromBrowser
          ? { cookiesFromBrowser: parsed.cookiesFromBrowser }
          : {}),
        ...(parsed.cookiesFile ? { cookiesFile: parsed.cookiesFile } : {}),
        ...(parsed.ffmpegLocation ? { ffmpegLocation: parsed.ffmpegLocation } : {}),
      })
    )

  // PDFs: pure-JS, no browser/key needed, always available. Sits AHEAD of
  // the browser-based fetchers below — handing a raw PDF URL to a headless
  // browser renders the native PDF viewer, not extractable text, and a
  // public court/registry PDF needs no authenticated session anyway. It
  // claims a URL by extension OR by a real `application/pdf` content-type
  // (see pdf-fetcher.adapter.ts), so falls through to those richer
  // fetchers for anything that merely LOOKED like it might be a PDF but
  // wasn't (e.g. an unauthenticated request blocked/redirected to a login
  // page instead of the file).
  chain.push(new PdfFetcher())

  // A `scrape` MCP server (e.g. the browser project's tiered router) handles
  // walled / JS-rendered pages with stealth + auto-escalation and returns
  // clean Markdown. Sits ahead of the cheaper fallbacks.
  if (parsed.scrapeMcp) {
    try {
      const client = await connectBrowserMcp({ endpoint: parsed.scrapeMcp })
      chain.push(new ScrapeMcpFetcher({ client }))
    } catch (e) {
      return fail(`could not connect to scrape MCP at ${parsed.scrapeMcp}: ${msg(e)}`, 1)
    }
  }

  if (parsed.browserMcp) {
    let browser: BrowserMcpLike
    try {
      browser = await connectBrowserMcp({ endpoint: parsed.browserMcp })
      chain.push(new BrowserMcpFetcher({ browser }))
    } catch (e) {
      return fail(`could not connect to browser MCP at ${parsed.browserMcp}: ${msg(e)}`, 1)
    }
  }

  // Browser-free article fallback always available.
  chain.push(new HttpReadabilityFetcher())

  if (chain.length === 0) {
    return fail("no fetchers available — set OPENAI_API_KEY (videos) and/or --browser-mcp.", 2)
  }

  const fetcher = new ThrottleFetcher(new CompositeFetcher(chain), {
    minIntervalMs: parsed.throttleMs,
  })
  const importer = new WebImporter({ fetcher })

  const runner = new ImporterRunner({
    // The fs is rooted AT the workspace, so corpus paths are relative to
    // it — workspacePath is "" (root), NOT the absolute target (which
    // would double-nest under the fs root).
    fs: new NodeFsAdapter({ root: target }),
    clock: systemClock,
    identity: new OsIdentityAdapter({ workspaceRoot: target }),
    workspacePath: "",
  })

  let report
  try {
    report = await runner.run(importer, {
      importerId: parsed.importerId,
      config: {
        urls: batch,
        ...(parsed.tags.length ? { tags: parsed.tags } : {}),
        ...(parsed.lang ? { language: parsed.lang } : {}),
      },
    })
  } catch (e) {
    return fail(`import failed: ${msg(e)}`, 1)
  }

  process.stdout.write(
    `import-web → ${target}\n` +
      `  batch:      ${report.batchId}\n` +
      `  archived:   ${report.archivedSlugs.length}\n` +
      `  duplicates: ${report.duplicateSlugs.length}\n` +
      `  candidates: ${report.candidateIds.length}\n`
  )
  for (const w of report.warnings.slice(0, 20)) process.stdout.write(`  ! ${w}\n`)
  process.stdout.write(
    `\nNext: review candidates, then promote them — promotion pushes chunks into the\n` +
      `knowledge engine (RAG) via the WriterPort. Import only stages the sources.\n`
  )
  return 0
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
