// Autonomous Files-tree module — reads a single file's contents via the
// `read_file` Rust command. Errors are surfaced, never thrown. `path === null`
// means no selection: the hook stays idle and issues no invoke.

import { useEffect, useState } from "react"

import { invoke } from "@tauri-apps/api/core"

export interface FileContentDto {
  path: string
  content: string
  truncated: boolean
}

export interface FileContent {
  content: string
  truncated: boolean
  loading: boolean
  error: string | null
}

/** Read `path` via `read_file`. Returns `{ content, truncated, loading,
 *  error }`; a failed invoke lands in `error` and leaves `content` empty.
 *  `path === null` yields an idle, empty state with no invoke call. */
export function useFileContent(path: string | null): FileContent {
  const [content, setContent] = useState<string>("")
  const [truncated, setTruncated] = useState<boolean>(false)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setContent("")
    setTruncated(false)
    setError(null)

    if (path === null) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    const load = async () => {
      try {
        const dto = await invoke<FileContentDto>("read_file", { path })
        if (cancelled) return
        setContent(dto.content)
        setTruncated(dto.truncated)
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
  }, [path])

  return { content, truncated, loading, error }
}
