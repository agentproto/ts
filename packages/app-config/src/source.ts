/**
 * The injectable I/O port for the config kit.
 *
 * The kit does all of its own filesystem I/O; this port is the seam between
 * "where the bytes come from" and "what the kit does with them". The default
 * implementation is the real filesystem (`nodeSource`), so every existing
 * behaviour is unchanged when no source is passed. `memorySource` serves a
 * map of root-relative paths → contents, which lets consumers resolve an app
 * from an ALREADY-PARSED or synthetic collection with no disk at all.
 *
 * All methods are synchronous — that is what the kit's call sites are — and
 * all paths are ABSOLUTE (the kit resolves them against `rootDir` before the
 * source sees them). A memory source is rooted at the same root the caller
 * passes to `load(root, { source })`.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { AppConfigError } from "./merge.js"

/**
 * The kit-owned read/write surface. `probe` distinguishes file / dir /
 * missing without throwing (missing → null), which is what existence-aware
 * consumers (asset checks, render checks) need — "missing" is a first-class
 * finding, not an error.
 */
export interface ConfigSource {
  /** Read a file as UTF-8 text. Throws when the file cannot be read. */
  readFile(path: string): string
  /** List a directory's entry names. Throws when the path is not a directory. */
  listDir(path: string): string[]
  /** Classify a path: `"file"`, `"dir"`, or null when missing. */
  probe(path: string): "file" | "dir" | null
  /** Write a file as UTF-8 text (contracts + schema emit). */
  writeFile(path: string, contents: string): void
  /** Create a directory (and parents) — used before writes. */
  mkdir(path: string): void
}

/** The default source: the real filesystem. */
export function nodeSource(): ConfigSource {
  return {
    readFile(path: string): string {
      return readFileSync(path, "utf8")
    },
    listDir(path: string): string[] {
      return readdirSync(path)
    },
    probe(path: string): "file" | "dir" | null {
      try {
        const st = statSync(path)
        if (st.isFile()) return "file"
        if (st.isDirectory()) return "dir"
        return null
      } catch {
        return null
      }
    },
    writeFile(path: string, contents: string): void {
      writeFileSync(path, contents, "utf8")
    },
    mkdir(path: string): void {
      mkdirSync(path, { recursive: true })
    },
  }
}

/**
 * An in-memory source over a map of root-relative paths → file contents.
 * The map is copied, so writes through the source do not leak into the
 * caller's object. Directories are implicit: any path that is a prefix of a
 * stored file's directory probes as `"dir"`, and `listDir` returns the
 * (sorted) entry names found among the stored keys.
 */
export function memorySource(
  files: Record<string, string>,
  root: string,
): ConfigSource {
  const absRoot = resolve(root)
  const store: Record<string, string> = {}
  for (const [key, contents] of Object.entries(files)) {
    store[normalizeKey(key)] = contents
  }

  function normalizeKey(key: string): string {
    const abs = resolve(absRoot, key)
    const rel = relative(absRoot, abs)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new AppConfigError(`path escapes memory source root: ${key}`)
    }
    return rel
  }

  function dirEntries(relDir: string): string[] {
    const prefix = relDir === "" ? "" : `${relDir}/`
    const names = new Set<string>()
    for (const key of Object.keys(store)) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (rest === "") continue
      names.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest)
    }
    return [...names].sort()
  }

  return {
    readFile(path: string): string {
      const key = normalizeKey(path)
      if (store[key] === undefined) {
        throw new AppConfigError(`config file not found: ${path}`)
      }
      return store[key]
    },
    listDir(path: string): string[] {
      const rel = relative(absRoot, resolve(path))
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new AppConfigError(`path escapes memory source root: ${path}`)
      }
      return dirEntries(rel)
    },
    probe(path: string): "file" | "dir" | null {
      const rel = relative(absRoot, resolve(path))
      if (rel.startsWith("..") || isAbsolute(rel)) return null
      if (rel === "") return "dir"
      if (store[rel] !== undefined) return "file"
      const prefix = `${rel}/`
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) return "dir"
      }
      return null
    },
    writeFile(path: string, contents: string): void {
      store[normalizeKey(path)] = contents
    },
    mkdir(_path: string): void {
      /* directories are implicit in memory */
    },
  }
}

/**
 * The root-escape-guarded read surface exposed on `GateContext` /
 * `ScopeContext` — the same port, with every path resolved against the
 * resolved app's rootDir. A `..` traversal throws `AppConfigError`, exactly
 * as `readArtifact` does. Missing files/dirs are NOT errors here: `readFile`
 * / `listDir` throw, `probe` returns null.
 */
export interface ScopedSource {
  /** Read a file relative to the resolved root. */
  readFile(relPath: string): string
  /** List a directory's entry names, relative to the resolved root. */
  listDir(relPath: string): string[]
  /** Classify a path relative to the resolved root: `"file"`, `"dir"`, or null when missing. */
  probe(relPath: string): "file" | "dir" | null
}

/** Wrap a source with the rootDir escape guard (see `ScopedSource`). */
export function guardSource(source: ConfigSource, rootDir: string): ScopedSource {
  function check(relPath: string): string {
    const abs = resolve(rootDir, relPath)
    const rel = relative(rootDir, abs)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new AppConfigError(`artifact path escapes rootDir: ${relPath}`)
    }
    return abs
  }
  return {
    readFile(relPath: string): string {
      try {
        return source.readFile(check(relPath))
      } catch (err) {
        if (err instanceof AppConfigError) throw err
        throw new AppConfigError(`artifact not found: ${relPath}`)
      }
    },
    listDir(relPath: string): string[] {
      try {
        return source.listDir(check(relPath))
      } catch (err) {
        if (err instanceof AppConfigError) throw err
        throw new AppConfigError(`artifact directory not found: ${relPath}`)
      }
    },
    probe(relPath: string): "file" | "dir" | null {
      return source.probe(check(relPath))
    },
  }
}
