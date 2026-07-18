import { useCallback, useEffect, useState } from "react"

import "./App.css"
import {
  DEFAULT_DAEMON_URL,
  daemonHealth,
  daemonSessions,
  type DaemonHealth,
  type SessionDescriptor,
} from "./daemon"

const POLL_MS = 5000

type Conn = "connecting" | "online" | "offline"

function statusDot(s: SessionDescriptor): string {
  if (s.awaitingPermission) return "🟠"
  if (s.awaitingInput) return "🟡"
  if (s.busy) return "🟢"
  if (s.status === "running") return "🟢"
  if (s.status === "exited" || s.status === "killed") return "⚪️"
  return "⚫️"
}

function App() {
  const [daemonUrl, setDaemonUrl] = useState(DEFAULT_DAEMON_URL)
  const [conn, setConn] = useState<Conn>("connecting")
  const [health, setHealth] = useState<DaemonHealth | null>(null)
  const [sessions, setSessions] = useState<SessionDescriptor[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const h = await daemonHealth(daemonUrl)
      setHealth(h)
      setConn("online")
      setError(null)
      try {
        const rows = await daemonSessions(daemonUrl)
        setSessions(rows)
      } catch (e) {
        // Health is up but sessions failed (likely auth) — keep the list, show why.
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

  const live = sessions.filter((s) => s.status === "running").length

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <span className="glyph">◇</span> agentproto
        </div>
        <div className={`conn conn--${conn}`}>
          {conn === "online" ? "connected" : conn === "offline" ? "offline" : "connecting…"}
          {health?.version ? <span className="ver">v{health.version}</span> : null}
        </div>
      </header>

      <div className="controls">
        <input
          className="url"
          value={daemonUrl}
          spellCheck={false}
          onChange={(e) => setDaemonUrl(e.currentTarget.value)}
          placeholder={DEFAULT_DAEMON_URL}
        />
        <button onClick={() => void refresh()}>Refresh</button>
        <span className="count">
          {sessions.length} session{sessions.length === 1 ? "" : "s"} · {live} live
        </span>
      </div>

      {error && conn === "offline" ? (
        <div className="empty">
          <p>Can’t reach the daemon at <code>{daemonUrl}</code>.</p>
          <p className="hint">Start it with <code>agentproto daemon</code>, then Refresh.</p>
          <p className="err">{error}</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="empty">
          <p>No sessions yet.</p>
          <p className="hint">Spawn one with <code>agentproto run</code> and it’ll appear here.</p>
          {error ? <p className="err">{error}</p> : null}
        </div>
      ) : (
        <ul className="sessions">
          {sessions.map((s) => (
            <li key={s.id} className="session">
              <span className="dot">{statusDot(s)}</span>
              <div className="meta">
                <div className="title">{s.title || s.label || s.command || s.id}</div>
                <div className="sub">
                  <span className="tag">{s.kind}</span>
                  {s.adapterSlug ? <span className="tag">{s.adapterSlug}</span> : null}
                  {s.model ? <span className="tag">{s.model}</span> : null}
                  {s.workspaceSlug ? <span className="ws">{s.workspaceSlug}</span> : null}
                </div>
              </div>
              <div className="right">
                <span className="state">{s.status}</span>
                {typeof s.costUsd === "number" ? (
                  <span className="cost">${s.costUsd.toFixed(3)}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

export default App
