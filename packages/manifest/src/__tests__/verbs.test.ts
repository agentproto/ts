import { describe, it, expect } from "vitest"
import matter from "gray-matter"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createVerbs, updateManifestSet, type DoctypeSpec, type ManifestOp } from "../index.js"

// Minimal fake doctype to test verbs in isolation. The real packages
// (@agentproto/tool, …) wire createVerbs against their own define +
// parse; this test verifies the verb mechanics, not any specific AIP.
interface FakeParams {
  id: string
  description: string
  tags?: readonly string[]
}
interface FakeHandle extends FakeParams {
  readonly id: string
  readonly description: string
  readonly tags: readonly string[]
}

const fakeSpec: DoctypeSpec<FakeParams, FakeHandle> = {
  name: "fake",
  aip: 999,
  schemaLiteral: "agentproto/fake/v1",
  pathOf: (h) => `${h.id}/FAKE.md`,
  define: (params) => {
    if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(params.id)) {
      throw new Error(`defineFake: invalid id '${params.id}'`)
    }
    return Object.freeze({
      id: params.id,
      description: params.description,
      tags: Object.freeze([...(params.tags ?? [])]),
    })
  },
  parse: (source) => {
    const parsed = matter(source)
    return {
      frontmatter: parsed.data as Record<string, unknown>,
      body: parsed.content,
    }
  },
}

const verbs = createVerbs(fakeSpec)

describe("createVerbs — create", () => {
  it("dryRun returns rendered without touching disk", async () => {
    const r = await verbs.create(
      { id: "echo", description: "Echoes." },
      { dir: "/tmp/unused", dryRun: true },
    )
    expect(r.path).toBe("/tmp/unused/echo/FAKE.md")
    expect(r.rendered).toContain("schema: agentproto/fake/v1")
    expect(r.rendered).toContain("id: echo")
  })

  it("writes to disk when dryRun is false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-verbs-"))
    try {
      const r = await verbs.create(
        { id: "echo", description: "Echoes." },
        { dir },
      )
      expect(readFileSync(r.path, "utf8")).toBe(r.rendered)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("createVerbs — load + round-trip", () => {
  it("create → load returns the same handle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-verbs-"))
    try {
      const original = await verbs.create(
        { id: "echo", description: "Echoes.", tags: ["a", "b"] },
        { dir },
      )
      const loaded = await verbs.load(original.path)
      expect(loaded.handle.id).toBe("echo")
      expect(loaded.handle.tags).toEqual(["a", "b"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("createVerbs — list", () => {
  it("walks a tree and loads every FAKE.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-verbs-"))
    try {
      await verbs.create({ id: "alpha", description: "A" }, { dir })
      await verbs.create({ id: "beta", description: "B" }, { dir })
      await mkdir(join(dir, "node_modules", "fake"), { recursive: true })
      // A FAKE.md inside node_modules — must be skipped by default.
      await writeFile(
        join(dir, "node_modules", "fake", "FAKE.md"),
        '---\nschema: agentproto/fake/v1\nid: ghost\ndescription: Should be skipped.\n---\n',
      )
      const handles = await verbs.list(dir)
      const ids = handles.map((h) => h.id).sort()
      expect(ids).toEqual(["alpha", "beta"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("filter narrows the result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-verbs-"))
    try {
      await verbs.create(
        { id: "alpha", description: "A", tags: ["keep"] },
        { dir },
      )
      await verbs.create(
        { id: "beta", description: "B", tags: ["drop"] },
        { dir },
      )
      const handles = await verbs.list(dir, {
        filter: (h) => Array.isArray((h as FakeHandle).tags) && (h as FakeHandle).tags.includes("keep"),
      })
      expect(handles.map((h) => h.id)).toEqual(["alpha"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("createVerbs — update", () => {
  it("loads, mutates, writes back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-verbs-"))
    try {
      const original = await verbs.create(
        { id: "echo", description: "Old" },
        { dir },
      )
      const updated = await verbs.update(original.path, (params) => ({
        ...params,
        description: "New description",
      }))
      expect(updated.handle.description).toBe("New description")
      const reloaded = await verbs.load(original.path)
      expect(reloaded.handle.description).toBe("New description")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("createVerbs — resolve (inline | ref | file)", () => {
  it("inline returns the handle directly", async () => {
    const handle = await verbs.resolve({
      inline: { id: "echo", description: "x" },
    })
    expect(handle.id).toBe("echo")
  })

  it("file loads from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-verbs-"))
    try {
      const created = await verbs.create(
        { id: "echo", description: "x" },
        { dir },
      )
      const handle = await verbs.resolve({ file: created.path })
      expect(handle.id).toBe("echo")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ref throws without a resolveRef in ctx", async () => {
    await expect(
      verbs.resolve({ ref: "@agentik/runners/python-3.12" }),
    ).rejects.toThrow(/no resolveRef provided/)
  })

  it("ref dispatches via the ctx.resolveRef registry", async () => {
    const handle = await verbs.resolve(
      { ref: "@registry/echo" },
      {
        resolveRef: (ref) =>
          ref === "@registry/echo"
            ? { id: "echo", description: "Resolved by registry." }
            : undefined,
      },
    )
    expect(handle.id).toBe("echo")
  })
})

describe("createVerbs — delete", () => {
  it("removes the manifest file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-verbs-"))
    try {
      const r = await verbs.create(
        { id: "echo", description: "x" },
        { dir },
      )
      await verbs.delete(r.path)
      await expect(verbs.load(r.path)).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// updateManifestSet
// ---------------------------------------------------------------------------

describe("updateManifestSet — success", () => {
  it("writes all files when every op is valid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-manifest-set-"))
    try {
      const ops: ManifestOp[] = [
        () => verbs.create({ id: "alpha", description: "First" },  { dir, dryRun: true }),
        () => verbs.create({ id: "beta",  description: "Second" }, { dir, dryRun: true }),
      ]
      const results = await updateManifestSet(ops)

      expect(results).toHaveLength(2)
      // Both targets must exist and contain the rendered content.
      for (const { path, rendered } of results) {
        expect(existsSync(path)).toBe(true)
        expect(readFileSync(path, "utf8")).toBe(rendered)
      }
      // No stray .tmp files anywhere in dir.
      const allEntries = readdirSync(dir, { recursive: true }) as string[]
      expect(allEntries.every((e) => !String(e).includes(".tmp-"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("update+create mixed ops both land atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-manifest-set-"))
    try {
      // Pre-create alpha so we can update it.
      const existing = await verbs.create({ id: "alpha", description: "Old" }, { dir })
      const ops: ManifestOp[] = [
        () => verbs.update(existing.path, (p) => ({ ...p, description: "New" }), { dryRun: true }),
        () => verbs.create({ id: "beta", description: "Second" }, { dir, dryRun: true }),
      ]
      await updateManifestSet(ops)

      const reloaded = await verbs.load(existing.path)
      expect(reloaded.handle.description).toBe("New")
      expect(existsSync(join(dir, "beta/FAKE.md"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("updateManifestSet — validation failure (phase 1)", () => {
  it("aborts before writing when one op has an invalid id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-manifest-set-"))
    try {
      const ops: ManifestOp[] = [
        // Valid op — should NOT be written because the set fails.
        () => verbs.create({ id: "alpha", description: "Valid" }, { dir, dryRun: true }),
        // Invalid id causes spec.define to throw during the thunk call.
        () => verbs.create({ id: "INVALID!!!", description: "Bad" }, { dir, dryRun: true }),
      ]

      await expect(updateManifestSet(ops)).rejects.toThrow(/invalid id/i)

      // Neither target must exist — phase 1 aborted before any write.
      expect(existsSync(join(dir, "alpha/FAKE.md"))).toBe(false)
      // No .tmp files either.
      const allEntries = readdirSync(dir, { recursive: true }) as string[]
      expect(allEntries.every((e) => !String(e).includes(".tmp-"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("updateManifestSet — write failure (phase 2)", () => {
  it("cleans up staged .tmp files and leaves all targets untouched when staging fails mid-batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-manifest-set-"))
    try {
      // Create a FILE at the path op2 would use as a parent directory.
      // mkdir(dirname(op2Target)) will fail with ENOTDIR/EEXIST.
      const blockerPath = join(dir, "blocker")
      writeFileSync(blockerPath, "I am a file, not a directory")

      const op2TargetPath = join(blockerPath, "FAKE.md")

      const ops: ManifestOp[] = [
        // Op1: valid, will stage its .tmp before op2 fails.
        () => verbs.create({ id: "alpha", description: "Valid" }, { dir, dryRun: true }),
        // Op2: thunk itself succeeds (dryRun), but staging will fail because
        // dirname(op2TargetPath) = blockerPath which is a file, not a dir.
        async () => ({ path: op2TargetPath, rendered: "---\nschema: x\n---\n" }),
      ]

      await expect(updateManifestSet(ops)).rejects.toThrow()

      // Op1's staged .tmp must have been cleaned up.
      const allEntries = readdirSync(dir, { recursive: true }) as string[]
      expect(allEntries.every((e) => !String(e).includes(".tmp-"))).toBe(true)

      // Op1's target must NOT exist — rename never happened.
      expect(existsSync(join(dir, "alpha/FAKE.md"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
