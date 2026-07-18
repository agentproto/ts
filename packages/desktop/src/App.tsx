import { useCallback, useEffect, useMemo, useState } from "react"

import { DEFAULT_DAEMON_URL, daemonHealth, daemonSessions } from "./data/daemon"
import type { SessionDescriptor } from "./data/types"
import { statusKind } from "./data/session-view"
import { AppShell } from "./shell/AppShell"
import { Composer } from "./shell/Composer"
import { MainHeader } from "./shell/MainHeader"
import { SessionRail, type DiffStat } from "./shell/SessionRail"
import { Titlebar, type ConnState } from "./shell/Titlebar"
import { Transcript } from "./transcript/Transcript"
import { SubagentStrip, WorkingRow } from "./transcript/MainChrome"
import { useSessionEvents } from "./transcript/useSessionEvents"
import { TabStrip } from "./browser/TabStrip"
import { BrowserPane } from "./browser/BrowserPane"
import { browserTabsFor } from "./browser/browser-view"
import { ChangesPanel } from "./changes/ChangesPanel"
import { useGitDiff } from "./changes/useGitDiff"
import "./shell/shell.css"
import "./browser/browser.css"
import "./changes/changes.css"

const POLL_MS = 5000

function App() {
  const [daemonUrl] = useState(DEFAULT_DAEMON_URL)
  const [conn, setConn] = useState<ConnState>("connecting")
  const [sessions, setSessions] = useState<SessionDescriptor[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<string>("transcript")

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

  // Diff of the selected session's working tree, cached by cwd so the rail can
  // show a diff stat on any row sharing that directory.
  const diff = useGitDiff(selected?.cwd)
  const [diffByCwd, setDiffByCwd] = useState<Map<string, DiffStat>>(new Map())
  useEffect(() => {
    const cwd = selected?.cwd
    if (!cwd || !diff) return
    setDiffByCwd((prev) => {
      const next = new Map(prev)
      next.set(cwd, { added: diff.added, removed: diff.removed })
      return next
    })
  }, [selected, diff])
  const diffFor = useCallback(
    (session: SessionDescriptor): DiffStat | undefined =>
      session.cwd ? diffByCwd.get(session.cwd) : undefined,
    [diffByCwd],
  )

  // Reset to the transcript tab when the selected session changes.
  useEffect(() => {
    setActiveTab("transcript")
  }, [selectedId])

  const records = useSessionEvents(selectedId)

  const browserTabs = useMemo(
    () => (selected ? browserTabsFor(selected, sessions) : []),
    [selected, sessions],
  )
  const activeBrowserTab = browserTabs.find((t) => t.id === activeTab) ?? null

  const subagents = useMemo(() => {
    if (!selected) return { total: 0, running: 0 }
    const children = sessions.filter((s) => s.parentSessionId === selected.id)
    return {
      total: children.length,
      running: children.filter((c) => statusKind(c) === "run").length,
    }
  }, [sessions, selected])

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
            <TabStrip tabs={browserTabs} activeTab={activeTab} onSelect={setActiveTab} />
            <div className="pane">
              {activeBrowserTab ? (
                <BrowserPane tab={activeBrowserTab} />
              ) : (
                <Transcript sessionId={selected.id} records={records} />
              )}
            </div>
            <SubagentStrip total={subagents.total} running={subagents.running} />
            <WorkingRow session={selected} />
            <Composer session={selected} />
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
      changes={<ChangesPanel diff={selected ? diff : null} />}
    />
  )
}

export default App
