// Poll a session's durable event stream and accumulate the records. The reducer
// is a full replay over the accumulated list, so appending the tail each poll
// (cursor via nextSeq) yields a stable, idempotent conversation.

import { useEffect, useRef, useState } from "react"

import { daemonSessionEvents } from "../data/daemon"
import type { SessionEventRecord } from "../data/types"

const POLL_MS = 2000

export function useSessionEvents(sessionId: string | null): SessionEventRecord[] {
  const [records, setRecords] = useState<SessionEventRecord[]>([])
  const cursorRef = useRef(0)

  useEffect(() => {
    cursorRef.current = 0
    setRecords([])
    if (!sessionId) return

    let cancelled = false
    const poll = async () => {
      try {
        const page = await daemonSessionEvents(sessionId, cursorRef.current)
        if (cancelled || page.events.length === 0) {
          if (!cancelled) cursorRef.current = page.nextSeq
          return
        }
        cursorRef.current = page.nextSeq
        setRecords((prev) => [...prev, ...page.events])
      } catch {
        // Transient daemon/transport error — the next tick retries.
      }
    }

    void poll()
    const t = setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [sessionId])

  return records
}
