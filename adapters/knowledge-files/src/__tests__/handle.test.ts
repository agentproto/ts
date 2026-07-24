/**
 * Tests for the provider-kit family wiring: the catalog, the slug→handle
 * resolver (including the unknown-slug → null fold), the secret-free `info()`
 * descriptor, provider caching, and a live `check()` against a temp workspace.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FILES_BM25_SLUG, KNOWLEDGE_FILES_CATALOG } from "../catalog.js"
import {
  makeKnowledgeFilesResolver,
  resolveKnowledgeBackend,
} from "../handle.js"

describe("catalog", () => {
  it("advertises the single files backend under this package", () => {
    expect(KNOWLEDGE_FILES_CATALOG).toHaveLength(1)
    const entry = KNOWLEDGE_FILES_CATALOG[0]!
    expect(entry.slug).toBe(FILES_BM25_SLUG)
    expect(entry.packageName).toBe("@agentproto/adapter-knowledge-files")
  })
})

describe("resolveKnowledgeBackend", () => {
  it("resolves the files slug to a no-setup handle", () => {
    const handle = resolveKnowledgeBackend(FILES_BM25_SLUG)
    expect(handle.slug).toBe("files")
    expect(handle.requiresSetup).toBe(false)
    expect(handle.version).toBe("0.1.0")
  })

  it("returns a secret-free descriptor from info()", () => {
    const info = resolveKnowledgeBackend(FILES_BM25_SLUG).info()
    expect(info).toEqual({
      slug: "files",
      engine: "bm25",
      capabilities: { vectorSearch: false, needsCreds: false },
    })
  })

  it("caches provider() so repeated calls share one warm instance", () => {
    const handle = resolveKnowledgeBackend(FILES_BM25_SLUG)
    expect(handle.provider()).toBe(handle.provider())
  })

  it("throws for an unknown slug", () => {
    expect(() => resolveKnowledgeBackend("vectors")).toThrow(/unknown/)
  })
})

describe("makeKnowledgeFilesResolver", () => {
  it("resolves a known slug and folds an unknown slug to null", async () => {
    const resolver = makeKnowledgeFilesResolver()
    expect((await resolver(FILES_BM25_SLUG))?.slug).toBe("files")
    expect(await resolver("vectors")).toBeNull()
  })
})

describe("handle.check()", () => {
  let root: string
  const prevRoot = process.env.KNOWLEDGE_FILES_ROOT

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "knowledge-handle-"))
    process.env.KNOWLEDGE_FILES_ROOT = root
  })

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env.KNOWLEDGE_FILES_ROOT
    else process.env.KNOWLEDGE_FILES_ROOT = prevRoot
    await rm(root, { recursive: true, force: true })
  })

  it("is healthy once the knowledge workspace directory exists", async () => {
    const handle = resolveKnowledgeBackend(FILES_BM25_SLUG)
    // Default workspacePath is "knowledge"; absent → unhealthy.
    expect(await handle.check()).toBe(false)
    await mkdir(path.join(root, "knowledge"), { recursive: true })
    expect(await handle.check()).toBe(true)
  })
})
