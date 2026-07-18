// Fetch (and periodically refresh) the working-tree diff of a session's cwd via
// the git_diff Rust command. Returns null until the first result lands.

import { useEffect, useState } from "react"

import { gitDiff } from "../data/daemon"
import type { GitDiff } from "../data/types"

const POLL_MS = 5000

export function useGitDiff(cwd: string | undefined): GitDiff | null {
  const [diff, setDiff] = useState<GitDiff | null>(null)

  useEffect(() => {
    setDiff(null)
    if (!cwd) return

    let cancelled = false
    const load = async () => {
      try {
        const next = await gitDiff(cwd)
        if (!cancelled) setDiff(next)
      } catch {
        // Non-repo cwd / git error — the Rust side already degrades to empty,
        // so a throw here is transport-level; leave the last value in place.
      }
    }

    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [cwd])

  return diff
}
