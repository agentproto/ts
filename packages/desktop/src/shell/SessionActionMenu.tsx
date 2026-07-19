// Reusable kebab menu for session-level actions: switch model, export transcript,
// delete session. Takes a session + callbacks so it can be dropped into a header
// row, a rail item, or any other surface without change.

import { useCallback, useEffect, useRef, useState } from "react"

import {
  daemonDeleteSession,
  daemonExportSession,
  daemonSetModel,
  DEFAULT_DAEMON_URL,
} from "../data/daemon"
import type { ExportResult, SessionDescriptor, SetModelResult } from "../data/types"

const MODELS = [
  "claude-sonnet-5",
  "claude-opus-4-8",
  "kimi-k2.7-code",
  "deepseek/deepseek-v4-pro",
]

interface SessionActionMenuProps {
  session: SessionDescriptor
  daemonUrl?: string
  onDeleted?: (sessionId: string) => void
  onModelSwitched?: (result: SetModelResult) => void
  onExported?: (result: ExportResult) => void
}

type MenuView = "menu" | "model" | "delete"

export function SessionActionMenu({
  session,
  daemonUrl = DEFAULT_DAEMON_URL,
  onDeleted,
  onModelSwitched,
  onExported,
}: SessionActionMenuProps) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<MenuView>("menu")
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const showStatus = useCallback((message: string) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    setStatus(message)
    timeoutRef.current = setTimeout(() => setStatus(null), 2500)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setView("menu")
  }, [])

  const handleSetModel = useCallback(
    async (model: string) => {
      if (!model) return
      setBusy(true)
      try {
        const result = await daemonSetModel(session.id, model, daemonUrl)
        onModelSwitched?.(result)
        if (result.applied) {
          showStatus(`Switched to ${result.model ?? model}`)
        } else {
          showStatus(result.reason ?? "Model switch rejected")
        }
      } catch (e) {
        showStatus(String(e))
      } finally {
        setBusy(false)
        close()
      }
    },
    [session.id, daemonUrl, onModelSwitched, showStatus, close],
  )

  const handleExport = useCallback(async () => {
    setBusy(true)
    try {
      const result = await daemonExportSession(session.id, "markdown", daemonUrl)
      onExported?.(result)
      await navigator.clipboard.writeText(result.content)
      showStatus(`Copied ${result.format} export to clipboard`)
    } catch (e) {
      showStatus(String(e))
    } finally {
      setBusy(false)
      close()
    }
  }, [session.id, daemonUrl, onExported, showStatus, close])

  const handleDelete = useCallback(async () => {
    setBusy(true)
    try {
      const result = await daemonDeleteSession(session.id, daemonUrl)
      if (result.ok) {
        onDeleted?.(result.id)
        showStatus("Session deleted")
      } else {
        showStatus("Delete failed")
      }
    } catch (e) {
      showStatus(String(e))
    } finally {
      setBusy(false)
      close()
    }
  }, [session.id, daemonUrl, onDeleted, showStatus, close])

  return (
    <div className="action-menu">
      <button
        className="btn ghost xs action-menu__toggle"
        disabled={busy}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div className="action-menu__dropdown" role="menu">
          {status && <div className="action-menu__status">{status}</div>}
          {view === "menu" && (
            <>
              <button
                className="action-menu__item"
                role="menuitem"
                onClick={() => setView("model")}
              >
                Switch model
              </button>
              <button
                className="action-menu__item"
                role="menuitem"
                onClick={() => void handleExport()}
              >
                Export transcript
              </button>
              <button
                className="action-menu__item danger"
                role="menuitem"
                onClick={() => setView("delete")}
              >
                Delete session
              </button>
            </>
          )}
          {view === "model" && (
            <div className="action-menu__panel">
              <label htmlFor="action-model-picker">Model</label>
              <select
                id="action-model-picker"
                disabled={busy}
                defaultValue=""
                onChange={(e) => void handleSetModel(e.target.value)}
              >
                <option value="" disabled>
                  {session.model ?? "Select model…"}
                </option>
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button
                className="btn ghost xs"
                onClick={() => setView("menu")}
              >
                Cancel
              </button>
            </div>
          )}
          {view === "delete" && (
            <div className="action-menu__panel">
              <span className="action-menu__warning">
                Delete <b>{session.id}</b>?
              </span>
              <div className="action-menu__row">
                <button
                  className="btn ghost xs danger"
                  disabled={busy}
                  onClick={() => void handleDelete()}
                >
                  Delete
                </button>
                <button
                  className="btn ghost xs"
                  onClick={() => setView("menu")}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
