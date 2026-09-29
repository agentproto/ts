import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  normalizeDescriptor,
  parseSessionDescriptor,
  type NormalizeOptions,
  type SessionDescriptor,
} from "./descriptor.js"

/** Saveable store of descriptors, injected so it can be local files or a remote adapter. */
export interface SessionStorePort {
  save(desc: SessionDescriptor): Promise<void>
  load(id: string): Promise<SessionDescriptor | null>
  list(): Promise<SessionDescriptor[]>
  remove(id: string): Promise<void>
}

export interface FileSessionStoreOptions {
  /** Live credential-index reader (a thunk so it reflects the current index). */
  credentials?: () => ReadonlyArray<{ platform: string; account: string }>
}

/** Local-file adapter: one `<id>.json` per descriptor under `dir` (dir 0700, file 0600). */
export function fileSessionStore(dir: string, opts: FileSessionStoreOptions = {}): SessionStorePort {
  const fileFor = (id: string): string => join(dir, `${id.replace(/[^\w.-]/g, "_")}.json`)
  const normalizeOpts = (): NormalizeOptions => (opts.credentials ? { credentials: opts.credentials() } : {})
  const read = (path: string): SessionDescriptor =>
    normalizeDescriptor(parseSessionDescriptor(JSON.parse(readFileSync(path, "utf8")) as unknown), normalizeOpts())
  return {
    async save(desc) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(fileFor(desc.id), JSON.stringify(desc, null, 2), { mode: 0o600 })
    },
    async load(id) {
      try {
        return read(fileFor(id))
      } catch {
        return null
      }
    },
    async list() {
      if (!existsSync(dir)) return []
      const out: SessionDescriptor[] = []
      for (const f of readdirSync(dir).filter(name => name.endsWith(".json"))) {
        try {
          out.push(read(join(dir, f)))
        } catch {
          // an unreadable or foreign json file is not a descriptor; skip it
        }
      }
      return out
    },
    async remove(id) {
      rmSync(fileFor(id), { force: true })
    },
  }
}

/**
 * Resolve a session by name across several stores. `load` returns the first
 * hit; `list` unions by id (earlier stores win). Writes go to `writeStore`, or
 * throw when none is given.
 */
export function compositeSessionStore(readStores: SessionStorePort[], writeStore?: SessionStorePort): SessionStorePort {
  const requireWrite = (): SessionStorePort => {
    if (!writeStore) throw new Error("compositeSessionStore is read-only (no writeStore)")
    return writeStore
  }
  return {
    async save(desc) {
      await requireWrite().save(desc)
    },
    async load(id) {
      for (const s of readStores) {
        const d = await s.load(id)
        if (d) return d
      }
      return null
    },
    async list() {
      const seen = new Map<string, SessionDescriptor>()
      for (const s of readStores) {
        for (const d of await s.list()) if (!seen.has(d.id)) seen.set(d.id, d)
      }
      return [...seen.values()]
    },
    async remove(id) {
      await requireWrite().remove(id)
    },
  }
}
