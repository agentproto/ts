/**
 * Unit tests for the in-process BM25 index. These pin the tokenizer,
 * frontmatter stripping, ranking order, and snippet extraction so a scoring
 * regression is caught here rather than through a fuzzy relevance complaint.
 */

import { describe, expect, it } from "vitest"
import {
  buildIndex,
  buildIndexYielding,
  score,
  tokenize,
  type BuildDocInput,
} from "../bm25.js"

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumerics", () => {
    expect(tokenize("Hello, WORLD! foo_bar")).toEqual([
      "hello",
      "world",
      "foo",
      "bar",
    ])
  })

  it("keeps digits inside alphanumeric tokens (q3, not q + 3)", () => {
    expect(tokenize("revenue q3 2024")).toEqual(["revenue", "q3", "2024"])
  })

  it("drops stopwords and 1-char tokens", () => {
    // "a" is a stopword, "x" is below MIN_TOKEN_LEN.
    expect(tokenize("a cat is on x mat")).toEqual(["cat", "mat"])
  })

  it("drops tokens longer than the 32-char ceiling", () => {
    const long = "a".repeat(33)
    expect(tokenize(`ok ${long}`)).toEqual(["ok"])
  })
})

describe("buildIndex", () => {
  it("strips YAML frontmatter before tokenizing", () => {
    const [index] = [
      buildIndex([
        {
          id: "doc.md",
          content: "---\nschema: knowledge.entry/v1\n---\nbody words here",
        },
      ]),
    ]
    // The frontmatter key/value must NOT be in the vocabulary.
    expect(index.df.has("schema")).toBe(false)
    expect(index.df.has("knowledge")).toBe(false)
    expect(index.df.has("body")).toBe(true)
    expect(index.df.has("words")).toBe(true)
  })

  it("computes document-frequency and average length", () => {
    const index = buildIndex([
      { id: "a", content: "cat cat dog" },
      { id: "b", content: "dog bird" },
    ])
    expect(index.df.get("dog")).toBe(2)
    expect(index.df.get("cat")).toBe(1)
    expect(index.docs).toHaveLength(2)
    // (3 + 2) / 2 = 2.5
    expect(index.avgDocLength).toBe(2.5)
  })

  it("yields an empty index (avgDocLength 0) for no inputs", () => {
    const index = buildIndex([])
    expect(index.docs).toHaveLength(0)
    expect(index.avgDocLength).toBe(0)
  })
})

describe("buildIndexYielding", () => {
  it("produces byte-identical structure to the sync builder", async () => {
    const inputs: BuildDocInput[] = Array.from({ length: 120 }, (_, i) => ({
      id: `doc-${i}.md`,
      content: `token${i % 5} shared common word`,
    }))
    const sync = buildIndex(inputs)
    const async = await buildIndexYielding(inputs, 10)
    expect(async.docs.map(d => d.id)).toEqual(sync.docs.map(d => d.id))
    expect(async.avgDocLength).toBe(sync.avgDocLength)
    expect([...async.df.entries()].sort()).toEqual(
      [...sync.df.entries()].sort()
    )
  })
})

describe("score", () => {
  const index = buildIndex([
    { id: "cats.md", content: "cats are great cats purr cats sleep" },
    { id: "dogs.md", content: "dogs bark and dogs run" },
    { id: "mixed.md", content: "cats and dogs coexist" },
  ])

  it("ranks the doc with more query-term hits first", () => {
    const hits = score(index, tokenize("cats"))
    expect(hits[0]!.doc.id).toBe("cats.md")
    // cats.md (3 hits) outranks mixed.md (1 hit); dogs.md doesn't match.
    expect(hits.map(h => h.doc.id)).toEqual(["cats.md", "mixed.md"])
  })

  it("drops docs with no matching terms", () => {
    const hits = score(index, tokenize("penguin"))
    expect(hits).toEqual([])
  })

  it("returns [] for an empty query or empty index", () => {
    expect(score(index, [])).toEqual([])
    expect(score(buildIndex([]), tokenize("cats"))).toEqual([])
  })

  it("honours topK", () => {
    const hits = score(index, tokenize("cats dogs"), { topK: 1 })
    expect(hits).toHaveLength(1)
  })

  it("attaches a snippet around the first matching token", () => {
    const hits = score(index, tokenize("purr"))
    expect(hits[0]!.snippet?.text).toContain("purr")
  })
})
