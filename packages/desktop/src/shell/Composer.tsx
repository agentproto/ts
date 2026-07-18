// WP5 — the message composer pinned to the bottom of the center pane. Sends to
// the selected session via the daemon_prompt Rust command (POST
// /sessions/:id/prompt?wait=false). Send is disabled for exited/killed sessions
// and while a send is in flight. Markup + tokens mirror the mock's .composer.

import { useState, type KeyboardEvent } from "react"

import { daemonPrompt } from "../data/daemon"
import type { SessionDescriptor } from "../data/types"

interface ComposerProps {
  session: SessionDescriptor
}

function canSendTo(s: SessionDescriptor): boolean {
  return s.status !== "exited" && s.status !== "killed"
}

export function Composer({ session }: ComposerProps) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const live = canSendTo(session)
  const trimmed = text.trim()
  const canSend = live && !sending && trimmed.length > 0

  const send = async () => {
    if (!canSend) return
    setSending(true)
    setError(null)
    try {
      await daemonPrompt(session.id, trimmed)
      setText("")
    } catch (e) {
      setError(String(e))
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="composer">
      <div className="box">
        <textarea
          placeholder={
            live
              ? "Message this agent, tag @files, or use /commands and /skills"
              : "Session has ended — no input"
          }
          value={text}
          disabled={!live}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <div className="ctl">
          <span className="picker">
            <span className="k">◇</span> {session.model ?? "model"} ▾
          </span>
          <span className="picker">⚡ High ▾</span>
          <span className="picker">🔓 Full access ▾</span>
          <span className="spacer" />
          {error ? <span className="composer-err" title={error}>send failed</span> : null}
          <span className="icn" title="Skills">
            ✦
          </span>
          <span className="icn" title="Voice">
            🎙
          </span>
          {live ? (
            <button
              className="btn send"
              title="Send"
              disabled={!canSend}
              onClick={() => void send()}
            >
              ↑
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
