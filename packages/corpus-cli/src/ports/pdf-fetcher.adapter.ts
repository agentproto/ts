/**
 * PdfFetcher — a browser-free FetcherPort for PDF documents. Downloads
 * the file with plain `fetch` (no headless browser needed) and extracts
 * text with `unpdf` — a pure-JS wrapper around a serverless build of
 * Mozilla's pdf.js, no native binary (no poppler/pdftotext install
 * required). Mirrors {@link HttpReadabilityFetcher}'s shape: same
 * fetch-then-sniff routing, same "return null when it's not mine, throw
 * on a hard failure" contract.
 *
 * Routing (first-non-null-wins CompositeFetcher, see composite-fetcher.ts):
 * claims a URL when EITHER the path ends in `.pdf` (query string
 * ignored) OR the response's `content-type` is `application/pdf` — the
 * second case matters most in practice: court registries and
 * jurisprudence portals routinely serve PDFs from extension-less URLs
 * (`/decisions/12345`, not `/decisions/12345.pdf`). Anything else
 * returns `null` so a downstream fetcher (readability, browser) takes it.
 *
 * A legal/regulatory PDF is cited BY PAGE, so page boundaries are
 * preserved in the extracted text as explicit `--- page N of M ---`
 * markers rather than being merged into one undifferentiated blob.
 *
 * Fails LOUDLY — never returns an empty/partial source in silence — on:
 *   - a URL that matched by extension/content-type but isn't really a
 *     PDF (magic-bytes check: must start with `%PDF-`)
 *   - a password-protected / encrypted PDF (pdf.js throws
 *     `PasswordException` before any page can be read)
 *   - a scanned PDF with no text layer (0 characters extracted across
 *     every page) — this is the case that must NOT look like "checked,
 *     nothing there": it means "this needs OCR", a different problem.
 *
 * Provenance survives into the corpus frontmatter via
 * `FetchedSource.metadata`, which `WebImporter` merges verbatim into
 * `corpusMetadata` (→ `metadata.corpus.*` in the archived source's
 * frontmatter): page count, the PDF file's own sha256 (what makes the
 * source independently verifiable), and the document-info title/author/
 * producer/creation/modification dates when the PDF carries them.
 *
 * The actual PDF decoding (bytes → per-page text + doc info) is injected
 * as `extract` — same pattern as {@link YtDlpWhisperFetcher}'s
 * `download`/`stt` seams — so this adapter is unit-testable with a fake
 * extractor and no real PDF parsing, while the default wires the real
 * `unpdf` engine.
 */

import { createHash } from "node:crypto"
import { extractText, getDocumentProxy, getMeta } from "unpdf"
import type { FetcherPort, FetchedSource } from "@agentproto/corpus"

const PDF_MAGIC = "%PDF-"

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36"

/** Per-page text + the PDF's own Info dictionary, decoded from raw bytes. */
export interface PdfExtraction {
  readonly totalPages: number
  readonly pageTexts: readonly string[]
  /** The PDF Info dictionary as pdf.js reports it (Title/Author/Producer/CreationDate/ModDate/…). */
  readonly info: Readonly<Record<string, unknown>>
}

/**
 * Decode PDF bytes into per-page text + document info. Rejects with a
 * pdf.js `PasswordException` (`.name === "PasswordException"`) for an
 * encrypted/password-protected document — the fetcher classifies that
 * itself; this function does not swallow it. Real implementation uses
 * `unpdf`; inject a fake for tests.
 */
export type PdfExtractor = (bytes: Uint8Array) => Promise<PdfExtraction>

async function defaultPdfExtractor(bytes: Uint8Array): Promise<PdfExtraction> {
  const pdf = await getDocumentProxy(bytes)
  // `{ mergePages: false }` selects unpdf's overload that types `text`
  // as `string[]` (one entry per page) rather than a merged `string` —
  // preserving page boundaries is the whole point for a cited document.
  const [extracted, meta] = await Promise.all([
    extractText(pdf, { mergePages: false }),
    getMeta(pdf, { parseDates: true }),
  ])
  return { totalPages: extracted.totalPages, pageTexts: extracted.text, info: meta.info }
}

export interface PdfFetcherOptions {
  readonly userAgent?: string
  /** Abort the download after this many ms. Default 60_000. */
  readonly timeoutMs?: number
  /** Defaults to a real `unpdf`-backed extractor. Inject a fake for tests. */
  readonly extract?: PdfExtractor
}

export class PdfFetcher implements FetcherPort {
  private readonly ua: string
  private readonly timeoutMs: number
  private readonly extract: PdfExtractor

  constructor(opts: PdfFetcherOptions = {}) {
    this.ua = opts.userAgent ?? DEFAULT_UA
    this.timeoutMs = opts.timeoutMs ?? 60_000
    this.extract = opts.extract ?? defaultPdfExtractor
  }

  async fetch(url: string): Promise<FetchedSource | null> {
    let res: Response
    try {
      res = await fetch(url, {
        headers: { "user-agent": this.ua },
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      return null // network failure — let a downstream fetcher try
    }
    if (!res.ok) return null

    const contentType = res.headers.get("content-type") ?? ""
    const byExtension = isPdfExtension(url)
    const byContentType = contentType.toLowerCase().includes("application/pdf")
    if (!byExtension && !byContentType) return null // not mine — not a PDF by either signal

    const buffer = await res.arrayBuffer()
    const bytes = new Uint8Array(buffer)

    const magic = decodeAscii(bytes.slice(0, 5))
    if (magic !== PDF_MAGIC) {
      throw new Error(
        `not a PDF: ${url} (magic bytes: ${JSON.stringify(magic)}, ` +
          `content-type: ${contentType || "none"})`
      )
    }

    const sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex")

    let extraction: PdfExtraction
    try {
      extraction = await this.extract(bytes)
    } catch (e) {
      if (isPasswordProtected(e)) {
        throw new Error(`PDF is password-protected/encrypted: ${url}`)
      }
      throw new Error(`failed to open PDF: ${url} (${msg(e)})`)
    }

    const { totalPages, pageTexts, info } = extraction
    const hasText = pageTexts.some(t => t.trim().length > 0)
    if (!hasText) {
      throw new Error(
        `PDF has no extractable text layer (scanned document, not OCR'd): ` +
          `${url} — ${totalPages} page(s), 0 characters extracted`
      )
    }

    const text = pageTexts
      .map((t, i) => `--- page ${i + 1} of ${totalPages} ---\n\n${t.trim()}`)
      .join("\n\n")

    const pdfTitle = stringField(info, "Title")
    const pdfAuthor = stringField(info, "Author")
    const pdfProducer = stringField(info, "Producer")
    const pdfCreatedAt = dateField(info, "CreationDate")
    const pdfModifiedAt = dateField(info, "ModDate")

    return {
      title: pdfTitle || titleFromUrl(url),
      text,
      kind: "pdf",
      via: "extraction",
      metadata: {
        pdfPageCount: totalPages,
        pdfSha256: sha256,
        ...(pdfTitle ? { pdfTitle } : {}),
        ...(pdfAuthor ? { pdfAuthor } : {}),
        ...(pdfProducer ? { pdfProducer } : {}),
        ...(pdfCreatedAt ? { pdfCreatedAt } : {}),
        ...(pdfModifiedAt ? { pdfModifiedAt } : {}),
      },
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function isPdfExtension(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname) // query string ignored by construction
  } catch {
    return false
  }
}

function decodeAscii(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += String.fromCharCode(b)
  return out
}

/** pdf.js sets `.name === "PasswordException"` on both NEED/INCORRECT password errors. */
function isPasswordProtected(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return e.name === "PasswordException" || /password/i.test(e.message)
}

function stringField(
  info: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const v = info[key]
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function dateField(
  info: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const v = info[key]
  return v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : undefined
}

function titleFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop()
    return last ? decodeURIComponent(last) : url
  } catch {
    return url
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
