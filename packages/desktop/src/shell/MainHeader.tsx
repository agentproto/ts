// The compact single-row session header above the tab strip: title, status
// pill, adapter/model tags, context %, cost, and the workspace/cwd crumb, plus
// the Export/Interrupt/Stop actions. Driven by the selected SessionDescriptor.

import type { SessionDescriptor } from "../data/types"
import { sessionTitle, statusKind, statusText } from "../data/session-view"

interface MainHeaderProps {
  session: SessionDescriptor
  onInterrupt?: () => void
  onStop?: () => void
}

function contextPct(s: SessionDescriptor): number | null {
  if (typeof s.contextUsed !== "number" || typeof s.contextSize !== "number" || s.contextSize <= 0) {
    return null
  }
  return Math.round((s.contextUsed / s.contextSize) * 100)
}

export function MainHeader({ session, onInterrupt, onStop }: MainHeaderProps) {
  const kind = statusKind(session)
  const pct = contextPct(session)
  const crumb = `${session.workspaceSlug || "default"} / ${session.cwd ?? "—"}`
  const live = session.status !== "exited" && session.status !== "killed"
  return (
    <div className="mhead">
      <div className="info">
        <h2>{sessionTitle(session)}</h2>
        <span className={`status ${kind}`}>
          <span className={`dot ${kind}`} />
          {statusText(session)}
        </span>
        {session.adapterSlug ? <span className="tag adapter">{session.adapterSlug}</span> : null}
        {session.model ? <span className="tag">{session.model}</span> : null}
        {pct !== null ? (
          <span className="metric">
            ctx <b>{pct}%</b>
          </span>
        ) : null}
        {typeof session.costUsd === "number" ? (
          <span className="metric accent">${session.costUsd.toFixed(2)}</span>
        ) : null}
        <span className="crumb">{crumb}</span>
      </div>
      <div className="mactions">
        <button className="btn ghost xs">⧉ Export</button>
        <button className="btn ghost xs" disabled={!live || !onInterrupt} onClick={onInterrupt}>
          ⏸ Interrupt
        </button>
        <button className="btn ghost xs danger" disabled={!live || !onStop} onClick={onStop}>
          ⏹ Stop
        </button>
      </div>
    </div>
  )
}
