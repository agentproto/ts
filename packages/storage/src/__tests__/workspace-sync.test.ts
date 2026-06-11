import { describe, it, expect } from "vitest"
import {
  hasWorkspaceSync,
  type SyncTree,
  type WorkspaceSync,
} from "../workspace-sync.js"

/** Minimal in-memory tree satisfying SyncTree (the shape FsPort meets). */
class MemTree implements SyncTree {
  readonly files = new Map<string, string>()
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  async readFile(path: string): Promise<string> {
    const v = this.files.get(path)
    if (v === undefined) throw new Error(`not found: ${path}`)
    return v
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }
  async walk(prefix: string): Promise<readonly string[]> {
    const base = prefix ? (prefix.endsWith("/") ? prefix : prefix + "/") : ""
    return [...this.files.keys()].filter(p => !base || p.startsWith(base))
  }
}

describe("hasWorkspaceSync (AIP-37 feature-detect)", () => {
  it("accepts an object exposing pull + push", () => {
    const sync: WorkspaceSync = {
      pull: async () => ({ seeded: true, files: 0, bytes: 0, message: "" }),
      push: async () => ({ kind: "no_changes", message: "" }),
    }
    expect(hasWorkspaceSync(sync)).toBe(true)
  })

  it("rejects a plain filesystem missing pull/push", () => {
    expect(hasWorkspaceSync({ readFile: async () => "" })).toBe(false)
    expect(hasWorkspaceSync({ pull: async () => null })).toBe(false)
    expect(hasWorkspaceSync(null)).toBe(false)
    expect(hasWorkspaceSync(undefined)).toBe(false)
    expect(hasWorkspaceSync("github")).toBe(false)
  })

  it("narrows the type so pull/push are callable", async () => {
    const fs: unknown = {
      pull: async () => ({ seeded: true, files: 1, bytes: 4, message: "ok" }),
      push: async () => ({
        kind: "pushed" as const,
        ref: "main",
        files: 1,
        message: "ok",
      }),
    }
    if (!hasWorkspaceSync(fs)) throw new Error("expected sync-capable fs")
    const tree = new MemTree()
    const pulled = await fs.pull(tree)
    expect(pulled.seeded).toBe(true)
    const pushed = await fs.push(tree)
    expect(pushed.kind).toBe("pushed")
  })
})

describe("SyncTree shape", () => {
  it("round-trips writes through a MemTree", async () => {
    const tree = new MemTree()
    expect(await tree.exists("a.md")).toBe(false)
    await tree.writeFile("a.md", "hello")
    await tree.writeFile("sub/b.md", "world")
    expect(await tree.readFile("a.md")).toBe("hello")
    expect(await tree.walk("")).toEqual(["a.md", "sub/b.md"])
    expect(await tree.walk("sub")).toEqual(["sub/b.md"])
  })
})
