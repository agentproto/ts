import { useCallback, useEffect, useMemo, useState } from "react"

import { DEFAULT_DAEMON_URL, daemonHealth, daemonSessions } from "./data/daemon"
import type { SessionDescriptor } from "./data/types"
import { AppShell } from "./shell/AppShell"
import { MainHeader } from "./shell/MainHeader"
import { SessionRail, type DiffStat } from "./shell/SessionRail"
import { Titlebar, type ConnState } from "./shell/Titlebar"
import "./shell/shell.css"

const POLL_MS = 5000

function App() {
  const [daemonUrl] = useState(DEFAULT_DAEMON_URL)
  const [conn, setConn] = useState<ConnState>("connecting")
  const [sessions, setSessions] = useState<SessionDescriptor[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      await daemonHealth(daemonUrl)
      setConn("online")
      setError(null)
      try {
        const rows = await daemonSessions(daemonUrl)
        setSessions(rows)
      } catch (e) {
        setError(String(e))
      }
    } catch (e) {
      setConn("offline")
      setError(String(e))
    }
  }, [daemonUrl])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  // Keep a valid selection: default to the first session, drop a stale one.
  useEffect(() => {
    if (sessions.length === 0) {
      setSelectedId(null)
      return
    }
    setSelectedId((prev) =>
      prev && sessions.some((s) => s.id === prev) ? prev : sessions[0].id,
    )
  }, [sessions])

  const selected = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  )

  const costToday = useMemo(() => {
    const total = sessions.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
    return `$${total.toFixed(2)}`
  }, [sessions])

  // WP4 will populate real diff stats; until then the rail simply omits them.
  const diffFor = useCallback((_session: SessionDescriptor): DiffStat | undefined => undefined, [])

  return (
    <AppShell
      titlebar={
        <Titlebar
          daemonUrl={daemonUrl}
          conn={conn}
          costToday={costToday}
          onNewAgent={() => void 0}
        />
      }
      rail={
        <SessionRail
          sessions={sessions}
          selectedId={selectedId}
          onSelect={setSelectedId}
          diffFor={diffFor}
        />
      }
      main={
        selected ? (
          <>
            <MainHeader session={selected} />
            <div className="pane-placeholder">Transcript pane (WP2)</div>
          </>
        ) : (
          <div className="pane-placeholder">
            {conn === "offline"
              ? `Can’t reach the daemon at ${daemonUrl}. Start it with agentproto daemon.`
              : "Select a session."}
            {error && conn === "offline" ? <div className="pane-err">{error}</div> : null}
          </div>
        )
      }
      changes={<div className="pane-placeholder">Changes pane (WP4)</div>}
    />
  )
}

export default App
