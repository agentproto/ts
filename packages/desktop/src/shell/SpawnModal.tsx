// Spawn modal — triggered by the titlebar "New agent" button. Lets the user
// pick an adapter (static list per slice 6), an optional cwd/model, and an
// optional first prompt, then spawns via the daemon_spawn Rust command.

import { useState } from "react"

import { daemonSpawn } from "../data/daemon"
import type { SpawnAgentOptions } from "../data/types"

const ADAPTERS = ["claude-code", "claude-sdk", "hermes", "codex"]

interface SpawnModalProps {
  open: boolean
  onClose: () => void
  onSpawned: (sessionId: string) => void
  daemonUrl?: string
}

export function SpawnModal({ open, onClose, onSpawned, daemonUrl }: SpawnModalProps) {
  const [adapter, setAdapter] = useState(ADAPTERS[0] ?? "claude-code")
  const [cwd, setCwd] = useState("")
  const [model, setModel] = useState("")
  const [prompt, setPrompt] = useState("")
  const [submitting, setSubmitting] = useState(false)

  if (!open) return null

  const canSubmit = !submitting && adapter.length > 0

  const submit = async () => {
    if (!canSubmit) return
    const opts: SpawnAgentOptions = { adapter }
    const trimmedCwd = cwd.trim()
    const trimmedModel = model.trim()
    const trimmedPrompt = prompt.trim()
    if (trimmedCwd) opts.cwd = trimmedCwd
    if (trimmedModel) opts.model = trimmedModel
    if (trimmedPrompt) opts.prompt = trimmedPrompt

    setSubmitting(true)
    try {
      const session = await daemonSpawn(opts, daemonUrl)
      onSpawned(session.id)
      setCwd("")
      setModel("")
      setPrompt("")
      setAdapter(ADAPTERS[0] ?? "claude-code")
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("spawn failed:", e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>New agent</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>Adapter</span>
            <select value={adapter} onChange={(e) => setAdapter(e.currentTarget.value)}>
              {ADAPTERS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Working directory</span>
            <input
              type="text"
              placeholder="/path/to/project"
              value={cwd}
              onChange={(e) => setCwd(e.currentTarget.value)}
            />
          </label>
          <label className="field">
            <span>Model</span>
            <input
              type="text"
              placeholder="e.g. claude-sonnet-4-20250514"
              value={model}
              onChange={(e) => setModel(e.currentTarget.value)}
            />
          </label>
          <label className="field">
            <span>First prompt</span>
            <textarea
              rows={4}
              placeholder="Optional starting prompt…"
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
            />
          </label>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="btn" onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? "Spawning…" : "Spawn"}
          </button>
        </div>
      </div>
    </div>
  )
}
