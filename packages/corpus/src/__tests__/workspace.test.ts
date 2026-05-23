/**
 * Workspace integration tests across reader, validator, linter, event
 * emitter, and writer. Uses the frozen marketing fixture workspace as
 * the source of truth so the tests stay anchored to real
 * AIP-conformant data, not synthetic mock objects.
 */

import { describe, expect, it } from "vitest"
import { CorpusWorkspaceReader } from "../workspace/reader.js"
import {
  CorpusWorkspaceWriter,
  CorpusVersionConflictError,
} from "../workspace/writer.js"
import { CorpusValidator } from "../validate/validator.js"
import { CorpusLinter } from "../validate/linter.js"
import { CorpusEventEmitter } from "../events/emitter.js"
import { systemClock } from "../ports/clock.port.js"
import type { ClockPort } from "../ports/clock.port.js"
import type { IdentityPort } from "../ports/identity.port.js"
import { MemoryFs, loadM0FixtureFs } from "./_helpers/memory-fs.js"
import { loadAipSchemaBundle } from "./_helpers/schemas.js"

// ── Reader ──────────────────────────────────────────────────────────

describe("CorpusWorkspaceReader (M2)", () => {
  it("classifies every M0 fixture into the correct bucket", async () => {
    const fs = await loadM0FixtureFs()
    const reader = new CorpusWorkspaceReader({ fs })
    const snapshot = await reader.read("")

    expect(snapshot.workspace).not.toBeNull()
    expect(snapshot.workspace?.frontmatter.name).toBe("marketing-corpus")
    // Counts grew through M8 when the preset filled out. Keep them
    // tight enough to fail loudly on accidental fixture additions /
    // deletions, loose enough that a single-file change to the
    // marketing preset doesn't break unrelated tests.
    expect(snapshot.sources.length).toBe(1)
    expect(snapshot.entries.length).toBe(8)
    expect(snapshot.collections.length).toBe(1)
    expect(snapshot.collectionItems.length).toBe(1)
    expect(snapshot.playbooks.length).toBe(5)
    expect(snapshot.operators.length).toBe(6)
    expect(snapshot.workflows.length).toBe(7)
    expect(snapshot.routines.length).toBe(4)
    expect(snapshot.unknown.length).toBe(0)
  })

  it("computes a stable versionToken per file (sha256 prefix)", async () => {
    const fs = await loadM0FixtureFs()
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    for (const f of [
      snapshot.workspace,
      ...snapshot.entries,
      ...snapshot.sources,
    ]) {
      if (!f) continue
      expect(f.versionToken).toMatch(/^sha256:[a-f0-9]{64}$/)
    }
  })

  it("does NOT classify a misplaced file as its expected kind", async () => {
    const fs = new MemoryFs({
      "weird/place.md": "---\nschema: knowledge.entry/v1\n---\n",
    })
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    expect(snapshot.entries.length).toBe(0)
    expect(snapshot.unknown.length).toBe(1)
  })
})

// ── Validator ───────────────────────────────────────────────────────

describe("CorpusValidator (M2)", () => {
  it("validates the entire M0 fixture workspace without errors", async () => {
    const fs = await loadM0FixtureFs()
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const validator = new CorpusValidator({ bundle: loadAipSchemaBundle() })
    const result = validator.validateWorkspace(snapshot)
    if (!result.valid) {
      // Surface what failed so a test breakage in fixtures is debuggable.
      console.error(JSON.stringify(result.issues, null, 2))
    }
    // Note: AIP-10 `tags` allows `[a-z][a-z0-9-]*` only — fixtures may
    // have multi-word entries that need normalization. If this breaks
    // on a future fixture, the linter (or this very assertion) tells
    // us to fix the data, not the test.
    expect(result.valid).toBe(true)
  })

  it("detects an entry with the wrong authority enum (drift)", async () => {
    const fs = await loadM0FixtureFs()
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const validator = new CorpusValidator({ bundle: loadAipSchemaBundle() })
    // Tamper an entry in memory and validate the file directly.
    const source = snapshot.sources[0]!
    const tampered = {
      ...source,
      frontmatter: { ...source.frontmatter, authority: "tertiary" },
    }
    const out = validator.validateFile(tampered)
    expect(out.valid).toBe(false)
    expect(out.issues.length).toBeGreaterThan(0)
  })

  it("flags unknown files with an info-severity issue", async () => {
    const fs = new MemoryFs({
      "weird/place.md": "---\nfoo: bar\n---\nbody",
    })
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const validator = new CorpusValidator({ bundle: loadAipSchemaBundle() })
    const result = validator.validateWorkspace(snapshot)
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.issues[0]?.severity).toBe("info")
  })
})

// ── Linter ──────────────────────────────────────────────────────────

describe("CorpusLinter (M2)", () => {
  it("clean fixtures produce only the expected lints", async () => {
    const fs = await loadM0FixtureFs()
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const linter = new CorpusLinter({ clock: systemClock })
    const report = linter.lint(snapshot)

    // The KNOWLEDGE.md declares 5 lints:
    //   - require-source-on-examples  Example  error    (no Example entries in fixtures; should be 0 violations)
    //   - min-confidence-principles   Principle warn   (the one Principle has confidence 0.92 > 0.6; 0 violations)
    //   - max-age-timelines           Timeline  warn   (no Timeline entries; 0 violations)
    //   - broken-ref-all              *         error  (we'll check this dynamically)
    //   - orphan-all                  *         info   (the Critique has no incoming refs → 1 orphan info)
    expect(report.errorCount).toBe(0)
    expect(report.warnCount).toBe(0)
    // At least one orphan expected (the critique entry isn't referenced
    // anywhere). Don't pin the exact count — the fixture may grow.
    expect(report.infoCount).toBeGreaterThan(0)
  })

  it("detects a broken source ref", async () => {
    const fs = new MemoryFs({
      "KNOWLEDGE.md": [
        "---",
        "schema: knowledge.workspace/v1",
        "name: tiny",
        "title: Tiny",
        "description: tiny",
        'version: "1.0.0"',
        "lints:",
        '  - { id: broken-ref-all, kind: broken-ref, appliesTo: "*", severity: error }',
        "---",
      ].join("\n"),
      "entries/foo.md": [
        "---",
        "schema: knowledge.entry/v1",
        "slug: foo",
        "kind: principle",
        "title: Foo",
        'updated_at: "2026-01-01T00:00:00Z"',
        "sources: [missing-source-id]",
        "---",
      ].join("\n"),
    })
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const report = new CorpusLinter({ clock: systemClock }).lint(snapshot)
    expect(report.errorCount).toBe(1)
    expect(report.issues[0]?.lintId).toBe("broken-ref-all")
    expect(report.issues[0]?.message).toMatch(/missing-source-id/)
  })

  it("detects a low-confidence principle", async () => {
    const fs = new MemoryFs({
      "KNOWLEDGE.md": [
        "---",
        "schema: knowledge.workspace/v1",
        "name: tiny",
        "title: Tiny",
        "description: tiny",
        'version: "1.0.0"',
        "lints:",
        "  - { id: min-conf, kind: min-confidence, appliesTo: Principle, severity: warn, params: { min: 0.7 } }",
        "---",
      ].join("\n"),
      "entries/foo.md": [
        "---",
        "schema: knowledge.entry/v1",
        "slug: foo",
        "kind: principle",
        "title: Foo",
        'updated_at: "2026-01-01T00:00:00Z"',
        "confidence: 0.4",
        "---",
      ].join("\n"),
    })
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const report = new CorpusLinter({ clock: systemClock }).lint(snapshot)
    expect(report.warnCount).toBe(1)
    expect(report.issues[0]?.message).toMatch(/0\.4/)
  })

  it("detects stale entries via max-age", async () => {
    const fs = new MemoryFs({
      "KNOWLEDGE.md": [
        "---",
        "schema: knowledge.workspace/v1",
        "name: tiny",
        "title: Tiny",
        "description: tiny",
        'version: "1.0.0"',
        "lints:",
        "  - { id: stale, kind: max-age, appliesTo: Timeline, severity: warn, params: { days: 30 } }",
        "---",
      ].join("\n"),
      "entries/old.md": [
        "---",
        "schema: knowledge.entry/v1",
        "slug: old",
        "kind: timeline",
        "title: Old timeline",
        'updated_at: "2020-01-01T00:00:00Z"',
        "---",
      ].join("\n"),
    })
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    // Pin the clock so test is deterministic
    const fixedClock: ClockPort = {
      now: () => new Date("2026-05-22T00:00:00Z"),
      nowMs: () => Date.parse("2026-05-22T00:00:00Z"),
    }
    const report = new CorpusLinter({ clock: fixedClock }).lint(snapshot)
    expect(report.warnCount).toBe(1)
    expect(report.issues[0]?.lintId).toBe("stale")
  })
})

// ── Event Emitter ──────────────────────────────────────────────────

describe("CorpusEventEmitter (M2)", () => {
  const fixedClock: ClockPort = {
    now: () => new Date("2026-05-22T14:30:00.000Z"),
    nowMs: () => Date.parse("2026-05-22T14:30:00.000Z"),
  }
  const stubIdentity: IdentityPort = {
    resolve: async () => ({
      principal: "ws://operators/test-actor",
      identityTree: ["ws://operators/test-actor"],
    }),
  }

  it("creates _log.md on first emit with an AIP-10 header", async () => {
    const fs = new MemoryFs()
    const emitter = new CorpusEventEmitter({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspaceRoot: "",
    })
    await emitter.emit("corpus.entry.promoted", { slug: "foo", kind: "principle" })
    const log = await fs.readFile("_log.md")
    expect(log).toContain("# Corpus activity log")
    expect(log).toContain("Append-only AIP-10 log")
    expect(log).toMatch(
      /- 2026-05-22T14:30:00\.000Z {2}corpus\.entry\.promoted {2}by ws:\/\/operators\/test-actor {2}payload=\{"kind":"principle","slug":"foo"\}/
    )
  })

  it("appends subsequent events without rewriting the header", async () => {
    const fs = new MemoryFs()
    const emitter = new CorpusEventEmitter({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspaceRoot: "",
    })
    await emitter.emit("corpus.candidate.discovered", { id: "a" })
    await emitter.emit("corpus.candidate.analyzed", { id: "a" })
    const log = await fs.readFile("_log.md")
    const headers = log.match(/# Corpus activity log/g)
    expect(headers?.length).toBe(1)
    const events = log.match(/\n- 20/g)
    expect(events?.length).toBe(2)
  })

  it("sorts payload keys deterministically", async () => {
    const fs = new MemoryFs()
    const emitter = new CorpusEventEmitter({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspaceRoot: "",
    })
    await emitter.emit("corpus.entry.promoted", {
      zeta: 1,
      alpha: 2,
      mu: 3,
    })
    const log = await fs.readFile("_log.md")
    expect(log).toMatch(/payload=\{"alpha":2,"mu":3,"zeta":1\}/)
  })
})

// ── Writer ──────────────────────────────────────────────────────────

describe("CorpusWorkspaceWriter (M2)", () => {
  it("create-only mode (expected=null) refuses if file exists", async () => {
    const fs = new MemoryFs({ "foo.md": "existing" })
    const writer = new CorpusWorkspaceWriter({ fs })
    await expect(writer.writeFile("foo.md", "new", null)).rejects.toBeInstanceOf(
      CorpusVersionConflictError
    )
  })

  it("CAS mode (expected=hash) succeeds when current matches", async () => {
    const fs = new MemoryFs({ "foo.md": "v1" })
    const writer = new CorpusWorkspaceWriter({ fs })
    const t1 = CorpusWorkspaceWriter.versionTokenOf("v1")
    const t2 = await writer.writeFile("foo.md", "v2", t1)
    expect(t2).toBe(CorpusWorkspaceWriter.versionTokenOf("v2"))
    expect(await fs.readFile("foo.md")).toBe("v2")
  })

  it("CAS mode refuses when current does NOT match", async () => {
    const fs = new MemoryFs({ "foo.md": "v1-actual" })
    const writer = new CorpusWorkspaceWriter({ fs })
    const stale = CorpusWorkspaceWriter.versionTokenOf("v1-stale")
    await expect(
      writer.writeFile("foo.md", "v2", stale)
    ).rejects.toBeInstanceOf(CorpusVersionConflictError)
  })

  it("transaction serializes concurrent writers on the same lock", async () => {
    const fs = new MemoryFs()
    const writer = new CorpusWorkspaceWriter({ fs })
    const observed: string[] = []
    const a = writer.transaction("_lock", async () => {
      observed.push("A-start")
      await new Promise((r) => setTimeout(r, 10))
      observed.push("A-end")
    })
    const b = writer.transaction("_lock", async () => {
      observed.push("B-start")
      observed.push("B-end")
    })
    await Promise.all([a, b])
    // A's start/end MUST come before B's (or vice versa) — never interleaved.
    expect(observed.join(",")).toMatch(
      /^(A-start,A-end,B-start,B-end|B-start,B-end,A-start,A-end)$/
    )
  })

  it("writeMarkdown round-trips frontmatter + body", async () => {
    const fs = new MemoryFs()
    const writer = new CorpusWorkspaceWriter({ fs })
    await writer.writeMarkdown("note.md", {
      frontmatter: { slug: "x", kind: "principle" },
      body: "Hello world",
    })
    const content = await fs.readFile("note.md")
    expect(content).toMatch(/^---/)
    expect(content).toContain("slug: x")
    expect(content).toContain("kind: principle")
    expect(content).toContain("Hello world")
  })
})
