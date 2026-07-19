// CommandPalette — ⌘K overlay. Fuzzy-filters sessions + actions into one
// list, ↑↓ to move, Enter to run, Esc (or backdrop click) to close.
// Standalone: App owns `open` state and supplies the session/action lists.

import { useEffect, useMemo, useRef, useState } from "react"

import type { SessionDescriptor } from "../data/types"
import { sessionTitle } from "../data/session-view"
import "./palette.css"

export interface PaletteAction {
  id: string
  label: string
  run: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  sessions: readonly SessionDescriptor[]
  onSelectSession: (id: string) => void
  actions: readonly PaletteAction[]
}

interface PaletteEntry {
  key: string
  label: string
  sublabel?: string
  onRun: () => void
}

function fuzzyScore(query: string, target: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const idx = t.indexOf(q)
  if (idx === -1) return -1
  return idx
}

export function CommandPalette({
  open,
  onClose,
  sessions,
  onSelectSession,
  actions,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery("")
      setActiveIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const entries = useMemo<PaletteEntry[]>(() => {
    const sessionEntries: PaletteEntry[] = sessions.map((s) => ({
      key: `session:${s.id}`,
      label: sessionTitle(s),
      sublabel: s.adapterSlug ?? s.kind,
      onRun: () => onSelectSession(s.id),
    }))
    const actionEntries: PaletteEntry[] = actions.map((a) => ({
      key: `action:${a.id}`,
      label: a.label,
      sublabel: "action",
      onRun: a.run,
    }))
    const all = [...actionEntries, ...sessionEntries]
    if (!query) return all
    return all
      .map((entry) => ({ entry, score: fuzzyScore(query, entry.label) }))
      .filter((x) => x.score !== -1)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.entry)
  }, [sessions, actions, query, onSelectSession])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  if (!open) return null

  function runEntry(entry: PaletteEntry): void {
    entry.onRun()
    onClose()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, entries.length - 1))
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      const entry = entries[activeIndex]
      if (entry) runEntry(entry)
    }
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command or search sessions…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list">
          {entries.length === 0 ? (
            <div className="palette-empty">No matches.</div>
          ) : (
            entries.map((entry, i) => (
              <div
                key={entry.key}
                className={`palette-row${i === activeIndex ? " active" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => runEntry(entry)}
              >
                <span className="palette-label">{entry.label}</span>
                {entry.sublabel ? <span className="palette-sub">{entry.sublabel}</span> : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
