// Autonomous Files-tree module — lists a single directory via the `list_dir`
// Rust command. `list_dir` returns a flat string[] of the directory's entries;
// by convention a trailing "/" marks a directory (mirrors the git_diff invoke
// pattern in ../data/daemon.ts). Errors are surfaced, never thrown.

import { useEffect, useState } from "react"

import { invoke } from "@tauri-apps/api/core"

export interface FileEntry {
  path: string
  name: string
  isDir: boolean
}

export interface FileTree {
  entries: FileEntry[]
  loading: boolean
  error: string | null
}

/** Split a raw `list_dir` string into a typed entry. A trailing "/" flags a
 *  directory; the name is the last non-empty path segment. */
function parseEntry(raw: string): FileEntry {
  const isDir = raw.endsWith("/")
  const trimmed = isDir ? raw.slice(0, -1) : raw
  const segments = trimmed.split("/").filter((s) => s.length > 0)
  const name = segments.length > 0 ? segments[segments.length - 1] : trimmed
  return { path: trimmed, name, isDir }
}

/** Read the entries of `cwd` via `list_dir`. Returns `{ entries, loading,
 *  error }`; a failed invoke lands in `error` and leaves `entries` empty. */
export function useFileTree(cwd: string): FileTree {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEntries([])
    setError(null)
    setLoading(true)

    const load = async () => {
      try {
        const raw = await invoke<string[]>("list_dir", { cwd })
        if (cancelled) return
        setEntries(raw.map(parseEntry))
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [cwd])

  return { entries, loading, error }
}
