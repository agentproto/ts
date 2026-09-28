/**
 * Core session-artifact store (`session-artifacts.ts`) — content-addressed
 * write, version accrual/dedup, pin, bounded read, and the path-containment
 * guards the raw-serve HTTP route depends on.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  addSessionArtifact,
  getSessionArtifact,
  listSessionArtifacts,
  pinSessionArtifact,
  resolveArtifactPath,
  resolveSiteFile,
} from "../session-artifacts.js"

describe("session-artifacts", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-artifacts-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("materializes inline bytes as version 1, content-addressed", () => {
    const bytes = Buffer.from("hello world").toString("base64")
    const { record, version, added } = addSessionArtifact(
      "sess_1",
      { key: "report", name: "report.txt", mimeType: "text/plain", createdBy: "agent", bytes },
      tmp,
    )
    expect(added).toBe(true)
    expect(record.key).toBe("report")
    expect(record.kind).toBe("document")
    expect(version.version).toBe(1)
    expect(version.size).toBe(11)
    expect(version.isDirectory).toBe(false)
  })

  it("bumps the version when the same key is re-added with different content", () => {
    const v1 = addSessionArtifact(
      "sess_1",
      { key: "report", name: "report.txt", createdBy: "agent", bytes: Buffer.from("v1").toString("base64") },
      tmp,
    )
    const v2 = addSessionArtifact(
      "sess_1",
      { key: "report", name: "report.txt", createdBy: "agent", bytes: Buffer.from("v2").toString("base64") },
      tmp,
    )
    expect(v1.version.version).toBe(1)
    expect(v2.version.version).toBe(2)
    expect(v2.added).toBe(true)
    expect(v2.record.versions).toHaveLength(2)
  })

  it("dedupes an identical re-add of the same key against the latest version", () => {
    const bytes = Buffer.from("same bytes").toString("base64")
    const v1 = addSessionArtifact("sess_1", { key: "report", createdBy: "agent", bytes }, tmp)
    const v2 = addSessionArtifact("sess_1", { key: "report", createdBy: "agent", bytes }, tmp)
    expect(v2.added).toBe(false)
    expect(v2.version.version).toBe(v1.version.version)
    expect(listSessionArtifacts("sess_1", tmp).find(r => r.key === "report")?.versions).toHaveLength(1)
  })

  it("copies a file from sourcePath, inferring kind from its extension", () => {
    const src = join(tmp, "src.pdf")
    writeFileSync(src, Buffer.from("%PDF-fake"))
    const { record, version } = addSessionArtifact(
      "sess_1",
      { key: "doc", createdBy: "user", sourcePath: src },
      tmp,
    )
    expect(record.kind).toBe("pdf")
    expect(version.isDirectory).toBe(false)
    const abs = resolveArtifactPath("sess_1", version, tmp)
    expect(abs).toBeDefined()
  })

  it("copies a directory from sourcePath as a site, browsable via resolveSiteFile", () => {
    const siteDir = join(tmp, "export-site")
    mkdirSync(siteDir, { recursive: true })
    writeFileSync(join(siteDir, "index.html"), "<h1>hi</h1>")
    mkdirSync(join(siteDir, "assets"), { recursive: true })
    writeFileSync(join(siteDir, "assets", "app.css"), "body{}")

    const { record, version } = addSessionArtifact(
      "sess_1",
      { key: "my-site", createdBy: "agent", sourcePath: siteDir },
      tmp,
    )
    expect(record.kind).toBe("site")
    expect(version.isDirectory).toBe(true)

    const indexPath = resolveSiteFile("sess_1", version, "", tmp)
    expect(indexPath).toBeDefined()
    const cssPath = resolveSiteFile("sess_1", version, "assets/app.css", tmp)
    expect(cssPath).toBeDefined()
  })

  it("rejects a resolveSiteFile subPath that escapes the version's own directory", () => {
    const siteDir = join(tmp, "export-site-2")
    mkdirSync(siteDir, { recursive: true })
    writeFileSync(join(siteDir, "index.html"), "<h1>hi</h1>")
    const { version } = addSessionArtifact("sess_1", { key: "site2", createdBy: "agent", sourcePath: siteDir }, tmp)

    expect(resolveSiteFile("sess_1", version, "../../../etc/passwd", tmp)).toBeUndefined()
  })

  it("pins and unpins an existing artifact, no-ops on an unknown key", () => {
    addSessionArtifact("sess_1", { key: "report", createdBy: "agent", bytes: Buffer.from("x").toString("base64") }, tmp)
    const pinned = pinSessionArtifact("sess_1", "report", true, tmp)
    expect(pinned?.pinned).toBe(true)
    const unpinned = pinSessionArtifact("sess_1", "report", false, tmp)
    expect(unpinned?.pinned).toBe(false)
    expect(pinSessionArtifact("sess_1", "does-not-exist", true, tmp)).toBeUndefined()
  })

  it("bounds getSessionArtifact's content read and flags truncation", () => {
    const big = "a".repeat(1000)
    addSessionArtifact(
      "sess_1",
      { key: "big", mimeType: "text/plain", createdBy: "agent", bytes: Buffer.from(big).toString("base64") },
      tmp,
    )
    const full = getSessionArtifact("sess_1", "big", {}, tmp)
    expect(full?.truncated).toBe(false)
    expect(full?.content?.length).toBe(1000)

    const bounded = getSessionArtifact("sess_1", "big", { maxBytes: 100 }, tmp)
    expect(bounded?.truncated).toBe(true)
    expect(bounded?.content?.length).toBe(100)
  })

  it("returns metadata without content for a site (directory) version", () => {
    const siteDir = join(tmp, "export-site-3")
    mkdirSync(siteDir, { recursive: true })
    writeFileSync(join(siteDir, "index.html"), "<h1>hi</h1>")
    addSessionArtifact("sess_1", { key: "site3", createdBy: "agent", sourcePath: siteDir }, tmp)
    const result = getSessionArtifact("sess_1", "site3", {}, tmp)
    expect(result?.content).toBeUndefined()
    expect(result?.truncated).toBe(false)
    expect(result?.version.isDirectory).toBe(true)
  })

  it("lists most-recently-updated first", () => {
    addSessionArtifact("sess_1", { key: "old", createdBy: "agent", bytes: Buffer.from("a").toString("base64") }, tmp)
    addSessionArtifact("sess_1", { key: "new", createdBy: "agent", bytes: Buffer.from("b").toString("base64") }, tmp)
    const keys = listSessionArtifacts("sess_1", tmp).map(r => r.key)
    expect(keys[0]).toBe("new")
    expect(keys[1]).toBe("old")
  })

  it("scopes artifacts per session", () => {
    addSessionArtifact("sess_a", { key: "k", createdBy: "agent", bytes: Buffer.from("a").toString("base64") }, tmp)
    expect(listSessionArtifacts("sess_b", tmp)).toHaveLength(0)
  })
})
