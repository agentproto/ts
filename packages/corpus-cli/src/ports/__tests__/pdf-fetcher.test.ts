import { createHash } from "node:crypto"
import { describe, it, expect, vi, afterEach } from "vitest"
import { PdfFetcher, type PdfExtraction, type PdfExtractor } from "../pdf-fetcher.adapter.js"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function mockFetch(opts: { status?: number; ct?: string; body: Uint8Array | string }) {
  globalThis.fetch = vi.fn<typeof fetch>(async () =>
    new Response(opts.body, {
      status: opts.status ?? 200,
      headers: { "content-type": opts.ct ?? "application/pdf" },
    })
  )
}

/** A trivial buffer that merely starts with the PDF magic bytes — enough
 * to pass the fetcher's own magic-byte gate when a fake `extract` stands
 * in for real pdf.js parsing (routing / sha256 / error-classification
 * tests don't need a byte-perfect PDF). */
const FAKE_PDF_BYTES = new TextEncoder().encode("%PDF-1.4\nnot a real pdf body, just magic bytes")

function fakeExtractor(result: PdfExtraction | (() => Promise<PdfExtraction>)): PdfExtractor {
  return async () => (typeof result === "function" ? result() : result)
}

/**
 * Builds a genuine, byte-correct, minimal single/multi-page PDF (own xref
 * table computed from real offsets) so at least one test exercises the
 * REAL `unpdf` extraction pipeline end-to-end, not just the fetcher's own
 * routing/error logic. `pages: []` in the loop below yields zero-text
 * pages for the "no text layer" case — no image data needed, an empty
 * content stream is a legitimate zero-text PDF.
 */
function buildMinimalPdf(opts: {
  readonly pages: readonly string[]
  readonly title?: string
  readonly author?: string
  readonly producer?: string
  readonly creationDate?: string
  readonly modDate?: string
}): Uint8Array {
  const enc = new TextEncoder()
  const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
  const byteLength = (s: string) => enc.encode(s).length

  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  const pushObj = (num: number, content: string) => {
    offsets[num] = byteLength(body)
    body += `${num} 0 obj\n${content}\nendobj\n`
  }

  const pageCount = opts.pages.length
  const fontObjNum = 3 + pageCount * 2
  const infoObjNum = fontObjNum + 1

  pushObj(1, "<< /Type /Catalog /Pages 2 0 R >>")

  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ")
  pushObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`)

  opts.pages.forEach((text, i) => {
    const pageNum = 3 + i * 2
    const contentsNum = pageNum + 1
    pushObj(
      pageNum,
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> ` +
        `/MediaBox [0 0 612 792] /Contents ${contentsNum} 0 R >>`
    )
    const stream = text ? `BT /F1 24 Tf 72 700 Td (${escape(text)}) Tj ET` : ""
    pushObj(contentsNum, `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  })

  pushObj(fontObjNum, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

  const infoFields: string[] = []
  if (opts.title) infoFields.push(`/Title (${escape(opts.title)})`)
  if (opts.author) infoFields.push(`/Author (${escape(opts.author)})`)
  if (opts.producer) infoFields.push(`/Producer (${escape(opts.producer)})`)
  if (opts.creationDate) infoFields.push(`/CreationDate (${opts.creationDate})`)
  if (opts.modDate) infoFields.push(`/ModDate (${opts.modDate})`)
  pushObj(infoObjNum, `<< ${infoFields.join(" ")} >>`)

  const totalObjs = infoObjNum
  const xrefOffset = byteLength(body)
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`
  for (let n = 1; n <= totalObjs; n++) {
    const off = offsets[n]
    if (off === undefined) throw new Error(`missing offset for obj ${n}`)
    xref += `${String(off).padStart(10, "0")} 00000 n \n`
  }
  const trailer =
    `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R /Info ${infoObjNum} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF`

  body += xref + trailer
  return enc.encode(body)
}

describe("PdfFetcher — routing", () => {
  it("claims a URL ending in .pdf", async () => {
    mockFetch({ ct: "application/octet-stream", body: FAKE_PDF_BYTES })
    const f = new PdfFetcher({
      extract: fakeExtractor({ totalPages: 1, pageTexts: ["hello"], info: {} }),
    })
    const out = await f.fetch("https://example.com/report.pdf")
    expect(out?.kind).toBe("pdf")
  })

  it("claims a URL ending in .pdf with a query string", async () => {
    mockFetch({ ct: "application/octet-stream", body: FAKE_PDF_BYTES })
    const f = new PdfFetcher({
      extract: fakeExtractor({ totalPages: 1, pageTexts: ["hello"], info: {} }),
    })
    const out = await f.fetch("https://example.com/report.pdf?x=1&y=2")
    expect(out?.kind).toBe("pdf")
  })

  it("claims an extension-less URL when content-type is application/pdf (court/registry portals)", async () => {
    mockFetch({ ct: "application/pdf; charset=binary", body: FAKE_PDF_BYTES })
    const f = new PdfFetcher({
      extract: fakeExtractor({ totalPages: 1, pageTexts: ["ruling text"], info: {} }),
    })
    const out = await f.fetch("https://justice.example.gouv.fr/decisions/12345")
    expect(out?.kind).toBe("pdf")
    expect(out?.text).toContain("ruling text")
  })

  it("returns null (not mine) for a non-PDF, non-.pdf URL", async () => {
    mockFetch({ ct: "text/html", body: "<html></html>" })
    const f = new PdfFetcher()
    expect(await f.fetch("https://example.com/article")).toBeNull()
  })

  it("returns null on a non-OK response", async () => {
    mockFetch({ status: 404, ct: "application/pdf", body: FAKE_PDF_BYTES })
    const f = new PdfFetcher()
    expect(await f.fetch("https://example.com/report.pdf")).toBeNull()
  })

  it("returns null on a network failure", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => {
      throw new Error("ECONNRESET")
    })
    const f = new PdfFetcher()
    expect(await f.fetch("https://example.com/report.pdf")).toBeNull()
  })
})

describe("PdfFetcher — magic-byte validation", () => {
  it("rejects HTML served with a application/pdf content-type — throws, does not silently pass through", async () => {
    mockFetch({ ct: "application/pdf", body: "<html><body>not a pdf</body></html>" })
    const f = new PdfFetcher()
    await expect(f.fetch("https://example.com/fake.pdf")).rejects.toThrow(/not a PDF/)
  })

  it("rejects a .pdf URL whose bytes don't start with %PDF-", async () => {
    mockFetch({ ct: "application/octet-stream", body: "definitely not a pdf" })
    const f = new PdfFetcher()
    await expect(f.fetch("https://example.com/report.pdf")).rejects.toThrow(/not a PDF/)
  })
})

describe("PdfFetcher — hard failures surface, never a silent empty source", () => {
  it("throws a clear error for a password-protected PDF", async () => {
    mockFetch({ body: FAKE_PDF_BYTES })
    const passwordError = Object.assign(new Error("No password given"), {
      name: "PasswordException",
    })
    const f = new PdfFetcher({
      extract: fakeExtractor(() => Promise.reject(passwordError)),
    })
    await expect(f.fetch("https://example.com/locked.pdf")).rejects.toThrow(
      /password-protected/
    )
  })

  it("throws a clear error for a scanned PDF with no text layer (not a silent empty source)", async () => {
    mockFetch({ body: FAKE_PDF_BYTES })
    const f = new PdfFetcher({
      extract: fakeExtractor({ totalPages: 3, pageTexts: ["", "  ", ""], info: {} }),
    })
    await expect(f.fetch("https://example.com/scan.pdf")).rejects.toThrow(
      /no extractable text layer/
    )
  })

  it("wraps an unrelated open failure with url + cause context", async () => {
    mockFetch({ body: FAKE_PDF_BYTES })
    const f = new PdfFetcher({
      extract: fakeExtractor(() => Promise.reject(new Error("InvalidPDFException: bad xref"))),
    })
    await expect(f.fetch("https://example.com/broken.pdf")).rejects.toThrow(
      /failed to open PDF.*broken\.pdf.*bad xref/s
    )
  })
})

describe("PdfFetcher — provenance", () => {
  it("preserves page breaks as explicit markers and reports page count", async () => {
    mockFetch({ body: FAKE_PDF_BYTES })
    const f = new PdfFetcher({
      extract: fakeExtractor({
        totalPages: 2,
        pageTexts: ["first page body", "second page body"],
        info: { Title: "A Ruling" },
      }),
    })
    const out = await f.fetch("https://example.com/ruling.pdf")
    expect(out?.text).toContain("--- page 1 of 2 ---")
    expect(out?.text).toContain("first page body")
    expect(out?.text).toContain("--- page 2 of 2 ---")
    expect(out?.text).toContain("second page body")
    expect(out?.metadata?.pdfPageCount).toBe(2)
  })

  it("carries title/author/producer/dates from the PDF info dict into metadata", async () => {
    mockFetch({ body: FAKE_PDF_BYTES })
    const created = new Date("2026-01-01T12:00:00Z")
    const modified = new Date("2026-06-15T09:30:00Z")
    const f = new PdfFetcher({
      extract: fakeExtractor({
        totalPages: 1,
        pageTexts: ["body"],
        info: {
          Title: "Décision n°42",
          Author: "Cour d'appel",
          Producer: "Acrobat Distiller",
          CreationDate: created,
          ModDate: modified,
        },
      }),
    })
    const out = await f.fetch("https://example.com/decision.pdf")
    expect(out?.title).toBe("Décision n°42")
    expect(out?.metadata?.pdfTitle).toBe("Décision n°42")
    expect(out?.metadata?.pdfAuthor).toBe("Cour d'appel")
    expect(out?.metadata?.pdfProducer).toBe("Acrobat Distiller")
    expect(out?.metadata?.pdfCreatedAt).toBe(created.toISOString())
    expect(out?.metadata?.pdfModifiedAt).toBe(modified.toISOString())
  })

  it("falls back to the URL's last path segment as title when the PDF carries none", async () => {
    mockFetch({ body: FAKE_PDF_BYTES })
    const f = new PdfFetcher({
      extract: fakeExtractor({ totalPages: 1, pageTexts: ["body"], info: {} }),
    })
    const out = await f.fetch("https://example.com/docs/annual-report.pdf")
    expect(out?.title).toBe("annual-report.pdf")
  })

  it("computes a stable sha256 of the raw PDF bytes — same bytes, same hash", async () => {
    const expected =
      "sha256:" + createHash("sha256").update(FAKE_PDF_BYTES).digest("hex")

    mockFetch({ body: FAKE_PDF_BYTES })
    const f1 = new PdfFetcher({
      extract: fakeExtractor({ totalPages: 1, pageTexts: ["a"], info: {} }),
    })
    const out1 = await f1.fetch("https://example.com/a.pdf")

    mockFetch({ body: FAKE_PDF_BYTES })
    const f2 = new PdfFetcher({
      extract: fakeExtractor({ totalPages: 1, pageTexts: ["a"], info: {} }),
    })
    const out2 = await f2.fetch("https://example.com/mirror/a.pdf")

    expect(out1?.metadata?.pdfSha256).toBe(expected)
    expect(out2?.metadata?.pdfSha256).toBe(expected)
    expect(out1?.metadata?.pdfSha256).toBe(out2?.metadata?.pdfSha256)
  })
})

describe("PdfFetcher — real unpdf extraction (no injected fake)", () => {
  it("extracts text + info from a genuine 2-page PDF, preserving page breaks", async () => {
    const pdfBytes = buildMinimalPdf({
      pages: ["Page one text.", "Page two text."],
      title: "Test Document",
      author: "Jest Fixture",
      producer: "corpus-cli test suite",
      creationDate: "D:20260101120000Z",
      modDate: "D:20260615093000Z",
    })
    mockFetch({ body: pdfBytes })

    const out = await new PdfFetcher().fetch("https://example.com/real.pdf")

    expect(out?.kind).toBe("pdf")
    expect(out?.via).toBe("extraction")
    expect(out?.title).toBe("Test Document")
    expect(out?.text).toContain("Page one text.")
    expect(out?.text).toContain("Page two text.")
    expect(out?.text).toContain("--- page 1 of 2 ---")
    expect(out?.text).toContain("--- page 2 of 2 ---")
    expect(out?.metadata?.pdfPageCount).toBe(2)
    expect(out?.metadata?.pdfAuthor).toBe("Jest Fixture")
    expect(out?.metadata?.pdfProducer).toBe("corpus-cli test suite")
    expect(typeof out?.metadata?.pdfCreatedAt).toBe("string")
    expect(typeof out?.metadata?.pdfSha256).toBe("string")
  })

  it("throws the no-text-layer error for a genuine scanned (text-less) PDF", async () => {
    const pdfBytes = buildMinimalPdf({ pages: [""] })
    mockFetch({ body: pdfBytes })

    await expect(
      new PdfFetcher().fetch("https://example.com/scan-real.pdf")
    ).rejects.toThrow(/no extractable text layer/)
  })
})
