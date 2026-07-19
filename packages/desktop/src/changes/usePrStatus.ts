// PR tab data — fetches the open PR (if any) for a session's cwd via the
// pr_status Rust command. Returns null pr for "no PR", not an error state.

import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"

export interface PrStatusDto {
  number: number
  title: string
  state: string
  url: string
  checks: { passed: number; failed: number; pending: number }
}

interface UsePrStatusResult {
  pr: PrStatusDto | null
  loading: boolean
  error: string | null
}

export function usePrStatus(cwd: string | null): UsePrStatusResult {
  const [pr, setPr] = useState<PrStatusDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setPr(null)
    setError(null)

    if (!cwd) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    const load = async () => {
      try {
        const next = await invoke<PrStatusDto | null>("pr_status", { cwd })
        if (cancelled) return
        setPr(next)
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [cwd])

  return { pr, loading, error }
}
