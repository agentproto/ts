// SessionRail — the left pane. Live sessions grouped by workspace, each row a
// status dot + title + adapter/model tags + (when known) a diff stat, with
// orchestrator children nested by parentSessionId. Filter box narrows by title.

import { useMemo, useState, type Ref } from "react"

import type { SessionDescriptor } from "../data/types"
import {
  groupSessions,
  sessionTitle,
  statusKind,
  statusText,
  type SessionNode,
  type WorkspaceGroup,
} from "../data/session-view"

/** A resolved diff stat for a session (added/removed lines), when available. */
export interface DiffStat {
  added: number
  removed: number
}

interface SessionRailProps {
  sessions: readonly SessionDescriptor[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** Optional per-session diff stat (from the changes panel's git fetch). */
  diffFor: (session: SessionDescriptor) => DiffStat | undefined
  /** Optional ref onto the filter input, so ⌘F can focus it from the shell. */
  filterRef?: Ref<HTMLInputElement>
}

function matches(s: SessionDescriptor, q: string): boolean {
  if (!q) return true
  const hay = `${sessionTitle(s)} ${s.adapterSlug ?? ""} ${s.model ?? ""}`.toLowerCase()
  return hay.includes(q.toLowerCase())
}

function Row({
  session,
  child,
  selectedId,
  onSelect,
  diffFor,
}: {
  session: SessionDescriptor
  child: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  diffFor: (s: SessionDescriptor) => DiffStat | undefined
}) {
  const stat = diffFor(session)
  const active = session.id === selectedId
  return (
    <div
      className={`srow${child ? " child" : ""}${active ? " active" : ""}`}
      onClick={() => onSelect(session.id)}
    >
      <span className={`dot ${statusKind(session)}`} title={statusText(session)} />
      <div>
        <div className="stitle">{sessionTitle(session)}</div>
        <div className="smeta">
          {statusKind(session) === "input" && session.awaitingQuestion?.text ? (
            <span className="tag question" title={session.awaitingQuestion.text}>
              {session.awaitingQuestion.text}
            </span>
          ) : null}
          {session.adapterSlug ? <span className="tag adapter">{session.adapterSlug}</span> : null}
          {session.model ? <span className="tag">{session.model}</span> : null}
          {stat && (stat.added || stat.removed) ? (
            <span className="diffstat">
              <span className="add">+{stat.added}</span> <span className="del">-{stat.removed}</span>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Group({
  group,
  filter,
  selectedId,
  onSelect,
  diffFor,
}: {
  group: WorkspaceGroup
  filter: string
  selectedId: string | null
  onSelect: (id: string) => void
  diffFor: (s: SessionDescriptor) => DiffStat | undefined
}) {
  // Keep a node when it — or any of its children — matches the filter.
  const nodes = group.nodes.filter(
    (n: SessionNode) => matches(n.session, filter) || n.children.some((c) => matches(c, filter)),
  )
  if (nodes.length === 0) return null
  return (
    <div className="ws">
      <div className="ws-head">
        <span className="wg">{group.slug.slice(0, 2).toUpperCase()}</span>
        <span className="wn">{group.label}</span>
        {group.live ? <span className="wlive" /> : null}
        <span className="wc">{group.count}</span>
      </div>
      {nodes.map((node) => (
        <div key={node.session.id}>
          <Row
            session={node.session}
            child={false}
            selectedId={selectedId}
            onSelect={onSelect}
            diffFor={diffFor}
          />
          {node.children.map((c) => (
            <Row
              key={c.id}
              session={c}
              child
              selectedId={selectedId}
              onSelect={onSelect}
              diffFor={diffFor}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

export function SessionRail({ sessions, selectedId, onSelect, diffFor, filterRef }: SessionRailProps) {
  const [filter, setFilter] = useState("")
  const groups = useMemo(() => groupSessions(sessions), [sessions])

  return (
    <aside className="rail">
      <div className="search">
        <input
          ref={filterRef}
          placeholder="Filter sessions…  ⌘F"
          value={filter}
          spellCheck={false}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />
      </div>
      <div className="rail-scroll">
        {sessions.length === 0 ? (
          <div className="rail-empty">
            No sessions yet. Spawn one with <code>agentproto run</code>.
          </div>
        ) : (
          groups.map((group) => (
            <Group
              key={group.slug}
              group={group}
              filter={filter}
              selectedId={selectedId}
              onSelect={onSelect}
              diffFor={diffFor}
            />
          ))
        )}
      </div>
    </aside>
  )
}
