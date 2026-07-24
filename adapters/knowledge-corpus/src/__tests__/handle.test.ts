/**
 * Tests for the provider-kit family wiring: the catalog, the slug→handle
 * resolver (including the unknown-slug → null fold), the secret-free `info()`
 * descriptor, the composable `provider(backing)` factory, and a live `check()`
 * against a temp corpus workspace.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CORPUS_SLUG, KNOWLEDGE_CORPUS_CATALOG } from "../catalog.js"
import {
  makeKnowledgeCorpusResolver,
  resolveKnowledgeBackend,
} from "../handle.js"
import { makeStubProvider } from "./_helpers.js"

const KNOWLEDGE_MD = [
  "---",
  "schema: knowledge.workspace/v1",
  "name: t",
  "title: T",
  "description: t",
  'version: "1.0.0"',
  "---",
].join("\n")

describe("catalog", () => {
  it("advertises the single corpus backend under this package", () => {
    expect(KNOWLEDGE_CORPUS_CATALOG).toHaveLength(1)
    const entry = KNOWLEDGE_CORPUS_CATALOG[0]!
    expect(entry.slug).toBe(CORPUS_SLUG)
    expect(entry.packageName).toBe("@agentproto/adapter-knowledge-corpus")
  })
})

describe("resolveKnowledgeBackend", () => {
  it("resolves the corpus slug to a no-setup handle", () => {
    const handle = resolveKnowledgeBackend(CORPUS_SLUG)
    expect(handle.slug).toBe("corpus")
    expect(handle.requiresSetup).toBe(false)
    expect(handle.version).toBe("0.1.0")
  })

  it("returns a secret-free descriptor from info()", () => {
    const info = resolveKnowledgeBackend(CORPUS_SLUG).info()
    expect(info).toEqual({
      slug: "corpus",
      engine: "corpus",
      composable: true,
      capabilities: { vectorSearch: false, needsCreds: false },
    })
  })

  it("provider() builds a corpus adapter wrapping the supplied backing", () => {
    const handle = resolveKnowledgeBackend(CORPUS_SLUG)
    const { provider: backing } = makeStubProvider({ id: "stub-backing" })
    const provider = handle.provider({ backing, root: process.cwd() })
    expect(provider.id).toBe("corpus")
    // Fresh instance per call — the corpus wrapper holds no shared warm cache.
    expect(handle.provider()).not.toBe(handle.provider())
  })

  it("throws for an unknown slug", () => {
    expect(() => resolveKnowledgeBackend("vectors")).toThrow(/unknown/)
  })
})

describe("makeKnowledgeCorpusResolver", () => {
  it("resolves a known slug and folds an unknown slug to null", async () => {
    const resolver = makeKnowledgeCorpusResolver()
    expect((await resolver(CORPUS_SLUG))?.slug).toBe("corpus")
    expect(await resolver("vectors")).toBeNull()
  })
})

describe("handle.check()", () => {
  let root: string
  const prevRoot = process.env.KNOWLEDGE_CORPUS_ROOT
  const prevPath = process.env.KNOWLEDGE_CORPUS_PATH

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "knowledge-corpus-handle-"))
    process.env.KNOWLEDGE_CORPUS_ROOT = root
    process.env.KNOWLEDGE_CORPUS_PATH = ""
  })

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env.KNOWLEDGE_CORPUS_ROOT
    else process.env.KNOWLEDGE_CORPUS_ROOT = prevRoot
    if (prevPath === undefined) delete process.env.KNOWLEDGE_CORPUS_PATH
    else process.env.KNOWLEDGE_CORPUS_PATH = prevPath
    await rm(root, { recursive: true, force: true })
  })

  it("is healthy once the corpus workspace KNOWLEDGE.md exists", async () => {
    const handle = resolveKnowledgeBackend(CORPUS_SLUG)
    // KNOWLEDGE.md absent → unhealthy.
    expect(await handle.check()).toBe(false)
    await writeFile(path.join(root, "KNOWLEDGE.md"), KNOWLEDGE_MD, "utf8")
    expect(await handle.check()).toBe(true)
  })
})
