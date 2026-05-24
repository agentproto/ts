/**
 * In-memory FsPort backed by a Map<path, content>. Used by unit tests
 * so the kit can be exercised without touching real disk. Mirrors the
 * shape of any real FsPort implementation (Mastra cloud, local node).
 */

import type {
  FsPort,
  FsLockHandle,
  FsStat,
} from "../../ports/fs.port.js"

export class MemoryFs implements FsPort {
  private readonly files = new Map<string, string>()
  private readonly locks = new Set<string>()

  constructor(initial?: Readonly<Record<string, string>>) {
    if (initial) {
      for (const [path, content] of Object.entries(initial)) {
        this.files.set(path, content)
      }
    }
  }

  async exists(path: string): Promise<boolean> {
    if (this.files.has(path)) return true
    // Directory exists if any file lives under it.
    const prefix = path.endsWith("/") ? path : path + "/"
    for (const p of this.files.keys()) {
      if (p === path || p.startsWith(prefix)) return true
    }
    return false
  }

  async readFile(path: string): Promise<string> {
    const c = this.files.get(path)
    if (c === undefined) throw new Error(`MemoryFs: ENOENT ${path}`)
    return c
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }

  async appendFile(path: string, content: string): Promise<void> {
    const prev = this.files.get(path) ?? ""
    this.files.set(path, prev + content)
  }

  async readdir(path: string): Promise<readonly string[]> {
    const prefix = path === "" ? "" : path.endsWith("/") ? path : path + "/"
    const direct = new Set<string>()
    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const i = rest.indexOf("/")
      direct.add(i === -1 ? rest : rest.slice(0, i))
    }
    return [...direct]
  }

  async walk(path: string): Promise<readonly string[]> {
    const prefix = path === "" ? "" : path.endsWith("/") ? path : path + "/"
    const out: string[] = []
    for (const p of this.files.keys()) {
      if (path === "" || p.startsWith(prefix)) {
        // Skip hidden directories (any segment starts with ".")
        if (p.split("/").some((seg) => seg.startsWith("."))) continue
        out.push(p)
      }
    }
    return out
  }

  async stat(path: string): Promise<FsStat | null> {
    const f = this.files.get(path)
    if (f !== undefined) {
      return { kind: "file", bytes: f.length }
    }
    if (await this.exists(path)) {
      return { kind: "directory" }
    }
    return null
  }

  async lock(path: string): Promise<FsLockHandle> {
    while (this.locks.has(path)) {
      await new Promise((r) => setTimeout(r, 1))
    }
    this.locks.add(path)
    return {
      release: async () => {
        this.locks.delete(path)
      },
    }
  }

  // Test affordance — expose the raw map for assertions
  snapshot(): ReadonlyMap<string, string> {
    return new Map(this.files)
  }
}

/** Load the marketing fixture workspace from real disk into a MemoryFs. */
export async function loadMarketingFixtureFs(): Promise<MemoryFs> {
  const { readFileSync } = await import("node:fs")
  const path = await import("node:path")
  const { fileURLToPath } = await import("node:url")
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const fixturesRoot = path.resolve(
    __dirname,
    "../../../test/fixtures/marketing"
  )

  // Walk the fixture tree on disk and load into the memory fs at root "".
  const { readdirSync, statSync } = await import("node:fs")
  const fs = new MemoryFs()
  function walk(dir: string) {
    for (const ent of readdirSync(dir)) {
      const full = path.join(dir, ent)
      const s = statSync(full)
      if (s.isDirectory()) walk(full)
      else if (ent.endsWith(".md")) {
        const rel = path.relative(fixturesRoot, full)
        fs.writeFile(rel.split(path.sep).join("/"), readFileSync(full, "utf8"))
      }
    }
  }
  walk(fixturesRoot)
  return fs
}
