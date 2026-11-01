/**
 * In-process BM25 — a tiny, dependency-free implementation tuned for
 * corpus-sized data (hundreds to low thousands of markdown files).
 *
 * Memory shape: the index keeps only what scoring needs. Doc text is NOT
 * retained (a snippet is cut from the file at query time, top-K hits only),
 * and there is no per-doc `Map`: every doc's (term id, term frequency) pairs
 * live in two shared packed typed arrays, sliced per doc by an offset table,
 * with one vocabulary map (term -> id) for the whole index. Keeping the full
 * text plus a per-doc `tf` Map cost about 6.5x the corpus bytes on disk.
 *
 * Tokenizer: lowercase, split on non-alphanum, length 2-32, drop a small
 * English stopword list. Frontmatter is stripped before tokenization so
 * fence values like `schema: knowledge.entry/v1` don't pollute the
 * vocabulary.
 *
 * Scoring: standard BM25 with k1=1.5, b=0.75 — Lucene defaults. IDF
 * uses the "BM25+1" smoothing so terms appearing in every doc still
 * contribute a tiny positive score (avoids the negative-IDF foot-gun
 * for high-frequency terms).
 */

const K1 = 1.5
const B = 0.75
const MIN_TOKEN_LEN = 2
const MAX_TOKEN_LEN = 32

// Short en stopword list — keeps the index lean without doing real NLP.
// Domain stopwords ("the company", "agentik") could be added per-corpus
// in a follow-up if the noise becomes meaningful.
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "he",
  "her",
  "his",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "which",
  "who",
  "will",
  "with",
  "you",
  "your",
])

/** Strip YAML frontmatter (--- ... ---) from a doc body if present. */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content
  const end = content.indexOf("\n---", 3)
  if (end === -1) return content
  return content.slice(end + 4)
}

export function tokenize(text: string): string[] {
  const out: string[] = []
  // Splitting on \W+ would lose digits in alphanumeric tokens like
  // "q3"; use a unicode-aware non-word class instead.
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LEN || raw.length > MAX_TOKEN_LEN) continue
    if (STOPWORDS.has(raw)) continue
    out.push(raw)
  }
  return out
}

export interface Bm25Doc {
  /** Stable id — typically the workspace-relative path. */
  readonly id: string
  /** Token count — used for length-normalization in BM25. */
  readonly length: number
}

export interface Bm25Index {
  /** Docs in build order; a doc's position is its index in the arrays below. */
  readonly docs: readonly Bm25Doc[]
  /** Term -> term id. One entry per distinct term across the whole index. */
  readonly vocab: ReadonlyMap<string, number>
  /** Number of docs containing each term (by term id), used in IDF. */
  readonly df: Uint32Array
  /** Doc `i`'s postings span `[offsets[i], offsets[i + 1])` in
   *  {@link termIds} / {@link tfs}. Length is `docs.length + 1`. */
  readonly offsets: Uint32Array
  /** Term ids, ascending within each doc's span. */
  readonly termIds: Uint32Array
  /** Term frequency of the matching {@link termIds} entry. */
  readonly tfs: Uint32Array
  /** Average document length across the index, in tokens. */
  readonly avgDocLength: number
}

export interface BuildDocInput {
  readonly id: string
  readonly content: string
}

/** Growable `Uint32Array` (capacity doubling), trimmed on {@link take}. */
class U32Buffer {
  private buf: Uint32Array
  length = 0

  constructor(capacity = 1024) {
    this.buf = new Uint32Array(capacity)
  }

  push(value: number): void {
    if (this.length === this.buf.length) {
      const next = new Uint32Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.length++] = value
  }

  get(i: number): number {
    return this.buf[i]!
  }

  set(i: number, value: number): void {
    this.buf[i] = value
  }

  take(): Uint32Array {
    return this.buf.slice(0, this.length)
  }
}

/**
 * A copy of `term` that shares no storage with the text it was cut from.
 * `split()` may hand back a slice that points into the lowercased doc, and a
 * vocabulary key that is such a slice keeps that whole doc alive.
 */
function ownString(term: string): string {
  return JSON.parse(JSON.stringify(term)) as string
}

/**
 * Incremental index builder: {@link add} one doc at a time (the caller can
 * drop the doc's text right after), then {@link finish}. Docs keep the order
 * they were added in, which is also the tie-break order of {@link score}.
 */
export class Bm25IndexBuilder {
  private readonly docs: Bm25Doc[] = []
  private readonly vocab = new Map<string, number>()
  private readonly df = new U32Buffer()
  private readonly offsets = new U32Buffer()
  private readonly termIds = new U32Buffer(64 * 1024)
  private readonly tfs = new U32Buffer(64 * 1024)
  private totalLength = 0

  constructor() {
    this.offsets.push(0)
  }

  get docCount(): number {
    return this.docs.length
  }

  add(id: string, content: string): void {
    const tokens = tokenize(stripFrontmatter(content))
    const tf = new Map<number, number>()
    for (const tok of tokens) {
      let termId = this.vocab.get(tok)
      if (termId === undefined) {
        termId = this.vocab.size
        this.vocab.set(ownString(tok), termId)
        this.df.push(0)
      }
      tf.set(termId, (tf.get(termId) ?? 0) + 1)
    }
    const ids = [...tf.keys()].sort((a, b) => a - b)
    for (const termId of ids) {
      this.termIds.push(termId)
      this.tfs.push(tf.get(termId)!)
      this.df.set(termId, this.df.get(termId) + 1)
    }
    this.offsets.push(this.termIds.length)
    this.docs.push({ id, length: tokens.length })
    this.totalLength += tokens.length
  }

  finish(): Bm25Index {
    const avgDocLength =
      this.docs.length === 0 ? 0 : this.totalLength / this.docs.length
    return {
      docs: this.docs,
      vocab: this.vocab,
      df: this.df.take(),
      offsets: this.offsets.take(),
      termIds: this.termIds.take(),
      tfs: this.tfs.take(),
      avgDocLength,
    }
  }
}

export function buildIndex(inputs: readonly BuildDocInput[]): Bm25Index {
  const builder = new Bm25IndexBuilder()
  for (const input of inputs) builder.add(input.id, input.content)
  return builder.finish()
}

/**
 * Async, event-loop-friendly variant of {@link buildIndex}. Identical output,
 * but yields to the macrotask queue every `yieldEvery` docs.
 *
 * Why this matters (the adapter's own build loop yields the same way): a caller
 * that reads docs from an in-memory/cached fs sees the awaited reads resolve
 * as MICROTASKS, which never hand control back to the event loop. Without an
 * explicit yield, the tokenization of every doc runs as one uninterruptible
 * synchronous chain —
 * which (a) freezes every concurrent recall on this single-process, multi-tenant
 * instance for the full build and (b) defeats `ensureIndex`'s non-blocking
 * `setTimeout` deadline (the timer can't fire while the loop is blocked). The
 * `setImmediate` yield lets sibling turns progress and the deadline fire during a
 * cold build.
 */
export async function buildIndexYielding(
  inputs: readonly BuildDocInput[],
  yieldEvery = 50
): Promise<Bm25Index> {
  const builder = new Bm25IndexBuilder()
  let i = 0
  for (const input of inputs) {
    if (i++ % yieldEvery === 0)
      await new Promise<void>(resolve => setImmediate(resolve))
    builder.add(input.id, input.content)
  }
  return builder.finish()
}

/** Docs containing `term` (0 when the term is not in the index). */
export function documentFrequency(index: Bm25Index, term: string): number {
  const termId = index.vocab.get(term)
  return termId === undefined ? 0 : index.df[termId]!
}

/** Frequency of `termId` in doc `docIndex` (binary search of its span). */
function termFrequency(
  index: Bm25Index,
  docIndex: number,
  termId: number
): number {
  let lo = index.offsets[docIndex]!
  let hi = index.offsets[docIndex + 1]! - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const at = index.termIds[mid]!
    if (at === termId) return index.tfs[mid]!
    if (at < termId) lo = mid + 1
    else hi = mid - 1
  }
  return 0
}

export interface ScoredHit {
  readonly doc: Bm25Doc
  readonly score: number
}

/**
 * Score every doc against the query tokens, return top-k.
 * Docs with score <= minScore (default 0: no terms matched) are dropped.
 * The index holds no text: cut a snippet with {@link makeSnippet} from the
 * doc's content once the top-k is known.
 */
export function score(
  index: Bm25Index,
  queryTokens: readonly string[],
  opts: { readonly topK?: number; readonly minScore?: number } = {}
): ScoredHit[] {
  if (queryTokens.length === 0 || index.docs.length === 0) return []
  const topK = opts.topK ?? 10
  const minScore = opts.minScore ?? 0
  const N = index.docs.length
  const avgDocLength = index.avgDocLength === 0 ? 1 : index.avgDocLength
  // Resolve each query token once. Unknown terms match no doc and add
  // nothing; duplicates stay, so a repeated token counts again.
  const terms: Array<{ termId: number; idf: number }> = []
  for (const tok of queryTokens) {
    const termId = index.vocab.get(tok)
    if (termId === undefined) continue
    const n = index.df[termId]!
    // BM25 IDF with +1 smoothing — see "Improvements to BM25 and
    // language models examined" (Lv & Zhai, 2011) for the rationale.
    terms.push({ termId, idf: Math.log((N - n + 0.5) / (n + 0.5) + 1) })
  }
  const out: ScoredHit[] = []

  for (let i = 0; i < N; i++) {
    const doc = index.docs[i]!
    let s = 0
    for (const { termId, idf } of terms) {
      const f = termFrequency(index, i, termId)
      if (!f) continue
      const denom = f + K1 * (1 - B + (B * doc.length) / avgDocLength)
      s += idf * ((f * (K1 + 1)) / denom)
    }
    if (s <= minScore) continue
    out.push({ doc, score: s })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, topK)
}

/**
 * Pull a ~300-char window around the first matching query token in
 * the doc body. Falls back to the doc's head when no token matches in
 * the surfaced text (e.g. matches were all in the stripped frontmatter).
 * `start` / `end` are char offsets in `text` (the whole file).
 */
export function makeSnippet(
  text: string,
  queryTokens: readonly string[]
): { start: number; end: number; text: string } {
  const body = stripFrontmatter(text)
  const offset = text.length - body.length
  const lower = body.toLowerCase()
  let firstAt = -1
  for (const tok of queryTokens) {
    const idx = lower.indexOf(tok)
    if (idx !== -1 && (firstAt === -1 || idx < firstAt)) firstAt = idx
  }
  const around = 150
  const start = Math.max(0, (firstAt === -1 ? 0 : firstAt) - around)
  const end = Math.min(body.length, start + 300)
  return {
    start: offset + start,
    end: offset + end,
    text: body.slice(start, end),
  }
}
