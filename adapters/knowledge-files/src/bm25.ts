/**
 * In-process BM25 — a tiny, dependency-free implementation tuned for
 * corpus-sized data (hundreds to low thousands of markdown files).
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
function stripFrontmatter(content: string): string {
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
  /** Original text (kept for snippet extraction at query time). */
  readonly text: string
  /** Token count — used for length-normalization in BM25. */
  readonly length: number
  /** Term frequency table for this doc. */
  readonly tf: ReadonlyMap<string, number>
}

export interface Bm25Index {
  readonly docs: readonly Bm25Doc[]
  /** Number of docs containing each term — used in IDF. */
  readonly df: ReadonlyMap<string, number>
  /** Average document length across the index, in tokens. */
  readonly avgDocLength: number
}

export interface BuildDocInput {
  readonly id: string
  readonly content: string
}

export function buildIndex(inputs: readonly BuildDocInput[]): Bm25Index {
  const docs: Bm25Doc[] = []
  const df = new Map<string, number>()
  let totalLength = 0
  for (const input of inputs) {
    const tokens = tokenize(stripFrontmatter(input.content))
    const tf = new Map<string, number>()
    for (const tok of tokens) {
      tf.set(tok, (tf.get(tok) ?? 0) + 1)
    }
    for (const term of tf.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
    docs.push({
      id: input.id,
      text: input.content,
      length: tokens.length,
      tf,
    })
    totalLength += tokens.length
  }
  const avgDocLength = docs.length === 0 ? 0 : totalLength / docs.length
  return { docs, df, avgDocLength }
}

/**
 * Async, event-loop-friendly variant of {@link buildIndex}. Identical output,
 * but yields to the macrotask queue every `yieldEvery` docs.
 *
 * Why this matters: the caller (`FilesKnowledgeAdapter._buildIndex`) reads docs
 * from an in-memory/cached fs, so the awaited reads resolve as MICROTASKS and
 * never hand control back to the event loop. Without an explicit yield, the
 * tokenization of every doc runs as one uninterruptible synchronous chain —
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
  const docs: Bm25Doc[] = []
  const df = new Map<string, number>()
  let totalLength = 0
  let i = 0
  for (const input of inputs) {
    if (i++ % yieldEvery === 0)
      await new Promise<void>(resolve => setImmediate(resolve))
    const tokens = tokenize(stripFrontmatter(input.content))
    const tf = new Map<string, number>()
    for (const tok of tokens) {
      tf.set(tok, (tf.get(tok) ?? 0) + 1)
    }
    for (const term of tf.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
    docs.push({
      id: input.id,
      text: input.content,
      length: tokens.length,
      tf,
    })
    totalLength += tokens.length
  }
  const avgDocLength = docs.length === 0 ? 0 : totalLength / docs.length
  return { docs, df, avgDocLength }
}

export interface ScoredHit {
  readonly doc: Bm25Doc
  readonly score: number
  /** Char range in `doc.text` around the first matching token. */
  readonly snippet?: {
    readonly start: number
    readonly end: number
    readonly text: string
  }
}

/**
 * Score every doc against the query tokens, return top-k.
 * Docs with score <= 0 are dropped (no terms matched).
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
  const out: ScoredHit[] = []

  for (const doc of index.docs) {
    let s = 0
    for (const term of queryTokens) {
      const f = doc.tf.get(term)
      if (!f) continue
      const n = index.df.get(term) ?? 0
      // BM25 IDF with +1 smoothing — see "Improvements to BM25 and
      // language models examined" (Lv & Zhai, 2011) for the rationale.
      const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1)
      const denom =
        f +
        K1 *
          (1 -
            B +
            (B * doc.length) /
              (index.avgDocLength === 0 ? 1 : index.avgDocLength))
      s += idf * ((f * (K1 + 1)) / denom)
    }
    if (s <= minScore) continue
    out.push({ doc, score: s, snippet: makeSnippet(doc.text, queryTokens) })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, topK)
}

/**
 * Pull a ~300-char window around the first matching query token in
 * the doc body. Falls back to the doc's head when no token matches in
 * the surfaced text (e.g. matches were all in the stripped frontmatter).
 */
function makeSnippet(
  text: string,
  queryTokens: readonly string[]
): { start: number; end: number; text: string } | undefined {
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
